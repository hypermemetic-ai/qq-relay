// qq-relay: one repository, one plugin. Cordis entry point.
//
// Loading this plugin is how a DSH host gets in-process messaging. Loading qq
// does not imply relay, and this package imports nothing from qq or from the
// old Pi agent-messages bag. Live session numbers live on qq-core; this plugin
// consumes them through ctx.get("qq-core", false) / ctx.get("qq-core-aliases", false).

import { createRelayService, isChildAgent } from "./relay.mjs";
import { buildRelayTools } from "./tools.mjs";

export const name = "qq-relay";
export const inject = ["agents", "sessions"];
export const provide = "qq-relay";

function agentOf(holder) {
  if (holder?.agent?.session) return holder.agent;
  try {
    const agent = holder?.get?.("agent", false);
    if (agent?.session) return agent;
  } catch {
    // Optional agent lookup must not block host registration.
  }
  return null;
}

export function apply(ctx, config = {}) {
  const service = createRelayService(ctx, config);
  ctx.provide("qq-relay", service);

  const registerTools = (toolCtx) => {
    // Scope-local copies on delegated children bypass the Mini inherited
    // allowlist. The generic tools belong on the host/chair layer; children
    // use workflow_send. Execution still fail-closes if a copy leaks.
    const agent = agentOf(toolCtx);
    if (agent && isChildAgent(agent)) return;
    const tools = toolCtx?.get?.("tools", false) ?? ctx.get("tools", false);
    if (!tools || typeof tools.register !== "function") return;
    return toolCtx.effect(
      () => {
        const disposers = buildRelayTools(service).map((tool) => tools.register(tool));
        return () => {
          for (const dispose of disposers) dispose();
        };
      },
      "qq-relay: tools",
    );
  };
  if (typeof ctx.inject === "function") ctx.inject(["tools"], registerTools);
  else registerTools(ctx);
}
