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

`GET /v1/security/posture` is node-local. Its `auth_mode` explicitly reports
whether authentication is enforced and whether platform-operator authorization
is required; development mode intentionally disables enforcement. Through the
Dev Hub `/ops` proxy, its direct response describes the control-plane leader,
while its separate fleet section is leader-observed gossiped evidence. Missing
support on old nodes is unavailable/unknown, never a healthy default.

For mesh KEM, the source of truth is completed rustls handshake metadata:

- live `X25519MLKEM768` hybrid sessions;
- live classical-X25519 fallback sessions;
- live unknown/unobservable sessions;
- observed connection totals and first/last observation timestamps.

An environment flag or provider selection alone never counts as evidence that
PQ key exchange protected a connection. The endpoint explicitly uses AWS-LC
and offers hybrid first, while retaining classical groups for mixed fleets.
Public HTTPS, database TLS, relay-client TLS, and other HTTP service TLS do
not inherit that iroh endpoint provider policy; they must not be represented
as universally ML-KEM protected without independent negotiated-session
telemetry and a compatible provider migration.

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

Bluetooth, mDNS, ZK, and SLH-DSA are unsupported or future work. There is no
defined ZK protocol or threat model. mDNS is not enabled by default; a future
trusted-LAN capability would need explicit interface and privacy controls.

## Endpoint scope, fleet reports, and mixed fleets

`GET /v1/security/posture` remains node-local and returns an `auth_mode`
object that says whether authentication is enforced and whether platform
operator authorization is required. In development, auth enforcement is
intentionally disabled; describing this endpoint as simply “operator-only” is
incorrect. The Dev Hub reads it through `/ops`, so its direct data is
leader-observed; its fleet panel is ordinary gossiped/replicated `NodeInfo`
evidence observed by that leader.

Node reports contain aggregate counters and selected state only: no peer
addresses, identities, keys, certificates, tickets, or connection metadata.
They are refreshed in the background, never by expensive request-path work.
Nodes that predate the report remain `unavailable`, not healthy.

Hybrid KEX is first in the offer. A live classical X25519 result is an
actionable mixed-fleet fallback, not a green result. Genuine hybrid/PQ
transport identity requires upstream iroh identity support; application-message
signatures cannot fake it. The existing enrollment and dual-signature flow can
require signatures for sensitive compatible gossip operations only after rollout
compatibility and enrollment are confirmed; it must not make mixed-version
fleets unavailable prematurely.
