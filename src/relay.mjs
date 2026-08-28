// In-process relay service for the qq-relay Cordis plugin.
//
// Locked contract (operator, T-66):
// - The mailbox is in this process. No daemon, socket, presence files, install
//   root, or second database in the v1 land.
// - Live sessions only: a session that is just a file on disk is not a
//   recipient. Anyone loaded may send.
// - Delivery means the message is routed into the recipient's live DSH inbox;
//   DSH session persistence owns the durable log entry.
// - default = steer (next tool/step boundary, wakes idle). urgent = halt then
//   a fresh turn. inject is not a send mode.
// - The sender receipt is the tool result, never a transcript card.
// - Inbound mail carries DSH's plugin source mark (kind plugin, form relay)
//   plus an agent-mail wrapper so it never reads as the operator typing.

import { randomUUID } from "node:crypto";

import { createLabelBoard } from "./labels.mjs";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 65_536;
const DELIVERIES = new Set(["default", "urgent"]);
const LEDGER_CAP = 256;

export class RelayError extends Error {}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

// Kept local so relay does not depend on qq-core's agent catalog.
function formatIdleFor(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function lastSessionEventTime(session) {
  let latest;
  for (const event of Array.isArray(session?.events) ? session.events : []) {
    const time = event?.time;
    const value = typeof time === "number" ? time : Date.parse(time ?? "");
    if (Number.isFinite(value) && (latest === undefined || value > latest)) latest = value;
  }
  return latest;
}

function idleFor(agent, now) {
  if (agent?.status !== "idle") return "";
  const createdAt = agent?.session?.header?.createdAt;
  const since = lastSessionEventTime(agent?.session)
    ?? (Number.isFinite(createdAt) ? createdAt : undefined);
  if (!Number.isFinite(since)) return "";
  return formatIdleFor(Math.max(0, now - since));
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function agentMailText({ fromId, fromAlias, text, delivery }) {
  const hasAlias = fromAlias !== undefined
    && fromAlias !== null
    && String(fromAlias).length > 0;
  const aliasAttribute = hasAlias ? ` alias="${escapeAttribute(fromAlias)}"` : "";
  const payload = text.replaceAll("</mail-body>", "&lt;/mail-body>");
  return `<agent-mail from="${fromId}"${aliasAttribute} delivery="${delivery}">
Inbound mail from another agent, not the operator.

<mail-body>
${payload}
</mail-body>
</agent-mail>`;
}

/** One DSH user-role message marked as plugin-originated agent mail. */
export function relayEnvelope({
  fromId,
  fromAlias,
  text,
  delivery = "default",
  messageId = randomUUID(),
}) {
  if (!MESSAGE_ID.test(messageId)) throw new RelayError("messageId must be a UUID");
  return freezeDeep({
    id: messageId,
    role: "user",
    content: [{
      type: "text",
      text: agentMailText({ fromId, fromAlias, text, delivery }),
    }],
    source: {
      kind: "plugin",
      plugin: "qq-relay",
      form: "relay",
      senderSessionId: fromId,
    },
  });
}

/**
 * One in-process mailbox plus the relay directory. The message daemon named by
 * the ticket is intentionally absent from v1: there is no second process.
 * Everything the plugin needs runs inside the DSH host.
 */
export function createRelayService(ctx, config = {}) {
  const agents = ctx.get("agents");
  if (!agents || typeof agents.list !== "function" || typeof agents.get !== "function") {
    throw new Error("qq-relay: DSH agents service is unavailable");
  }
  const sessions = ctx.get("sessions", false);

  const labels = createLabelBoard({
    isLive: (sessionId) => agents.get(sessionId) !== undefined,
  });
  const ledger = [];

  // Lazy so plugin ordering cannot starve the book: relay consumes qq's
  // aliases, it does not own them.
  function aliases() {
    return ctx.get("qq", false) ?? ctx.get("qq-aliases", false);
  }

  function aliasFor(sessionId) {
    const provider = aliases();
    if (!provider) return undefined;
    if (typeof provider.alias === "function") return provider.alias(sessionId);
    if (typeof provider.aliasFor === "function") return provider.aliasFor(sessionId);
    return undefined;
  }

  function resolveAddress(address) {
    const provider = aliases();
    if (typeof provider?.resolve === "function") {
      const resolved = provider.resolve(address);
      if (resolved) return resolved;
    }
    return liveAgents().find((agent) =>
      agent.session.id === address || aliasFor(agent.session.id) === address)?.session.id;
  }

  function pruneLabels() {
    labels.pruneLive();
  }

  function liveAgents() {
    return agents.list().filter((agent) => SESSION_ID.test(agent?.session?.id));
  }

  async function flushAck(recipient) {
    if (typeof sessions?.flush !== "function") return;
    try {
      await sessions.flush(recipient.session);
    } catch {
      // DSH owns the durable log; inbox routing is relay's delivery boundary.
    }
  }

  function alreadyInserted(recipient, messageId) {
    const pending = [
      ...(recipient.inbox?.nextTurn ?? []),
      ...(recipient.inbox?.nextStep ?? []),
    ];
    if (pending.some((message) => message?.id === messageId)) return true;
    return (recipient.session?.events ?? []).some((event) =>
      event?.type === "user/message"
      && (event.data?.id === messageId || event.data?.message?.id === messageId));
  }

  /** Route one validated envelope into a live recipient's inbox. */
  async function deliver(recipient, envelope, delivery) {
    if (alreadyInserted(recipient, envelope.id)) return false;
    if (delivery === "urgent") {
      if (recipient.status !== "idle") {
        recipient.cancel({ kind: "hook", reason: "qq-relay urgent message" });
      }
      recipient.followup(envelope);
    } else {
      recipient.steer(envelope);
    }
    await flushAck(recipient);
    return true;
  }

  async function send({ fromId, to, message, delivery = "default", messageId }) {
    if (!SESSION_ID.test(fromId)) {
      throw new RelayError("send requires a live session-<UUID> sender");
    }
    if (!DELIVERIES.has(delivery)) {
      throw new RelayError("delivery must be default or urgent");
    }
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new RelayError("message must be non-empty");
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new RelayError(`message exceeds ${MAX_MESSAGE_LENGTH} characters`);
    }
    if (messageId !== undefined && !MESSAGE_ID.test(messageId)) {
      throw new RelayError("messageId must be a UUID");
    }
    pruneLabels();
    const sender = agents.get(fromId);
    if (!sender) throw new RelayError("send requires a live session-<UUID> sender");

    const recipientId = resolveAddress(to);
    const recipient = recipientId ? agents.get(recipientId) : undefined;
    if (!recipient || !SESSION_ID.test(recipient.session?.id)) {
      throw new RelayError(`no live session matches ${JSON.stringify(to)}`);
    }
    if (aliasFor(recipient.session.id) === "projects") {
      throw new RelayError("projects session is operator-controlled and does not receive relay messages");
    }
    if (recipient.session.id === fromId) {
      throw new RelayError("send cannot address the sender's own session");
    }

    const fromAlias = aliasFor(fromId);
    const envelope = relayEnvelope({
      fromId,
      fromAlias,
      text: message,
      delivery,
      messageId,
    });
    const recorded = ledger.find((entry) => entry.message_id === envelope.id);
    if (recorded && (recorded.to !== recipient.session.id || recorded.from !== fromId || recorded.content !== message)) {
      throw new RelayError("messageId was already used for a different relay envelope");
    }

    await deliver(recipient, envelope, delivery);

    const toAlias = aliasFor(recipient.session.id) ?? "";
    if (!recorded) {
      ledger.push({
        message_id: envelope.id,
        to: recipient.session.id,
        to_alias: toAlias,
        delivery,
        from: fromId,
        content: message,
        at: config.now?.() ?? Date.now(),
      });
      if (ledger.length > LEDGER_CAP) ledger.splice(0, ledger.length - LEDGER_CAP);
    }

    // DSH snapshots tool results; undefined fields are not lossless JSON.
    return {
      status: "sent",
      message_id: envelope.id,
      to: recipient.session.id,
      to_alias: toAlias,
      delivery,
    };
  }

  function status(messageId) {
    if (typeof messageId !== "string" || messageId.length === 0 || messageId.length > 128) {
      throw new RelayError("message_id is malformed");
    }
    const record = ledger.find((entry) => entry.message_id === messageId);
    if (!record) throw new RelayError("message_id not found");
    return {
      status: "sent",
      message_id: record.message_id,
      to: record.to,
      to_alias: record.to_alias ?? "",
      delivery: record.delivery,
    };
  }

  /** Live directory rows: identity, occupancy, workspace, and labels bag. */
  function list({ filter, fromId } = {}) {
    pruneLabels();
    const now = config.now?.() ?? Date.now();
    const rows = liveAgents()
      .filter((agent) => {
        if (aliasFor(agent.session.id) === "projects") return false;
        const bag = labels.labelsFor(agent.session.id);
        return labels.matches(bag, filter);
      })
      .map((agent) => ({
        alias: aliasFor(agent.session.id) ?? "",
        session: agent.session.id,
        status: agent.status === "idle" ? "idle" : "thinking-or-tool",
        labels: labels.labelsFor(agent.session.id),
        cwd: typeof agent.session?.header?.cwd === "string" ? agent.session.header.cwd : "",
        self: agent.session.id === fromId,
        idle_for: idleFor(agent, now),
      }))
      .sort((left, right) => {
        const leftNumber = Number(left.alias);
        const rightNumber = Number(right.alias);
        return Number.isNaN(leftNumber) || Number.isNaN(rightNumber)
          ? left.alias.localeCompare(right.alias)
          : leftNumber - rightNumber;
      });
    return rows;
  }

  return Object.freeze({
    send,
    status,
    list,
    alias: (sessionId) => {
      pruneLabels();
      return aliasFor(sessionId);
    },
    resolve: (address) => {
      pruneLabels();
      return resolveAddress(address);
    },
    hang: (sessionId, label) => {
      pruneLabels();
      labels.hang(sessionId, label);
    },
    clear: (sessionId, label) => {
      pruneLabels();
      labels.clear(sessionId, label);
    },
    release: (sessionId) => labels.release(sessionId),
    labelsFor: (sessionId) => labels.labelsFor(sessionId),
    dispose: () => {},
  });
}