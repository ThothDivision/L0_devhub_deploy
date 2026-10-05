# Marketplace game hosting integration: current gate

Reviewed 2026-10-05 against DevHub `8481c1a` and the Marketplace source in `ThothDivision/autheo_marketplace_deploy`. **No game-server Marketplace checkout was deployed or charged.** The new Terraria and Factorio templates are ordinary image deployments; they do not attach a Marketplace order or enforce a paid placement policy.

## Evidence

- DevHub Rust CI [run 37363947832](https://github.com/ThothDivision/L0_devhub_deploy/actions/runs/37363947832): `build + unit tests` succeeded. CLI acceptance finished with 34 passes and one failure: deployment was not listed after restart; its logs report refusal to restore a Ready deployment without published acceptance evidence and port 80/443 binding permission errors. Security and core jobs were cancelled. This is not a game-server smoke test; do not infer live readiness from compilation.
- Marketplace's 59 tests, type-check and lint passed locally; their DB/Clerk/DevHub integration is mocked. `autheo.dev` could not be reached from the gateway, `marketplace.autheo.dev` did not resolve, and `shadw.app` returned 503. The paired Windows node and gateway exposed no Docker/Podman. There was no disposable authenticated DevHub test target; no server image or client was launched.
- Marketplace accepts `game_hosting` listings but a verified provider, activated binding and healthy DevHub advertisement are required before a quote. Demo cards are not purchasable capacity.

## Blockers

1. **Incompatible placement contract:** Marketplace returns string versions, plural `regions`, `resource_requirements` and THEO `commercial_limits`; `ui/lib/marketplace-placement-policy.ts` requires numeric versions, singular `region`, `resources` and fiat `commercial.price_cents`. The current strict validator rejects the Marketplace policy. Define a jointly versioned THEO-native contract and test both sides; do not bypass the validator or silently translate THEO to cents.
2. **Image deployment bypasses Marketplace policy:** `ui/app/api/marketplace/deploy/route.ts` forwards authenticated policy only to `/v1/git/deploy`, not `/v1/deploy/image`. The new game-template cards deploy through the latter; they must not be shown as paid Marketplace deployments until a buyer/order-bound image path passes the same policy gate.
3. **No usage-based THEO settlement:** Marketplace quotes prepay quantity × duration; its usage records are audit entries and were buyer-submitted, not independently attested. DevHub's existing compute meter bills separately in cents. An active server, metered lease, signed intervals, cap, wallet authorization, dispute policy and renewal/termination semantics are needed before claiming per-use THEO charging. Never bill twice across the DevHub and Marketplace ledgers.
4. **Preferred network and stateful placement:** Current Marketplace policy approves a particular node/region but offers no buyer-tunable network selector; image deployments have no linked placement snapshot. Persist a selected healthy region/node under an immutable policy and keep its world volume attached to that node. Reject reassignment without a verified world migration; verify both 7777/TCP and 34197/UDP from real clients.

## Next test environment

Create an explicitly disposable DevHub test control plane (or separately authorized sandbox), with a reachable container node, capped budget, test tenant and off-node backup. Test image launch, world persistence, raw-port reachability, restart and mod/version changes **before** enabling a checkout. Then run a separate Autheo Testnet flow with a participant-controlled test wallet and capped payment; verify HMAC auth, provider/fee split, receipt confirmations, allocation, lease and metered usage. Production credentials, real funds and customer worlds are out of scope for smoke testing. See [game-server-mod-version-plan.md](game-server-mod-version-plan.md) for the per-game checklist.
