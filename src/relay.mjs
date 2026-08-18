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
//   plus a short from-line so it never reads as the operator typing.

import { randomUUID } from "node:crypto";

import { createAliasBook, defaultAliasFile } from "./alias.mjs";
import { createLabelBoard } from "./labels.mjs";

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

/** One DSH user-role message marked as plugin-originated agent mail. */
export function relayEnvelope({ fromId, fromAlias, text }) {
  return freezeDeep({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "qq-relay", form: "relay" },
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

  const book = createAliasBook(defaultAliasFile(process.env, config), {
    now: config.now,
    rng: config.rng,
  });
  const labels = createLabelBoard({
    isLive: (sessionId) => agents.get(sessionId) !== undefined,
  });
  const ledger = [];

  function syncAliases() {
    book.sync(liveAgents().map((agent) => agent.session.id));
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

  /** Route one validated envelope into a live recipient's inbox. */
  async function deliver(recipient, envelope, delivery) {
    if (delivery === "urgent") {
      if (recipient.status !== "idle") {
        recipient.cancel({ kind: "hook", reason: "qq-relay urgent message" });
      }
      recipient.followup(envelope);
    } else {
      recipient.steer(envelope);
    }
    await flushAck(recipient);
  }

  async function send({ fromId, to, message, delivery = "default" }) {
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
    syncAliases();
    const sender = agents.get(fromId);
    if (!sender) throw new RelayError("send requires a live session-<UUID> sender");

    const recipients = liveAgents();
    const exact = recipients.find((agent) => agent.session.id === to);
    const byAlias = recipients.find((agent) => book.aliasFor(agent.session.id) === to);
    const recipient = exact ?? byAlias;
    if (!recipient) throw new RelayError(`no live session matches ${JSON.stringify(to)}`);
    if (recipient.session.id === fromId) {
      throw new RelayError("send cannot address the sender's own session");
    }

    const fromAlias = book.aliasFor(fromId);
    const fromLine = `From session ${fromAlias ?? fromId} (${fromId}):\n\n`;
    const envelope = relayEnvelope({ fromId, fromAlias, text: fromLine + message });

    await deliver(recipient, envelope, delivery);

    ledger.push({
      message_id: envelope.id,
      to: recipient.session.id,
      to_alias: book.aliasFor(recipient.session.id),
      delivery,
      from: fromId,
      content: message,
      at: config.now?.() ?? Date.now(),
    });
    if (ledger.length > LEDGER_CAP) ledger.splice(0, ledger.length - LEDGER_CAP);

    return {
      status: "sent",
      message_id: envelope.id,
      to: recipient.session.id,
      to_alias: book.aliasFor(recipient.session.id),
      delivery,
    };
  }

  function status(messageId) {
    if (typeof messageId !== "string" || messageId.length === 0 || messageId.length > 128) {
      throw new RelayError("message_id is malformed");
    }
    const record = ledger.find((entry) => entry.message_id === messageId);
    if (!record) throw new RelayError("message_id not found");
    return { status: "sent", ...record };
  }

  /** Live directory rows: alias, one status phrase, labels bag. */
  function list({ filter } = {}) {
    syncAliases();
    const rows = liveAgents()
      .filter((agent) => {
        const bag = labels.labelsFor(agent.session.id);
        return labels.matches(bag, filter);
      })
      .map((agent) => ({
        alias: book.aliasFor(agent.session.id) ?? "",
        session: agent.session.id,
        status: agent.status === "idle" ? "idle" : "thinking-or-tool",
        labels: labels.labelsFor(agent.session.id),
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
      syncAliases();
      return book.aliasFor(sessionId);
    },
    resolve: (address) => {
      syncAliases();
      return liveAgents().find((agent) =>
        agent.session.id === address || book.aliasFor(agent.session.id) === address)?.session.id;
    },
    hang: (sessionId, label) => {
      syncAliases();
      labels.hang(sessionId, label);
    },
    clear: (sessionId, label) => {
      syncAliases();
      labels.clear(sessionId, label);
    },
    release: (sessionId) => labels.release(sessionId),
    labelsFor: (sessionId) => labels.labelsFor(sessionId),
    dispose: () => book.close(),
  });
}