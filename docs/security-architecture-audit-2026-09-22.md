# Security architecture audit — vs. the proposed "Layered Security Model"

- **Status**: Audit + targeted implementation, verified live. Not a certification document.
- **Date**: 2026-09-22 (backend), cross-checked against `docs/pqc-migration-scope.md` (2026-07-20) and `docs/COMPLIANCE_AUDIT.md` (prior pass).
- **Scope**: reconciles a proposed 7-layer diagram (Application / Identity & access control / Cryptographic agility / Encrypted iroh QUIC transport / Multi-path discovery / Trusted workload execution / Defense in depth) against this codebase as it actually runs, layer by layer. Every claim below is either cited to `file:line` or to a live command run this session — nothing here is aspirational unless explicitly labeled as such.

## How to read this document

Each layer gets one of three verdicts:

- **Real** — implemented and verified this session (code + a live run, not just a doc).
- **Real, narrower than the label suggests** — implemented, but the diagram's phrase overstates its scope; the correction is given inline.
- **Not implemented** — named in the diagram, absent from the code. Any UI/doc copy claiming otherwise must be corrected to match this document, not the other way around.

## Layer 3/4 — Cryptographic agility & Encrypted iroh QUIC transport

**Before this session**: `crates/hive-p2p` and `crates/hive-cloud` both declared `iroh = "1"` with no feature override. The vendored `iroh` crate's own default feature set (`vendor/iroh/Cargo.toml`) is `["metrics", "fast-apple-datapath", "portmapper", "tls-ring"]` — the mesh transport compiled with **only** the classical `ring` TLS backend. Zero post-quantum key exchange was offered, anywhere, by any node. `docs/pqc-migration-scope.md`'s Phase 0 was accurately described as "no code changes made."

**After this session**: hybrid post-quantum key exchange (X25519MLKEM768) is live on the fleet mesh transport.

- `crates/hive-p2p/Cargo.toml` now also enables iroh's `tls-aws-lc-rs` feature (alongside `tls-ring`, kept for classical fallback and the browser build), plus direct `rustls` (`aws_lc_rs`, `prefer-post-quantum`) and `noq` (`rustls`) dependencies pinned to the workspace-locked versions.
- `hive_p2p::bind_full` (`crates/hive-p2p/src/lib.rs`) now explicitly calls `.crypto_provider(pq_hybrid_crypto_provider())` before `.bind()`. This is load-bearing, not decorative: iroh's own `N0`/`Minimal` presets (`vendor/iroh/src/endpoint/presets.rs`) **prefer plain ring whenever both TLS backends are compiled in** — which they now always are, workspace-wide, once any crate enables `tls-aws-lc-rs` (Cargo feature unification). Relying on the feature flag alone, without this explicit call, would have silently shipped zero PQ protection — exactly the trap `docs/pqc-migration-scope.md` names as "feature unification re-enables ring."
- `pq_hybrid_crypto_provider()` builds its `kx_groups` list explicitly — `[X25519MLKEM768, X25519, SECP256R1, SECP384R1]` — rather than trusting `aws_lc_rs::default_provider()`'s own ordering, which depends on whether rustls's `prefer-post-quantum` cargo feature happened to be feature-unified on by some other crate in the graph. The explicit list needs no such trust and matches iroh's own documented recipe (`vendor/iroh/examples/prefer-pq-key-exchange.rs`).
- `vendor/guardian-db/src/p2p/network/core/mod.rs`'s own, separate iroh endpoint (GuardianDB's replication mesh — see the Discovery section below) gets the identical treatment: a duplicated `guardian_pq_hybrid_crypto_provider()` (guardian-db is vendored and does not otherwise depend on `hive-p2p`) wired into its own `Endpoint::builder(...)`.

### Negotiated-handshake telemetry (never an env-flag proxy)

A `HIVE_GOSSIP_SIGN`-style flag says nothing about what a given peer actually negotiated. `hive_p2p::PqKexStats` (mirroring the existing `VerifyStats` pattern, surfaced the same way) reads the **real** result off each connection's completed TLS handshake:

```
noq_proto::crypto::rustls::HandshakeData::negotiated_key_exchange_group: Option<rustls::NamedGroup>
```

