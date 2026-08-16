# qq-relay integration

qq-relay owns its public source, checks, releases, and implementation at <https://github.com/hypermemetic-ai/qq-relay>. qq consumes the stable `refs/heads/main` contract through the source relation in `upstream.env`; qq does not vendor or pin qq-relay source.

`bin/qq-relay` executes `bin/qq-relay` from the configured landed repository. Node consumers import `bin/lib/qq-relay-client.mjs`, which loads that repository's `client.mjs`. Both resolvers fail clearly when the linked source is absent and accept `QQ_RELAY_SOURCE=/absolute/checkout` for isolated tests. They do not search `PATH` or arbitrary sibling directories.

`tests/test-qq-relay.sh` clones the configured landed repository when available, otherwise fetches the configured upstream branch, detaches at its current tip, and exercises the launcher, client exports, and live messaging against that isolated checkout.

To upgrade, validate the desired upstream `main` tip in qq-relay, land it there, then run `npm test` in qq. qq records the branch relation, not a product commit, tag, version, or capability floor.
