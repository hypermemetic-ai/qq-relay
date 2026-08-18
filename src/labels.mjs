// Bulletin-board labels for the in-process qq-relay plugin.
//
// Relay is the bulletin board; workflows write the sticky notes. A live
// session carries a small bag of namespaced tokens like `tasks:T-66` or
// `workflows:delegate`. Relay displays and filters them; it does not interpret
// them. Other plugins hang and clear them through the qq-relay service; there
// is no presence file store.

const LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}:[^\s]{1,63}$/;

export function createLabelBoard({ isLive } = {}) {
  const bags = new Map();

  function requireLive(sessionId) {
    if (typeof isLive !== "function" || isLive(sessionId)) return;
    throw new Error("qq-relay: labels hang on live sessions only");
  }

  return Object.freeze({
    hang(sessionId, label) {
      if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
        throw new Error("qq-relay: label must be a namespaced token like tasks:T-66");
      }
      requireLive(sessionId);
      if (!bags.has(sessionId)) bags.set(sessionId, new Set());
      bags.get(sessionId).add(label);
    },

    /**
     * Take one label down, or every label under a namespace when given a bare
     * namespace (`workflows` removes `workflows:*`). A workflow that lets go
     * clears its own namespace.
     */
    clear(sessionId, label) {
      const bag = bags.get(sessionId);
      if (!bag) return false;
      if (label.includes(":")) {
        const removed = bag.delete(label);
        if (bag.size === 0) bags.delete(sessionId);
        return removed;
      }
      const targets = [...bag].filter((token) => token.startsWith(`${label}:`));
      for (const token of targets) bag.delete(token);
      if (bag.size === 0) bags.delete(sessionId);
      return targets.length > 0;
    },

    /** The session leaves: its whole bag comes down. */
    release(sessionId) {
      const removed = bags.delete(sessionId);
      return removed;
    },

    /** Sessions that left take their whole bag down with them. */
    pruneLive() {
      for (const sessionId of [...bags.keys()]) {
        if (typeof isLive !== "function" || !isLive(sessionId)) bags.delete(sessionId);
      }
    },

    labelsFor(sessionId) {
      return [...(bags.get(sessionId) ?? [])].sort();
    },

    /** Exact label match when the filter has a colon, else namespace prefix. */
    matches(labels, filter) {
      if (typeof filter !== "string" || filter.length === 0) return true;
      if (filter.includes(":")) return labels.includes(filter);
      return labels.some((label) => label.startsWith(`${filter}:`));
    },
  });
}