recorded once per genuinely new connection — the inbound accept path (`serve_tunnels_full`) and the one place `PeerPool` mints a fresh trunk (`PeerPool::acquire`'s success branch), never on a reused trunk. `GET /v1/relay` (operator-only) now reports `pq_kex: {hybrid_pq, classical_fallback, unknown}` alongside the existing `gossip_verify` block.

### Live verification (not simulated, not asserted)

Two real `hive-p2p` endpoints (`crates/hive-p2p/src/bin/p2p_demo.rs`, unmodified in the committed tree — the print statements used to read the counters were added, run, and reverted; `git diff` on the file is empty) exchanged five real HTTP requests over a real iroh QUIC tunnel, twice:

| Run | Node A provider | Node B provider | Result | `pq_kex_stats()` |
|---|---|---|---|---|
| 1 | `pq_hybrid_crypto_provider()` (this change) | `pq_hybrid_crypto_provider()` | 5/5 requests, 200 | `(hybrid_pq=1, classical_fallback=0, unknown=0)` |
| 2 | `rustls::crypto::ring::default_provider()` (forced classical, zero PQ support — simulating an unrolled peer) | `pq_hybrid_crypto_provider()` | 5/5 requests, 200 | `(hybrid_pq=0, classical_fallback=1, unknown=0)` |

Run 2 is the mixed-fleet proof the rollout needs: a peer that cannot speak `X25519MLKEM768` at all still completes a normal handshake and serves traffic — TLS 1.3 group negotiation falls back automatically, flag-day-free, exactly as `docs/pqc-migration-scope.md` predicted. Both runs are real crypto-library behavior on a real connection, not a mock.

### What this does — and does not — claim

- **Does**: close the harvest-now-decrypt-later exposure on the mesh transport (tenant env secrets, `store_sync` contents, TLS private-key bundles in transit over iroh QUIC — `docs/pqc-migration-scope.md`'s "top HNDL asset").
- **Does not**: make transport **identity** post-quantum. `iroh::EndpointId` is `iroh_base::PublicKey`, a 32-byte ed25519 key (`~/.cargo/registry/.../iroh-base-1.0.2/src/key.rs`), unchanged. ML-KEM is a **key-exchange** primitive; it says nothing about who you're talking to. Phase 1/2 of the RFC (ML-DSA enrollment, dual-signed gossip, eventual transport-identity migration) remain **entirely unimplemented** — confirmed this session by an exhaustive repo-wide search for `ml_dsa|MLDSA|ML-DSA|pq_pub|mldsa`: every real hit lives inside `docs/pqc-migration-scope.md` itself, phrased as a future phase, never as something already shipped. **No document, comment, or UI string anywhere in this repo may say "ML-DSA transport identity," "post-quantum identity," or similar — say "hybrid post-quantum key exchange," never more.**

### Boundary: what stays classical, deliberately, and why

Not every TLS leg in this platform got this treatment tonight, and that is a considered decision, not an oversight left undocumented:

| Leg | Provider | Why left alone |
|---|---|---|
| Public dashboard/API HTTPS (`main.rs:2055`, `acme::server_config()`) | `ring`, via an explicit process-wide `rustls::crypto::ring::default_provider().install_default()` (`main.rs:428/2054/3077`, `acme.rs:854/1061`) | External client compatibility. This TLS terminates connections from arbitrary browsers and third-party API clients across the whole internet — a materially larger, less controllable compatibility surface than the mesh (fleet-controlled peers only, verified by the two-run test above). Migrating it needs its own browser/client compatibility pass, not a same-night change riding on the mesh work. |
| DB gateway TLS (Postgres/Redis wire, `db_gateway.rs`'s `TlsAcceptor::from(acme::db_server_config())`) | `ring`, same global default | Same external-client-compatibility reasoning — arbitrary tenant DB clients, not fleet-controlled peers. |
| Standalone/embedded `iroh-relay` binaries' own outer HTTPS (the relay↔client leg, not the inner QUIC session it forwards) | `ring` (no explicit feature override found in `ansible/roles/*` relay build steps) | The RFC's own point stands: relayed traffic's **inner** QUIC session — the one actually carrying tenant data — is already hybrid-PQ per the mesh work above. The relay's own outer TLS is lower marginal value and shares the external-interop caution. |
| `crates/hive-browser` (wasm32, runs inside a tenant's browser tab) | `tls-ring` only (`Cargo.toml:31`) | **Permanent boundary, not a gap.** `hive-browser` builds for `wasm32-unknown-unknown` (confirmed: `Cargo.toml:9,13`, `cdylib`, `wasm-bindgen`). aws-lc-rs's C/assembly cryptography (`aws-lc-sys`) has no support for that target — verified via aws-lc-rs's own platform-support documentation: it has added *experimental* `wasm32-unknown-emscripten` support (a POSIX-emulated environment, with aws-lc-rs's own docs disclosing no FIPS mode, dependence on the runtime's `getentropy()`, and no side-channel protections even there) — a different, incompatible target from the sandboxed `wasm32-unknown-unknown` a browser tab actually runs. There is no safe path to aws-lc-rs here today. |

None of these are claimed as post-quantum anywhere. `pqc-boundary-audit-https-db-relay-internal-tls` (PRD) tracks revisiting the public-HTTPS/DB-gateway leg as its own, separately-scoped and separately-tested effort.

## Layer 2 — Identity and access control

Re-verified this session (a dedicated pass re-checking `docs/COMPLIANCE_AUDIT.md`'s claims against current code, not a re-run of that whole audit):

- **Ed25519 mesh identity + peer trust allowlist** fails closed on an empty/misconfigured set — `hive-p2p/src/lib.rs`'s `peer_trusted` returns `false`, not `true`, when the trust set is empty; `serve_fleet_conn` drops every non-`STREAM_JOIN` stream under that condition. Confirmed unchanged from the RFC's own T4 finding.
- **Dual-signed gossip / mesh mutation authorization** — `mesh_mutation_authorized` (`gossip.rs`) is enforced at the single chokepoint every live call path funnels through (`handler()` before `dispatch_verified`). One latent footgun found and **not** silently worked around: `gossip::dispatch()` (a second, unguarded entry point into the same dispatch table) currently has **zero callers anywhere in the repo** — dead code today, but a future caller reaching for it instead of the guarded wire path would silently bypass the trust check. Tracked as `gossip-dispatch-dead-code-bypass-footgun` (PRD) rather than patched blind, since the right fix depends on knowing its intended future caller.
- **JWT/session (`platform_admin`) and `/v1/token`** — `platform_admin` still fails closed by `#[serde(default)]`, is always server-derived (never client-asserted), API-key issuance hardcodes `platform_admin: false`, `/v1/token` still rate-limits (20/60s) and constant-time-compares `HIVE_INTERNAL_TOKEN`. Unchanged from `docs/COMPLIANCE_AUDIT.md`'s findings #2/#8.
- **Tenant/role checks** — a broad re-sample of mutating handlers (databases, teams, queues, drive, storage snapshots, domains, sandboxes, project network config, billing grants), prioritizing surfaces added since the last audit pass via commit history, found no handler bypassing the established `require_project`/`require_team`/`require_domain_owner`/`require_operator` pattern. No new gap found; nothing to fix.
- **"MDAS abstraction"** — this term does not appear anywhere in this codebase (0 hits). Treat it as undefined external terminology; nothing in this platform implements a protocol by that name, and no doc/UI in this repo should invent one to match a diagram label. If the diagram's author can supply what MDAS is meant to denote, it can be evaluated on its own merits — until then it names nothing real here.

## Layer 5 — Multi-path discovery

Verified this session against current code (not just AGENTS.md's own prose, which the check treated as a claim to re-confirm, not a source of truth):

- **Mainline DHT** (`crates/hive-p2p/src/dht.rs`) — client-mode only (no `server_mode()` call anywhere), `HIVE_DHT_PUBLISH_DIRECT` gates publishing a node's own direct address, RFC1918/CGNAT/link-local addresses are filtered before publish via a DHT-scoped filter (never the endpoint-level `addr_filter()`, which would also strip the Seer pkarr publisher), every DHT failure path degrades to a `WARN` with the provider left unregistered — never a failed `bind()`.
- **pkarr** publish/resolve is real on both the node side (`bind_full` registers a real `PkarrPublisher`+`PkarrResolver` per `HIVE_DISCOVERY_DNS` URL) and the relay side (`crates/hive-cloud/src/discovery.rs`, a genuine ed25519-verifying pkarr relay implementation). **Naming correction**: this file is explicitly *not* "Seer" by its own doc comment — Seer (Plane A) is the authoritative tenant-facing DNS server in `dnsserver.rs`; `discovery.rs` is the separate node-to-node pkarr relay (Plane B). Keep the two apart in any future doc.
- **Relays** — the embedded relay (port 3341 default) and standalone `iroh-relay` binaries are real; relay-addressed bootstrap-peer format (`<64hex-id>[@ip:port…][|relay-url]`) is unchanged and still supported.
- **n0 discovery** wiring (`HIVE_DISCOVERY_N0`/`HIVE_DISCOVERY_DNS`/`HIVE_DISCOVERY_ADDR`/`HIVE_DISCOVERY_IPS`) confirmed against current `main.rs`; two of those four names are NOT what they sound like (`HIVE_DISCOVERY_ADDR` binds this node's *own* pkarr relay server, not a discovery-provider selector; `HIVE_DISCOVERY_IPS` feeds DNS-record publishing in `vercel_dns.rs`, not `bind_full`) — worth fixing the naming in a future pass, not attempted here.
- **Bluetooth: not implemented, confirmed exhaustively.** A full-tree, case-insensitive search for the literal string and for every common Bluetooth-crate name (`btleplug`, `bluer`, `windows-bluetooth`, `core-bluetooth`, `bluetooth-serial`, `rumble`, `simpleble`) across all 1,879 non-binary git-tracked files returned **zero matches**. No crate dependency, no code, no comment, no doc reference anywhere. **Any diagram or doc naming Bluetooth as a discovery mechanism is factually wrong and must have that line removed or corrected.**
- **mDNS: real, but scoped to exactly one place — GuardianDB's own internal replication mesh, not the tenant-facing platform mesh.** `crates/hive-cloud/src/guardian.rs` enables `enable_discovery_mdns: true` with a real, cryptographically authenticated `MdnsDiscoveryAuth` (a per-fleet BLAKE3-derived keyed tag over each node's EndpointId, verified twice independently before a peer is ever admitted) on a **second, entirely separate iroh endpoint** — GuardianDB's own docs/blobs/KV replication transport, bound with its own secret key, independent of `hive_p2p::bind_full`'s tenant-facing mesh. The primary request-routing mesh has zero mDNS wiring anywhere in `hive-p2p`. The underlying transport is standard link-local multicast — unreachable outside the local L2 segment, and even an on-segment attacker cannot forge a valid membership tag without the fleet's own secret-derived key material. **Correct characterization for the diagram**: "LAN discovery" is real for GuardianDB's internal replication only, authenticated, not a general platform-wide discovery layer — neither a blanket "yes" nor a blanket "no" is accurate.
- **No-partition invariants** — re-confirmed live in code, not assumed from AGENTS.md's prose: every discovery source in `bind_full` is additive (repeated `.address_lookup(...)` calls, no source ever removes another); relay-addressed seeds are always kept even when private addresses are filtered out (`TransportAddr::Relay(_) => true` unconditionally); `PeerPool::acquire`/`dial_fresh` apply no subtractive address filter at all; the historical `retain_dialable` partition bug's function no longer exists anywhere in the codebase, surviving only as a cautionary comment with its own low, explicit backoff cap.

## Layer 6/7 — Trusted workload execution & Defense in depth

Out of scope for this pass (the user's brief prioritized PQC transport, identity/authz, and discovery specifically). `docs/COMPLIANCE_AUDIT.md` already covers a substantial, separately-verified defense-in-depth pass (CSP/HSTS/Permissions-Policy, rate limiting, XFF trust boundary, admin auth, secret redaction, and more); AGENTS.md's "Litebox" and "PVM kernels" sections cover the workload-isolation posture (Firecracker → Litebox → Mock ranked selection, with an explicit, honest "not Firecracker/gVisor-grade" disclosure for Litebox) in more depth and more currency than this document would add by restating it.

## Bottom line for the proposed diagram

| Diagram line | Verdict |
|---|---|
| Cryptographic agility: TLS 1.3, ML-KEM, future suites | **Real, mesh transport only** — hybrid X25519MLKEM768 live and verified this session. Public HTTPS/DB/relay-client TLS stay classical, documented above, not silently claimed otherwise. |
| Encrypted iroh QUIC transport | **Real** — always was (TLS 1.3, ed25519 RPK), now additionally PQ-hybrid on the key-exchange leg. |
| Multi-path discovery: pkarr, relays, DHT | **Real**, as described in AGENTS.md and re-confirmed above. |
| Multi-path discovery: mDNS | **Real, narrower than "LAN discovery" implies** — GuardianDB's own replication mesh only, authenticated, not the tenant-facing platform mesh. |
| Multi-path discovery: Bluetooth | **Not implemented.** Remove or correct this line. |
| "ML-DSA transport identity" / "MDAS abstraction" (if present anywhere) | **Not implemented / undefined.** iroh `EndpointId` is, and remains, a 32-byte ed25519 public key. Do not claim otherwise anywhere in docs or UI. |
