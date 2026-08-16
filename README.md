# qq-relay integration

qq-relay owns its public source, checks, installation, and service lifecycle at <https://github.com/hypermemetic-ai/qq-relay>. qq records only the stable `refs/heads/main` source relation in `upstream.env`; it does not vendor or pin qq-relay source and stores no product commit, tag, version, or capability floor.

Runtime uses only the product-owned installed artifact. `bin/qq-relay` executes `${QQ_RELAY_INSTALL_ROOT:-$HOME/.local/lib/qq/relay}/bin/qq-relay`, and Node consumers import `bin/lib/qq-relay-client.mjs`, which loads `client.mjs` from that same root. `QQ_RELAY_INSTALL_ROOT`, when set, must be an explicit absolute path. Both resolvers fail closed when the installed surface is absent. They never execute or import from the landed source relation, search `PATH`, fetch, or install at runtime.

The landed repository is for product work and semantic contract evidence. `tests/test-qq-relay.sh` fetches the configured upstream branch tip, checks its public contract, runs qq-relay's installer into a private temporary root, removes the source checkout, and exercises qq's launcher, client loader, agent messaging, pinned pi2dsh mount, and run outcomes against only that installed artifact and one private service. The tests do not read installed provenance and do not access the operator's install root or user-service manager.

Follow qq-relay's public README for check, install, activation, and upgrade/restart operations. qq does not own those commands or service transitions. After an upstream change lands, qq validates required behavior semantically against the configured branch rather than using commit ancestry.
