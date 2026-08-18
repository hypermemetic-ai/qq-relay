// qq-relay: one repository, one plugin. Cordis entry point.
//
// Loading this plugin is how a DSH host gets in-process messaging. Loading qq
// does not imply relay, and this package imports nothing from qq or from the
// old Pi agent-messages bag.

import { createRelayService } from "./relay.mjs";
import { buildRelayTools } from "./tools.mjs";

export const name = "qq-relay";
export const inject = ["agents", "sessions"];
export const provide = "qq-relay";

export function apply(ctx, config = {}) {
  const service = createRelayService(ctx, config);
  ctx.provide("qq-relay", service);

  const tools = ctx.get("tools", false);
  if (tools && typeof tools.register === "function") {
    ctx.effect(
      () => {
        const disposers = buildRelayTools(service).map((tool) => tools.register(tool));
        return () => {
          for (const dispose of disposers) dispose();
        };
      },
      "qq-relay: tools",
    );
  }
}