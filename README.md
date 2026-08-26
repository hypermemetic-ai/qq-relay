# `@hypermemetic-ai/qq-relay`

One repository, one plugin, one version. The Cordis plugin and its message bus
ship together; the bus is the plugin's own in-process mailbox, not a second
product. Rollback is one unit.

Loading this plugin is how a DSH host gets session messaging. Loading qq does
not imply relay.

## Contract

### Live sessions only

A session that is just a file on disk is not a recipient. List and send see
the sessions loaded in this host. Anyone loaded may send; there is no role
gate. A send is accepted or refused in the tool result — the sender gets no
transcript card for "I sent this".

### Stable address is the DSH session UUID; aliases are display shorthand

The durable live identity is DSH's full `session-<UUID>`. Model-facing tools
require that UUID from `relay_list`; an alias is never accepted as
`relay_send.to` because aliases can be reassigned after a session leaves. qq
owns the short public alias only so a human can point at a session on a screen.
Relay consumes that book through `ctx.get("qq", false)` /
`ctx.get("qq-aliases", false)`. The service API continues to resolve a current
alias for compatibility with internal/human callers, but stale UUIDs always
refuse and never follow an alias to its new holder. Relay does not keep a
second map, persist aliases, or npm-depend on `@hypermemetic-ai/qq`. Missing qq
means no display aliases; send still works by session UUID.

Locked deck (owned by qq, not this plugin), issued farthest-first among free
names (live aliases spread out), never re-dealt while a session lives, no
midnight reset, no re-deal on restart:

- Published: `1 2 3 4 9 10 12 20 40 80`
- Strange overflow, only these: `6 7 8 11 30` (checked against the live spoken
  set)
- Past that: integers above 100, still spoken-distinct from live aliases and
  never a neighbor of one. Pronunciation convenience stops being a goal.

Warmth: the last few issued aliases stay warm after their session leaves so a
returning number feels fresh. The map lives on qq at a dotfile beside
`DSH_HOME` (`.qq-aliases.json`).

### Send modes, two only

- `default` = steer. The message lands at the recipient's next tool/step
  boundary (DSH `agent.steer`). If the recipient is idle, it starts a turn.
  This is the default, not a followup that waits for the whole turn.
- `urgent` = halt, then a fresh turn. The current turn is cancelled first
  (DSH `agent.cancel` with a hook cause) so leftover inbox work cannot race
  the urgent text; then the message is delivered as a followup that starts a
  new turn. High-urgency path only.

Both wake the recipient. `inject` is not a send mode.

Inbound mail is a DSH user-role message with the plugin source mark
(`{ kind: "plugin", plugin: "qq-relay", form: "relay" }`) plus a short
from-line (`From session <session-UUID> (alias <alias>, ephemeral):`), so the
model sees durable sender identity and never reads it as the operator typing.

### Directory rows

`relay_list` returns and visibly renders, per live session: the canonical full
session UUID, an explicitly ephemeral alias, one status phrase (`idle` /
`thinking-or-tool`), and labels. The UUID is the handle; labels and aliases are
metadata, never identity.

### Labels: relay is the bulletin board, workflows write the sticky notes

A live session carries a small bag of namespaced tokens, e.g. `tasks:T-66`,
`workflows:land-run/land-54ded5f5`, or `workflows:land-role/qa-look-1`.
Relay displays and filters them (`tasks:T-66` exact, or
`tasks` for a namespace prefix); it does not interpret them. Other plugins hang
and clear labels through the public `qq-relay` service:

- `hang(sessionId, label)` — only while the session is live,
- `clear(sessionId, label)` — one token, or a bare namespace to take a
  workflow's whole sticky block down,
- `release(sessionId)` — session leaves, bag drops.

Labels are in-memory; there is no presence file store. Workflows and task
plugins fill the board when they exist.

## Tool surface

When the DSH host exposes `ctx.tools`, the plugin registers three tools:

| Tool | Purpose |
|---|---|
| `relay_list` | Live sessions with stable UUID, ephemeral alias, status phrase, labels; optional label filter. |
| `relay_send` | Send to the full live session UUID from `relay_list` with `default` or `urgent` delivery; aliases are rejected. |
| `relay_status` | Inspect the in-process delivery record for a `message_id`. |

The v1 mailbox is in-process, so a sent message is already routed into the
recipient's inbox; DSH session persistence owns the durable log entry. There
is no queue to poll.

## Out of this land

The daemon named by the ticket title is deliberately absent from v1: nothing
outside this process may send or receive yet, so there is no separate process,
socket, install root, or second database. A dictation writer is a later special
writer, not a reason to build a general bus now. Role gates, last-activity
clocks, resume-to-mail, and titles-as-handles stay out.

## Pi-era installed-product boundary (unchanged, Pi only)

The old machine-local durable relay for Pi/Herdr agent messaging and run
outcomes still exists as an external installed product. Its contract files
live here for the Pi migration period:

- `bin/qq-relay`, `bin/lib/qq-relay-install-root.mjs`,
  `bin/lib/qq-relay-client.mjs` — fail-closed resolvers for the installed
  artifact,
- `qq-relay/upstream.env` — stable `refs/heads/main` source relation; the
  contract suite `tests/test-qq-relay.sh` validates that product semantically.

The DSH plugin above does not import, exec, or vendor any of it. When Pi's
messaging migrates, that boundary is deleted; it is not a second qq-relay
product for DSH.

## Validation

```bash
node tests/test-qq-relay-plugin.mjs .
```

Covers live-only addressing against the qq book (or no aliases when qq is
absent), steer/urgent delivery, sender receipts, refusals, labels
hang/clear/purge, and tool registration. Alias dealing lives in
`node tests/test-qq-alias.mjs`.