# `@hypermemetic-ai/qq-relay`

Private ESM package providing the in-process Cordis session mailbox for the core DSH host. The package root resolves to [`src/plugin.mjs`](src/plugin.mjs); additional public entry points expose the relay, labels, and tools modules.

## Test

```sh
npm test
```

The declared test task first syntax-checks [`src/plugin.mjs`](src/plugin.mjs), then runs Node's test runner. The repository does not declare start or other run scripts; see [`package.json`](package.json) for the authoritative package entry points and task definition.

## Repository map

- [`src/plugin.mjs`](src/plugin.mjs) — package main and `.` export; start here for package entry-point changes.
- [`src/relay.mjs`](src/relay.mjs) — `./relay` export and the source module with the highest relative-import fan-in and recent change activity. Its focused tracked test is [`test/relay.test.mjs`](test/relay.test.mjs).
- [`src/tools.mjs`](src/tools.mjs) and [`src/labels.mjs`](src/labels.mjs) — `./tools` and `./labels` public exports.
- [`test/relay.test.mjs`](test/relay.test.mjs) — tracked relay test suite, executed by `npm test` through `node --test`.

## Change routing

| Change | Canonical source | Validation |
| --- | --- | --- |
| Package root or plugin entry point | [`src/plugin.mjs`](src/plugin.mjs) | `npm test` |
| Relay export | [`src/relay.mjs`](src/relay.mjs) | [`test/relay.test.mjs`](test/relay.test.mjs), then `npm test` |
| Tools or labels export | [`src/tools.mjs`](src/tools.mjs) or [`src/labels.mjs`](src/labels.mjs) | `npm test`; no dedicated tracked test file is established by the repository index |
| Export map, package metadata, or test command | [`package.json`](package.json) | `npm test` |
