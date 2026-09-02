# `@hypermemetic-ai/qq-relay`

Private ES module package providing an in-process Cordis session mailbox for the core DSH host.

## Run the established checks

```sh
npm test
```

The test script first syntax-checks [`src/plugin.mjs`](src/plugin.mjs), then runs the Node.js test runner. The package declares no start or other run script; it exposes modules for a host to consume.

## Repository map

| Boundary | Start here | Verification / contract |
| --- | --- | --- |
| Default package entry | [`src/plugin.mjs`](src/plugin.mjs) | Main module and `.` export in [`package.json`](package.json) |
| `./relay` export | [`src/relay.mjs`](src/relay.mjs) | [`test/relay.test.mjs`](test/relay.test.mjs) |
| `./labels` export | [`src/labels.mjs`](src/labels.mjs) | Run the full test command |
| `./tools` export | [`src/tools.mjs`](src/tools.mjs) | Run the full test command |
| Package exports and test command | [`package.json`](package.json) | `npm test` |

The relay and tools modules have the broadest internal relative-import fan-in, and the relay is the most frequently changed source file in the available history. Begin there when tracing shared behavior, but use the explicit export map in [`package.json`](package.json) as the public package boundary.

Model-facing `relay_list` / `relay_send` / `relay_status` are the generic architect↔architect channel. Child sessions (header `origin=subagent` or a durable parent session id) are omitted from the directory and refused as generic recipients; delegated children cannot use the generic tools. Internal `send()` without `generic:true` still delivers workflow-owned parent→child steer and automatic child→parent completion. The projects session remains unlistable and cannot be a recipient; projects-chair send to an architect stays available.

## Change routing

- For relay behavior, change [`src/relay.mjs`](src/relay.mjs) and cover it in [`test/relay.test.mjs`](test/relay.test.mjs).
- For model-facing generic recipient policy, keep the filter in [`src/relay.mjs`](src/relay.mjs) and [`src/tools.mjs`](src/tools.mjs) so internal `send()` callers stay topology-capable.
- For host integration or the default export, begin with [`src/plugin.mjs`](src/plugin.mjs). Child agent contexts must not receive scope-local generic tools.
- For public entry points, package metadata, or the test lifecycle, update [`package.json`](package.json); the package uses `"type": "module"` and explicitly enumerates its exports.
- No dedicated tracked test files exist for labels, tools, or plugin changes, so run the complete `npm test` command after changes in those areas.
