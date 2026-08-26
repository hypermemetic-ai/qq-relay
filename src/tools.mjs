// Model-facing relay tools: list, send, status.
//
// The sender receipt is the tool result; refusals come back as text with
// details.status "refused" rather than throwing through the agent loop.

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function textBlock(text) {
  return { type: "text", text };
}

function refusal(reason) {
  return {
    status: "refused",
    reason,
  };
}

export function buildRelayTools(relay) {
  return [
    {
      name: "relay_list",
      description: "List live sessions in this DSH host that can receive relay messages. Each row visibly shows the stable session UUID, ephemeral display alias, one status phrase (idle or thinking-or-tool), and any labels other plugins hung on it. Filter by an exact namespaced label (tasks:T-66) or a namespace prefix (tasks). The full session UUID is the only safe relay_send handle; aliases are informational and can be reassigned. Relayed messages wake busy sessions; prefer to send only when something is actionable.",
      parameters: {
        filter: {
          type: "string",
          description: "Optional namespaced label to match exactly (tasks:T-66) or by namespace prefix (tasks).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            status: { type: "string" },
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  alias: { type: "string" },
                  session: { type: "string" },
                  status: { type: "string" },
                  labels: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Relay refused: ${value.reason}`)];
          const rows = Array.isArray(value.rows) ? value.rows : [];
          if (rows.length === 0) return [textBlock("No live sessions match.")];
          const lines = rows.map((row) => {
            const labelsLine = Array.isArray(row.labels) && row.labels.length > 0
              ? `  ${row.labels.join(" ")}`
              : "";
            const alias = row.alias ? `alias ${row.alias} (ephemeral)` : "alias —";
            return `session ${row.session}  ${alias}  ${row.status}${labelsLine}`;
          });
          const text = `live sessions:\n${lines.join("\n")}`;
          return [textBlock(text)];
        },
      },
      async execute(args) {
        try {
          const rows = relay.list({ filter: args.filter });
          return { status: "ok", rows };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "relay_send",
      description: "Send one message to another live session in this DSH host. to must be the full stable session UUID from relay_list; aliases are display-only and are rejected because they can be reassigned. default delivery steers the recipient: the message lands at their next tool/step boundary and wakes them if idle. urgent delivery halts their current turn, then starts a fresh turn with this message. Use urgent only for high-urgency interrupts. The recipient cannot opt out during their core run; sending wakes them. Your receipt is this tool's result, not a special transcript card. Cannot address the sender's own session.",
      parameters: {
        to: {
          type: "string",
          required: true,
          pattern: "^session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
          description: "Recipient full stable session UUID from relay_list. Aliases are not accepted.",
        },
        message: {
          type: "string",
          required: true,
          description: "The message content.",
        },
        delivery: {
          type: "string",
          enum: ["default", "urgent"],
          description: "default steers into the recipient's next step; urgent halts their turn then delivers.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            status: { type: "string" },
            message_id: { type: "string" },
            to: { type: "string" },
            to_alias: { type: "string" },
            delivery: { type: "string" },
            reason: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Relay refused: ${value.reason}`)];
          const alias = value.to_alias ? ` (alias ${value.to_alias}, ephemeral)` : "";
          return [textBlock(
            `message sent to session ${value.to}${alias} via ${value.delivery}: ${value.message_id}`,
          )];
        },
      },
      async execute(args, exec) {
        try {
          const fromId = exec?.agent?.session?.id;
          if (!SESSION_ID.test(args?.to ?? "")) {
            return refusal("relay_send requires the full stable session UUID from relay_list; aliases are ephemeral and not accepted");
          }
          const result = await relay.send({
            fromId,
            to: args.to,
            message: args.message,
            delivery: args.delivery ?? "default",
          });
          return result;
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "relay_status",
      description: "Inspect the in-process delivery record for a message id returned by relay_send. In the v1 in-process relay, send already routed into the recipient's inbox, so a found record reads sent.",
      parameters: {
        message_id: {
          type: "string",
          required: true,
          description: "The message id returned by relay_send.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            status: { type: "string" },
            message_id: { type: "string" },
            to: { type: "string" },
            to_alias: { type: "string" },
            reason: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Relay refused: ${value.reason}`)];
          const alias = value.to_alias ? ` (alias ${value.to_alias} at send time, ephemeral)` : "";
          return [textBlock(`relay message ${value.message_id} to session ${value.to}${alias} is sent`)];
        },
      },
      async execute(args) {
        try {
          return relay.status(args.message_id);
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}