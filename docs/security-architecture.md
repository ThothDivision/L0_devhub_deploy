# Hive security architecture

This is the authoritative replacement for the old “Layered Security Model”
diagram. The Dev Hub’s **Security architecture** view uses the same labels and
reports only observed or selected runtime state. A green/active layer is not a
global “secure” assertion.

## Layers and current capability

| Layer | Capability | State | Boundary |
|---|---|---|---|
| Application security | Tenant-scoped APIs, session/JWT checks, role-gated operator routes | Partial | Application authorization is a code-level control; this does not prove every tenant workload or route is defect-free. |
| Ed25519 transport identity + ML-DSA-44 gossip signatures | Ed25519 iroh endpoint admission; ML-DSA-44 enrollment and dual-signed gossip v2 | Partial | Iroh transport identity remains Ed25519. ML-DSA applies only to verified v2 gossip requests, not raw streams, relay handshakes, tickets, or responses. |
| Cryptographic agility | TLS 1.3 with explicit AWS-LC provider; `X25519MLKEM768` offered before classical groups | Partial / observed per session | Hybrid KEM protects session-key confidentiality against harvest-now-decrypt-later risk when it is actually negotiated. It does not make endpoint identity post-quantum. Old peers may negotiate X25519. |
| Encrypted iroh QUIC transport | Authenticated, encrypted iroh QUIC mesh | Active where an endpoint is bound | The transport authentication anchor is Ed25519, pending a safe upstream iroh identity abstraction. |
| Discovery and relay resilience | Relay-addressed bootstrap, pkarr/Seer, optional n0 discovery, optional Mainline DHT | Partial | Providers are additive; none is a membership authority or an availability guarantee. Bluetooth and mDNS are **not implemented**. |
| Data synchronization | GuardianDB/document and browser cr-sqlite CRR lanes; leader-driven wholesale store synchronization | Partial | CRDT conflict behavior is lane-specific. Snapshot/wholesale state adoption is not CRDT replication. |
| Execution lanes | Firecracker/KVM microVM; Litebox syscall mediation + seccomp fallback; host-container runtime; mock/host-process development runtime | Partial | Only Firecracker/KVM is eligible for a strong microVM claim. Litebox is partial and is not confidential computing, hardware isolation, Firecracker, or gVisor. Containers do not inherit a Firecracker claim. |

## What operators can observe

`GET /v1/security/posture` is operator-only. Its direct layers are node-local;
through the Dev Hub `/ops` proxy they describe the control-plane leader. The
same response includes `leader_observed_fleet`, an aggregate-only summary of
compact posture gossip visible to that leader. Missing support on old nodes is
unavailable/unknown, never a healthy default.

`GET /v1/security/posture/fleet` is also operator-only. It is a
**leader-observed aggregate** of compact, self-reported gossip summaries, not
a direct fleet-wide cryptographic measurement or cryptographic attestation.
It contains only aggregate counts and provider/backend states: no endpoint or
peer IDs, addresses, certificates, handshake bytes, keys, secrets, or
per-peer topology. Nodes without the summary capability are counted as
unknown/mixed-version. Missing KEM telemetry is unknown, never evidence of
classical or hybrid operation.

For mesh KEM, the source of truth is completed rustls handshake metadata:

- live `X25519MLKEM768` hybrid sessions;
- live classical-X25519 fallback sessions;
- live unknown/unobservable sessions;
- observed connection totals and first/last observation timestamps.

An environment flag or provider selection alone never counts as evidence that
PQ key exchange protected a connection. The endpoint explicitly uses AWS-LC
and offers hybrid first, while retaining classical groups for mixed fleets.
Public HTTPS/raw HTTPS, database TLS, relay TLS, and internal HTTPS do not
inherit the iroh endpoint provider policy. The posture names them separately
as `configured_only_unsupported` or `unknown_unobservable` until that exact
surface uses an ML-KEM-capable provider and records completed-handshake
metadata. They must not be described as PQ-protected before then.

## Diagram and architecture mapping

