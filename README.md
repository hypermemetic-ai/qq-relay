# `@hypermemetic-ai/qq-relay`

The relay is the in-process Cordis mailbox. This repository is the only DSH
relay generation and binds under the normal `qq-relay` name when present beside
`qq-core`. There is no daemon, Unix socket journal, install root, polling queue,
or second relay product.

The durable recipient identity is the full DSH `session-<UUID>`. Display aliases
are informational and rejected as send targets. `relay_list` lists live
recipients; `relay_send` delivers default or urgent messages through the live
Agent inbox; `relay_status` reports the in-process delivery record. DSH session
persistence owns durable transcript events.

Plugins may hang opaque namespaced labels on live sessions. Relay displays and
filters labels but does not interpret them. All routes, tools, labels, and
listeners are disposed with the plugin fiber.
