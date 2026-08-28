import assert from "node:assert/strict";
import { test } from "node:test";

import { createRelayService } from "../src/relay.mjs";
import { buildRelayTools } from "../src/tools.mjs";

const FROM_ID = "session-11111111-1111-4111-8111-111111111111";
const TO_ID = "session-22222222-2222-4222-8222-222222222222";
const MAX_MESSAGE_LENGTH = 65_536;

function fakeAgent(id, {
  status = "idle",
  cwd,
  createdAt,
  events = [],
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
      },
    },
    status,
    cancel(reason) {
      calls.cancel.push(reason);
    },
    followup(message) {
      calls.followup.push(message);
    },
    steer(message) {
      calls.steer.push(message);
    },
  };
}

function fixture({
  aliases,
  now,
  recipientOptions = {},
  recipientStatus = "idle",
  senderOptions = {},
} = {}) {
  const sender = fakeAgent(FROM_ID, senderOptions);
  const recipient = fakeAgent(TO_ID, { status: recipientStatus, ...recipientOptions });
  const live = new Map([
    [FROM_ID, sender],
    [TO_ID, recipient],
  ]);
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