The following is the implementation-aligned mapping for architecture/security
diagrams:

| Diagram layer | Actual implementation boundary |
|---|---|
| Identity | Endpoint identity is Ed25519. ML-DSA-44 is limited to dual-signed gossip and does not replace endpoint identity elsewhere. |
| Key establishment | `X25519MLKEM768` is claimed only for completed sessions with negotiated-KEM telemetry. Missing telemetry is unknown. |
| Data protection | iroh QUIC provides transport/session encryption for its established sessions. |
| Discovery | Relay, configured bootstrap peers, pkarr, n0, and Mainline DHT are additive recovery/discovery paths, not availability guarantees. |
| Synchronization | CRDT reconciliation is lane-specific. Other platform stores use leader-driven wholesale replacement; there is no platform-wide automatic CRDT conflict resolution. |
| Execution | Firecracker/KVM is the strong microVM boundary. Litebox provides syscall mediation plus seccomp only. Containers are host containers, not microVMs. |

The following claims are unsupported by the current implementation or not
implemented and must not appear as active architecture capabilities:

- SLH-DSA is active — unsupported by the current implementation.
- Bluetooth discovery is active — not implemented.
- mDNS discovery is active — not implemented.
- ZK hybrid TLS exists — not implemented.
- Litebox is a trusted or confidential execution environment — unsupported by
  the current implementation.
- Litebox is equivalent to Firecracker or gVisor — unsupported by the current
  implementation.
- The platform provides universal automatic CRDT conflict resolution —
  unsupported by the current implementation.

## Deliberate non-claims

- No post-quantum iroh transport identity is available today: EndpointId and
  transport authentication remain Ed25519. This requires upstream iroh support,
  not a local identity fork.
- ML-DSA enrollment is not “ML-DSA transport identity.”
- Discovery improves recovery paths but cannot guarantee availability; relay,
  DNS, DHT, peer configuration, and network health remain operational
  dependencies.
- Litebox is not a Firecracker/gVisor substitute and must not be classified as
  trusted, confidential, or hardware-isolated execution.
- Containers run on the host runtime and receive no Firecracker claim.
- The relational mirror retains its explicit transaction and read-only
  invariants; it is not evidence that all platform data has CRDT conflict
  resolution.

## Evidence classes and corrected capability matrix

The following matrix supersedes any broad reading of the layers above. Every
security claim is scoped to its stated evidence; a configured feature is not
evidence that it has negotiated or protected traffic.

| Evidence class | Meaning |
|---|---|
| `negotiated` | Recorded by a completed rustls/QUIC handshake or ML-DSA dual-signature verification. |
| `configured` | Local configuration or a registered provider was read. It is not proof of use. |
| `selected` | The local process selected an execution backend. It is not a claim about other lanes. |
| `unavailable` | No compatible report, measurement, or runtime configuration exists. Never treat this as healthy. |
| `unsupported` | Not implemented. |

| Capability | Protects | Does not protect | Scope / evidence |
|---|---|---|---|
| Ed25519 transport identity + ML-DSA-44 gossip signatures | Iroh endpoint admission and compatible dual-signed gossip requests. | Raw streams, relays, tickets, responses, or PQ transport identity. | Endpoint identity remains Ed25519. ML-DSA counters are `negotiated`. |
| `X25519MLKEM768` hybrid KEX | Confidentiality of the mesh session that negotiated it. | Endpoint identity or public HTTPS/database/relay TLS. | `negotiated` completed-handshake metadata; offered first. |
| Firecracker/KVM microVM | Function workloads executing in the Firecracker lane. | Containers and all other lanes. | `selected`; this is the sole green/strong microVM claim. |
| Litebox syscall mediation + seccomp fallback | Its supported function process receives syscall mediation and a seccomp-bpf backstop. | Confidential computing, hardware isolation, Firecracker, gVisor, JIT syscall gaps, and the unsandboxed build lane. | `selected`, always partial/amber. Guest and enforcement share an address space. |
| Host-container runtime | Only hardening that is concretely measured from its active runtime configuration. | Firecracker isolation by inheritance. | `unavailable` until measured. |
| Mock/host-process development runtime | Development execution with best-effort limits. | Production isolation. | `selected`; unavailable for microVM claims. |
| Discovery | Additional recovery paths from bootstrap, pkarr/Seer, n0, and Mainline DHT. | Availability guarantees or membership authority. | Provider state is `configured`; resolve hits/errors show observed utility. |
| Synchronization | Defined conflict handling in GuardianDB document and browser cr-sqlite CRR lanes. | Platform-wide CRDT behavior. | Leader-driven wholesale replacement is not CRDT. |

