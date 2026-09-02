import assert from "node:assert/strict";
import { test } from "node:test";

import { createRelayService, isChildAgent, isGenericRelayPeer } from "../src/relay.mjs";
import { buildRelayTools } from "../src/tools.mjs";
import { apply as applyRelayPlugin } from "../src/plugin.mjs";

const FROM_ID = "session-11111111-1111-4111-8111-111111111111";
const TO_ID = "session-22222222-2222-4222-8222-222222222222";
const CHILD_ID = "session-33333333-3333-4333-8333-333333333333";
const FOREIGN_CHILD_ID = "session-44444444-4444-4444-8444-444444444444";
const MAX_MESSAGE_LENGTH = 65_536;

function fakeAgent(id, {
  status = "idle",
  cwd,
  createdAt,
  events = [],
  origin,
  parentSession,
  parentId,
  parent,
  parent_session,
} = {}) {
  const calls = {
    cancel: [],
    followup: [],
    steer: [],
  };
  return {
    calls,
    inbox: { nextStep: [], nextTurn: [] },
    session: {
      id,
      events,
      header: {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(parentSession !== undefined ? { parentSession } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(parent !== undefined ? { parent } : {}),
        ...(parent_session !== undefined ? { parent_session } : {}),
      },
    },
    status,
    cancel(reason) {
      calls.cancel.push(reason);
    },
    followup(message) {
      calls.followup.push(message);
      this.inbox.nextTurn.push(message);
    },
    steer(message) {
      calls.steer.push(message);
      this.inbox.nextStep.push(message);
    },
  };
}

function fixture({
  aliases,
  now,
  recipientOptions = {},
  recipientStatus = "idle",
  senderOptions = {},
  extraAgents = [],
} = {}) {
  const sender = fakeAgent(FROM_ID, senderOptions);
  const recipient = fakeAgent(TO_ID, { status: recipientStatus, ...recipientOptions });
  const live = new Map([
    [FROM_ID, sender],
    [TO_ID, recipient],
  ]);
  for (const agent of extraAgents) live.set(agent.session.id, agent);
  const agents = {
    get: (sessionId) => live.get(sessionId),
    list: () => [...live.values()],
  };
  const services = new Map([
    ["agents", agents],
    ["sessions", { flush: async () => {} }],
  ]);
  if (aliases !== undefined) {
    services.set("qq-core", {
      alias: (sessionId) => aliases.get(sessionId),
    });
  }
  const ctx = {
    get: (name) => services.get(name),
  };
  return {
    agents,
    ctx,
    live,
    recipient,
    relay: createRelayService(ctx, now === undefined ? {} : { now: () => now }),
    sender,
  };
}

async function relaySend(relay, sender, args) {
  const tool = buildRelayTools(relay).find(({ name }) => name === "relay_send");
  assert.ok(tool, "relay_send tool is registered");
  return tool.execute(args, { agent: sender });
}

async function relayList(relay, sender, args = {}) {
  const tool = buildRelayTools(relay).find(({ name }) => name === "relay_list");
  assert.ok(tool, "relay_list tool is registered");
  return tool.execute(args, { agent: sender });
}

async function relayStatus(relay, sender, args) {
  const tool = buildRelayTools(relay).find(({ name }) => name === "relay_status");
  assert.ok(tool, "relay_status tool is registered");
  return tool.execute(args, { agent: sender });
}

function expectedText(payload, { alias, delivery = "default" } = {}) {
  const aliasAttribute = alias === undefined ? "" : ` alias="${alias}"`;
  const escapedPayload = payload.replaceAll("</mail-body>", "&lt;/mail-body>");
  return `<agent-mail from="${FROM_ID}"${aliasAttribute} delivery="${delivery}">
Inbound mail from another agent, not the operator.

<mail-body>
${escapedPayload}
</mail-body>
</agent-mail>`;
}

test("relay_send default delivery steers one user-role plugin envelope with the exact mail wrapper", async () => {
  const aliases = new Map([[FROM_ID, "20"]]);
  const { recipient, relay, sender } = fixture({ aliases });
  const payload = "Please review the settled result.";

  const receipt = await relaySend(relay, sender, { to: TO_ID, message: payload });

  assert.equal(receipt.status, "sent");

  assert.equal(recipient.calls.steer.length, 1);
  assert.equal(recipient.calls.followup.length, 0);
  assert.equal(recipient.calls.cancel.length, 0);
  const envelope = recipient.calls.steer[0];
  assert.equal(envelope.role, "user");
  assert.deepEqual(envelope.source, {
    kind: "plugin",
    plugin: "qq-relay",
    form: "relay",
    senderSessionId: FROM_ID,
  });
  assert.deepEqual(envelope.content, [{
    type: "text",
    text: expectedText(payload, { alias: "20" }),
  }]);
  assert.equal(envelope.content[0].text.includes("From session"), false);
});

test("relay_send urgent delivery cancels a busy turn and follows up with delivery=urgent", async () => {
  const { recipient, relay, sender } = fixture({ recipientStatus: "thinking" });
  const payload = "Stop: the premise changed.";

  const receipt = await relaySend(relay, sender, {
    to: TO_ID,
    message: payload,
    delivery: "urgent",
  });

  assert.equal(receipt.status, "sent");

  assert.deepEqual(recipient.calls.cancel, [{
    kind: "hook",
    reason: "qq-relay urgent message",
  }]);
  assert.equal(recipient.calls.steer.length, 0);
  assert.equal(recipient.calls.followup.length, 1);
  assert.equal(
    recipient.calls.followup[0].content[0].text,
    expectedText(payload, { delivery: "urgent" }),
  );
});

test("sender alias attribute is omitted without a qq alias facade", async () => {
  const { recipient, relay } = fixture();

  await relay.send({ fromId: FROM_ID, to: TO_ID, message: "No alias is available." });

  const text = recipient.calls.steer[0].content[0].text;
  assert.equal(text, expectedText("No alias is available."));
  assert.match(text, new RegExp(`^<agent-mail from="${FROM_ID}" delivery="default">`));
});

test("sender alias is XML attribute-escaped when the qq facade supplies one", async () => {
  const aliases = new Map([[FROM_ID, 'alias "A" & <B>']]);
  const { recipient, relay } = fixture({ aliases });

  await relay.send({ fromId: FROM_ID, to: TO_ID, message: "Escaped alias." });

  assert.equal(
    recipient.calls.steer[0].content[0].text,
    expectedText("Escaped alias.", { alias: "alias &quot;A&quot; &amp; &lt;B&gt;" }),
  );
});

test("mail-body closing substrings are escaped without blocking delivery", async () => {
  const { recipient, relay } = fixture();
  const payload = "before</mail-body>middle</mail-body>after & untouched";

  await relay.send({ fromId: FROM_ID, to: TO_ID, message: payload });

  assert.equal(recipient.calls.steer.length, 1);
  assert.equal(
    recipient.calls.steer[0].content[0].text,
    expectedText(payload),
  );
});

test("message length limit is applied to the raw payload rather than the wrapper", async () => {
  const { recipient, relay } = fixture();
  const maximumPayload = "x".repeat(MAX_MESSAGE_LENGTH);

  await relay.send({ fromId: FROM_ID, to: TO_ID, message: maximumPayload });

  assert.equal(recipient.calls.steer.length, 1);
  assert.ok(recipient.calls.steer[0].content[0].text.length > MAX_MESSAGE_LENGTH);
  await assert.rejects(
    relay.send({
      fromId: FROM_ID,
      to: TO_ID,
      message: "x".repeat(MAX_MESSAGE_LENGTH + 1),
    }),
    /message exceeds 65536 characters/,
  );
  assert.equal(recipient.calls.steer.length, 1);
});

test("relay_list exposes cwd, caller identity, status, and compact idle duration", async () => {
  const now = Date.UTC(2026, 7, 28, 12, 0, 0);
  const aliases = new Map([
    [FROM_ID, "9"],
    [TO_ID, "2"],
  ]);
  const { relay, sender } = fixture({
    aliases,
    now,
    senderOptions: {
      cwd: "/home/qqp/projects/qq-relay",
      createdAt: now - (2 * 60 * 60 * 1000),
      events: [
        { type: "turn/end", time: now - (5 * 60 * 1000) },
        { type: "older/event", time: now - (30 * 60 * 1000) },
      ],
    },
    recipientStatus: "thinking",
    recipientOptions: {
      cwd: "/home/qqp/projects/qq-core",
      createdAt: now - (24 * 60 * 60 * 1000),
      events: [{ type: "step/start", time: now - (3 * 60 * 1000) }],
    },
  });
  relay.hang(FROM_ID, "workflows:architect");
  relay.hang(TO_ID, "workflows:implementer");
  const tool = buildRelayTools(relay).find(({ name }) => name === "relay_list");
  assert.match(tool.description, /session UUID \(the relay_send handle\)/);
  assert.match(tool.description, /alias \(the operator handle, never a send handle\)/);
  assert.match(tool.description, /cwd, self, status .* idle_for/);

  const result = await tool.execute({}, { agent: sender });
  const filtered = await tool.execute({ filter: "workflows:architect" }, { agent: sender });
  assert.deepEqual(filtered.rows.map((row) => row.session), [FROM_ID]);
  assert.equal(filtered.rows[0].self, true);

  assert.deepEqual(result, {
    status: "ok",
    rows: [
      {
        alias: "2",
        session: TO_ID,
        status: "thinking-or-tool",
        labels: ["workflows:implementer"],
        cwd: "/home/qqp/projects/qq-core",
        self: false,
        idle_for: "",
      },
      {
        alias: "9",
        session: FROM_ID,
        status: "idle",
        labels: ["workflows:architect"],
        cwd: "/home/qqp/projects/qq-relay",
        self: true,
        idle_for: "5m",
      },
    ],
  });

  const rendered = tool.output.render({}, result)[0].text;
  assert.equal(rendered, `live sessions:
${TO_ID}  alias 2  thinking-or-tool  /home/qqp/projects/qq-core  workflows:implementer
${FROM_ID}  alias 9  idle 5m  /home/qqp/projects/qq-relay  self  workflows:architect`);
  assert.equal(rendered.includes("(ephemeral)"), false);
  assert.equal(rendered.includes("session session-"), false);
});

test("relay_list marks no row self without a listing caller and falls back to header creation time", () => {
  const now = Date.UTC(2026, 7, 28, 12, 0, 0);
  const aliases = new Map([
    [FROM_ID, "9"],
    [TO_ID, "2"],
  ]);
  const { relay } = fixture({
    aliases,
    now,
    senderOptions: {
      cwd: 42,
      createdAt: now - (48 * 60 * 60 * 1000),
    },
    recipientOptions: {
      createdAt: now - (5 * 1000),
    },
  });

  const rows = relay.list();

  assert.equal(rows.every((row) => row.self === false), true);
  assert.equal(rows.find((row) => row.session === FROM_ID).cwd, "");
  assert.equal(rows.find((row) => row.session === FROM_ID).idle_for, "2d");
  assert.equal(rows.find((row) => row.session === TO_ID).idle_for, "5s");

  const tool = buildRelayTools(relay).find(({ name }) => name === "relay_list");
  const rendered = tool.output.render({}, { status: "ok", rows: [rows.find((row) => row.session === FROM_ID)] })[0].text;
  assert.match(rendered, /  idle 2d  cwd —$/);
});

test("relay_list still excludes projects while relay_send rejects operator aliases", async () => {
  const aliases = new Map([
    [FROM_ID, "9"],
    [TO_ID, "projects"],
  ]);
  const { relay, sender } = fixture({ aliases });
  const tools = buildRelayTools(relay);
  const list = tools.find(({ name }) => name === "relay_list");
  const send = tools.find(({ name }) => name === "relay_send");

  const listed = await list.execute({}, { agent: sender });
  const refused = await send.execute({ to: "9", message: "do not route aliases" }, { agent: sender });

  assert.deepEqual(listed.rows.map((row) => row.session), [FROM_ID]);
  assert.equal(relay.resolve("projects"), TO_ID, "internal alias lookup remains available");
  assert.equal(listed.rows[0].alias, "9");
  assert.equal(listed.rows[0].self, true);
  assert.equal(refused.status, "refused");
  assert.match(refused.reason, /aliases .* not accepted/);
});

test("generic relay allows architect-to-architect send and lists both chairs", async () => {
  const aliases = new Map([
    [FROM_ID, "1"],
    [TO_ID, "2"],
  ]);
  const { relay, sender, recipient } = fixture({ aliases });

  const listed = await relayList(relay, sender);
  assert.deepEqual(listed.rows.map((row) => row.session).sort(), [FROM_ID, TO_ID].sort());
  const receipt = await relaySend(relay, sender, { to: TO_ID, message: "coordinate" });
  assert.equal(receipt.status, "sent");
  assert.equal(recipient.calls.steer.length, 1);
});

test("generic relay hides children from the directory and refuses architect-to-child send", async () => {
  const ownChild = fakeAgent(CHILD_ID, { origin: "subagent", parentSession: FROM_ID });
  const foreignChild = fakeAgent(FOREIGN_CHILD_ID, { origin: "subagent", parentSession: TO_ID });
  const aliases = new Map([
    [FROM_ID, "1"],
    [TO_ID, "2"],
    [CHILD_ID, "3"],
    [FOREIGN_CHILD_ID, "4"],
  ]);
  const { relay, sender } = fixture({ aliases, extraAgents: [ownChild, foreignChild] });

  const listed = await relayList(relay, sender);
  assert.deepEqual(listed.rows.map((row) => row.session).sort(), [FROM_ID, TO_ID].sort());
  assert.equal(listed.rows.some((row) => row.session === CHILD_ID), false);
  assert.equal(listed.rows.some((row) => row.session === FOREIGN_CHILD_ID), false);

  const own = await relaySend(relay, sender, { to: CHILD_ID, message: "use workflow_send" });
  assert.equal(own.status, "refused");
  assert.match(own.reason, /workflow_send/);
  assert.equal(ownChild.calls.steer.length, 0);

  const foreign = await relaySend(relay, sender, { to: FOREIGN_CHILD_ID, message: "no foreign child" });
  assert.equal(foreign.status, "refused");
  assert.match(foreign.reason, /not generic relay recipients/);
  assert.equal(foreignChild.calls.steer.length, 0);
});

test("internal send still delivers parent-to-child and child-to-parent completion", async () => {
  const child = fakeAgent(CHILD_ID, { origin: "subagent", parentSession: FROM_ID });
  const { relay, sender } = fixture({ extraAgents: [child] });

  const parentToChild = await relay.send({
    fromId: FROM_ID,
    to: CHILD_ID,
    message: "workflow_send body",
  });
  assert.equal(parentToChild.status, "sent");
  assert.equal(child.calls.steer.length, 1);

  const completion = await relay.send({
    fromId: CHILD_ID,
    to: FROM_ID,
    message: "automatic completion report",
    messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(completion.status, "sent");
  assert.equal(sender.calls.steer.length, 1);

  const again = await relay.send({
    fromId: CHILD_ID,
    to: FROM_ID,
    message: "automatic completion report",
    messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(again.status, "sent");
  assert.equal(again.message_id, completion.message_id);
  assert.equal(sender.calls.steer.length, 1, "duplicate completion envelope is idempotent");
});

test("child-form generic tools are execution-denied even if a scope-local copy leaks", async () => {
  const child = fakeAgent(CHILD_ID, { origin: "subagent", parentSession: FROM_ID });
  const { relay, sender } = fixture({ extraAgents: [child] });

  const listed = await relayList(relay, child);
  assert.equal(listed.status, "refused");
  assert.match(listed.reason, /delegated children cannot use generic relay/);

  const sent = await relaySend(relay, child, { to: FROM_ID, message: "child raw relay" });
  assert.equal(sent.status, "refused");
  assert.match(sent.reason, /delegated children cannot use generic relay/);
  assert.equal(sender.calls.steer.length, 0);

  const status = await relayStatus(relay, child, { message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  assert.equal(status.status, "refused");
  assert.match(status.reason, /delegated children cannot use generic relay/);
});

test("parentId header variants and origin each classify as children", () => {
  assert.equal(isChildAgent(fakeAgent(CHILD_ID)), false);
  assert.equal(isChildAgent(fakeAgent(CHILD_ID, { origin: "subagent" })), true);
  assert.equal(isChildAgent(fakeAgent(CHILD_ID, { parentSession: FROM_ID })), true);
  assert.equal(isChildAgent(fakeAgent(CHILD_ID, { parentId: FROM_ID })), true);
  assert.equal(isChildAgent(fakeAgent(CHILD_ID, { parent: FROM_ID })), true);
  assert.equal(isChildAgent(fakeAgent(CHILD_ID, { parent_session: FROM_ID })), true);
  assert.equal(isGenericRelayPeer(fakeAgent(FROM_ID)), true);
  assert.equal(isGenericRelayPeer(fakeAgent(CHILD_ID, { origin: "subagent" })), false);
  assert.equal(isGenericRelayPeer(fakeAgent(TO_ID), { alias: "projects" }), false);
});

test("projects-chair generic send to an architect remains available and still cannot address children", async () => {
  const aliases = new Map([
    [FROM_ID, "projects"],
    [TO_ID, "2"],
  ]);
  const child = fakeAgent(CHILD_ID, { origin: "subagent", parentSession: TO_ID });
  const { relay, sender, recipient } = fixture({ aliases, extraAgents: [child] });

  const listed = await relayList(relay, sender);
  assert.deepEqual(listed.rows.map((row) => row.session), [TO_ID]);

  const toArchitect = await relaySend(relay, sender, { to: TO_ID, message: "projects coordination" });
  assert.equal(toArchitect.status, "sent");
  assert.equal(recipient.calls.steer.length, 1);

  const toChild = await relaySend(relay, sender, { to: CHILD_ID, message: "projects cannot raw-relay children" });
  assert.equal(toChild.status, "refused");
  assert.match(toChild.reason, /workflow_send/);
  assert.equal(child.calls.steer.length, 0);
});

test("plugin skips child-scope tool registration while still providing the mailbox", () => {
  const child = fakeAgent(CHILD_ID, { origin: "subagent", parentSession: FROM_ID });
  const registered = [];
  const childTools = {
    register(tool) {
      registered.push(`child:${tool.name}`);
      return () => {};
    },
  };
  const hostTools = {
    register(tool) {
      registered.push(`host:${tool.name}`);
      return () => {};
    },
  };
  const { ctx } = fixture({ extraAgents: [child] });
  const childCtx = {
    agent: child,
    get(name) {
      if (name === "tools") return childTools;
      return ctx.get(name);
    },
    effect(callback) {
      return callback();
    },
  };
  const hostCtx = {
    get(name, optional) {
      if (name === "tools") return hostTools;
      return ctx.get(name, optional);
    },
    provide() {},
    inject(_deps, callback) {
      callback(hostCtx);
      callback(childCtx);
    },
    effect(callback) {
      return callback();
    },
  };
  applyRelayPlugin(hostCtx);
  assert.deepEqual(registered, ["host:relay_list", "host:relay_send", "host:relay_status"]);
});

test("directory stays consistent when a child carries workflow labels, and disposed children fail closed", async () => {
  const child = fakeAgent(CHILD_ID, { origin: "subagent", parentSession: FROM_ID });
  const { live, relay, sender } = fixture({ extraAgents: [child] });
  relay.hang(CHILD_ID, "workflows:implementer");
  relay.hang(FROM_ID, "workflows:architect");

  const labeled = await relayList(relay, sender, { filter: "workflows" });
  assert.deepEqual(labeled.rows.map((row) => row.session), [FROM_ID]);
  assert.equal(labeled.rows[0].labels.includes("workflows:architect"), true);

  live.delete(CHILD_ID);
  await assert.rejects(
    relay.send({ fromId: FROM_ID, to: CHILD_ID, message: "stale child" }),
    /no live session matches/,
  );
  const genericStale = await relaySend(relay, sender, { to: CHILD_ID, message: "stale child" });
  assert.equal(genericStale.status, "refused");
  assert.match(genericStale.reason, /no live session matches/);
});
