// Model-facing relay tools: list, send, status.
//
// These tools are the generic architect↔architect (and projects-chair)
// coordination channel. Child sessions are omitted from the directory and
// refused as recipients; delegated children cannot use this surface. Internal
// workflow_send and automatic completion delivery call relay.send() without
// generic:true and are not gated here.
//
// The sender receipt is the tool result; refusals come back as text with
// details.status "refused" rather than throwing through the agent loop.

import { isChildAgent } from "./relay.mjs";

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
      description: "List live generic relay peers in this DSH host. This is the architect↔architect coordination directory (projects-chair coordination remains available separately). Child sessions are omitted; message owned children with workflow_send. Each row shows the stable session UUID (the relay_send handle), alias (the operator handle, never a send handle), cwd, self, status (idle or thinking-or-tool), idle_for, and any opaque labels other plugins hung on it. self marks the listing caller; idle_for is empty for non-idle sessions. Filter by an exact namespaced label (tasks:T-66) or a namespace prefix (tasks). Relayed messages wake busy sessions; prefer to send only when something is actionable.",
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
                  cwd: { type: "string" },
                  self: { type: "boolean" },
                  idle_for: { type: "string" },
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
            const fields = [
              row.session,
              row.alias ? `alias ${row.alias}` : "alias —",
              `${row.status}${row.idle_for ? ` ${row.idle_for}` : ""}`,
            ];
            fields.push(row.cwd ? row.cwd : "cwd —");
            if (row.self === true) fields.push("self");
            if (Array.isArray(row.labels) && row.labels.length > 0) {
              fields.push(row.labels.join(" "));
            }
            return fields.join("  ");
          });
          const text = `live sessions:\n${lines.join("\n")}`;
          return [textBlock(text)];
        },
      },
      async execute(args, exec) {
        try {
          if (isChildAgent(exec?.agent)) {
            return refusal("delegated children cannot use generic relay");
          }
          const fromId = exec?.agent?.session?.id;
          const rows = relay.list({ filter: args?.filter, fromId });
          return { status: "ok", rows };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "relay_send",
      description: "Send one message to another live generic relay peer in this DSH host (architect↔architect, with projects-chair coordination preserved separately). Child sessions are not generic recipients: message an owned current child with workflow_send. to must be the full stable session UUID from relay_list; aliases are display-only and are rejected because they can be reassigned. default delivery steers the recipient: the message lands at their next tool/step boundary and wakes them if idle. urgent delivery halts their current turn, then starts a fresh turn with this message. Use urgent only for high-urgency interrupts. The recipient cannot opt out during their core run; sending wakes them. Your receipt is this tool's result, not a special transcript card. Cannot address the sender's own session.",
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
          if (isChildAgent(exec?.agent)) {
            return refusal("delegated children cannot use generic relay");
          }
          const fromId = exec?.agent?.session?.id;
          if (!SESSION_ID.test(args?.to ?? "")) {
            return refusal("relay_send requires the full stable session UUID from relay_list; aliases are ephemeral and not accepted");
          }
          const result = await relay.send({
            fromId,
            to: args.to,
            message: args.message,
            delivery: args.delivery ?? "default",
            generic: true,
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
      async execute(args, exec) {
        try {
          if (isChildAgent(exec?.agent)) {
            return refusal("delegated children cannot use generic relay");
          }
          return relay.status(args.message_id);
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}