Bluetooth, mDNS, ZK, and SLH-DSA are unsupported by the current
implementation. There is no defined ZK protocol or threat model.

## Endpoint scope, fleet reports, and mixed fleets

`GET /v1/security/posture` remains operator-only and node-local. The Dev Hub
reads it through `/ops`, so its direct data is node-local evidence from the
current leader. The separately requested
`/v1/security/posture/fleet` aggregate is ordinary gossiped `NodeInfo`
evidence observed by that leader, not a direct measurement.

Posture summaries contain aggregate counters and selected state only: no peer
addresses, identities, keys, certificates, tickets, or connection metadata.
They are refreshed in the background, never by expensive request-path work.
Nodes that predate the summary remain `unavailable`, not healthy.

Hybrid KEX is first in the offer. A live classical X25519 result is an
actionable mixed-fleet fallback, not a green result. Genuine hybrid/PQ
transport identity requires upstream iroh identity support; application-message
signatures cannot fake it.

## Privileged mesh envelope rollout

The existing enrollment is reused for a version-3 privileged mesh envelope.
Its dual signatures are Ed25519 plus ML-DSA-44 and are domain-separated from
gossip v2. It signs the protocol version and algorithm suite, transport-bound
sender, enrolled-key reference, timestamp, nonce, method/path, and SHA-256
digest of the authenticated body. The receiver verifies that the enrolled key
is already cross-bound to the authenticated iroh identity, rejects unknown
mandatory versions, key/signer substitution, digest mismatch, stale messages,
and seen nonces. This is defense in depth for application mesh requests; it
does not replace transport admission or route-level authorization.

The generic mesh request channel carries membership/enrollment, control-plane
leader/epoch operations, deployment fanout, database-owner/Hrana proxy
requests, and browser-admission operations. Consequently v3 protects those
requests without changing leader routing, database owner routing, or database
token checks. Browser capabilities remain additionally bound by their existing
handler to endpoint identity, tenant, descriptor/policy digest, scope, lease,
and exact serialized contents.

Default behavior is compatibility-first: v3 is sent only when
`HIVE_PQC_PRIVILEGED_ENVELOPE=1` and the peer has a validated v3 enrollment;
otherwise legacy/v2 behavior remains available and is counted. Required mode
is intentionally opt-in and scoped: set `HIVE_PQC_REQUIRED_PATHS`, an explicit
future `HIVE_PQC_REQUIRED_NOT_BEFORE_MS`, and
`HIVE_PQC_REQUIRED_EVIDENCE_CONFIRMED=1` only after operators confirm fresh,
complete compatible evidence for every required participant. Optional
`HIVE_PQC_COMPAT_PATHS` exceptions work only before their explicit
`HIVE_PQC_COMPAT_EXPIRES_MS`; absent or invalid expiry does not preserve an
exception. When active, refusal is limited to the named operation
(`PQC_REQUIRED_INCOMPATIBLE`); it never gates endpoint bind, discovery,
bootstrap, or unrelated mesh traffic.

Operator sequence: observe negotiated per-surface evidence; remove known
classical fallback where a surface can safely do so; confirm all required
participants report fresh, complete compatible evidence; enable one scoped
required policy with a dated exception if necessary; then monitor counters and
revert the scoped policy if compatibility regresses. Unknown, unavailable,
stale, or missing gossip posture blocks promotion rather than counting as
compatible.
