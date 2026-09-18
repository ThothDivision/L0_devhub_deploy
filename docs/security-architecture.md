# Hive security architecture

This is the authoritative replacement for the old “Layered Security Model”
diagram. The Dev Hub’s **Security architecture** view uses the same labels and
reports only observed or selected runtime state. A green/active layer is not a
global “secure” assertion.

## Layers and current capability

| Layer | Capability | State | Boundary |
|---|---|---|---|
| Application security | Tenant-scoped APIs, session/JWT checks, role-gated operator routes | Partial | Application authorization is a code-level control; this does not prove every tenant workload or route is defect-free. |
| Identity, tenant authorization, and peer trust | Ed25519 iroh endpoint admission; ML-DSA-44 enrollment and dual-signed gossip v2 | Partial | Iroh transport identity remains Ed25519. ML-DSA applies only to verified v2 gossip requests, not raw streams, relay handshakes, tickets, or responses. “MDAS” is not a Hive protocol or capability. |
| Cryptographic agility | TLS 1.3 with explicit AWS-LC provider; `X25519MLKEM768` offered before classical groups | Partial / observed per session | Hybrid KEM protects session-key confidentiality against harvest-now-decrypt-later risk when it is actually negotiated. It does not make endpoint identity post-quantum. Old peers may negotiate X25519. |
| Encrypted iroh QUIC transport | Authenticated, encrypted iroh QUIC mesh | Active where an endpoint is bound | The transport authentication anchor is Ed25519, pending a safe upstream iroh identity abstraction. |
| Discovery and relay resilience | Relay-addressed bootstrap, pkarr/Seer, optional n0 discovery, optional Mainline DHT | Partial | Providers are additive; none is a membership authority or an availability guarantee. Bluetooth and mDNS are **not implemented**. |
| Data synchronization | GuardianDB/document and browser cr-sqlite CRR lanes; leader-driven wholesale store synchronization | Partial | CRDT conflict behavior is lane-specific. Snapshot/wholesale state adoption is not CRDT replication. |
| Workload isolation | Firecracker/KVM microVMs; Litebox fallback; mock and host-container lanes | Partial | Firecracker/KVM is the strong microVM lane. Litebox is syscall mediation plus seccomp, not confidential computing or hardware isolation. Host containers are not Firecracker microVMs. |

## What operators can observe

`GET /v1/security/posture` is operator-only and node-local. It includes an
explicit `scope: "node"` and timestamps. Through the Dev Hub `/ops` proxy it
describes the control-plane leader’s process, not the whole fleet. Missing
support on old nodes is unknown/unsupported, never a healthy default.

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
