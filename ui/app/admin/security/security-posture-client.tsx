"use client";

import { Activity, AlertTriangle, ChevronDown, Layers3, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge, Card, PageHeader } from "@/components/ui";
import { type NodeSecurityEvidence, type SecurityEvidenceClass, type SecurityLayer, type SecurityLayerStatus, type SecurityPosture, useOpsPoll } from "@/lib/api";

const layers: Array<{ key: keyof SecurityPosture["layers"]; label: string; subtitle: string }> = [
  { key: "application", label: "Application security", subtitle: "Authenticated platform controls and tenant-scoped APIs" },
  { key: "identity", label: "Ed25519 transport identity + ML-DSA-44 gossip signatures", subtitle: "Endpoint identity remains Ed25519; ML-DSA signs compatible gossip only" },
  { key: "cryptography", label: "Cryptographic agility", subtitle: "TLS 1.3 hybrid KEM evidence, not configuration claims" },
  { key: "transport", label: "Encrypted iroh QUIC transport", subtitle: "Authenticated, encrypted mesh transport" },
  { key: "discovery", label: "Discovery and relay resilience", subtitle: "Additive paths for recovery and reachability" },
  { key: "synchronization", label: "Data synchronization", subtitle: "CRDT lanes are distinct from wholesale snapshots" },
  { key: "workload_isolation", label: "Workload isolation", subtitle: "Selected execution backend, not a global promise" },
];

const statusTone: Record<SecurityLayerStatus, "green" | "amber" | "blue" | "red" | "default"> = {
  active: "green",
  partial: "amber",
  "classical fallback": "blue",
  "not configured": "default",
  unsupported: "default",
  degraded: "red",
  "not applicable": "default",
};
const evidenceTone: Record<SecurityEvidenceClass, "green" | "amber" | "blue" | "red" | "default"> = {
  negotiated: "green", configured: "blue", selected: "blue", unavailable: "amber", unsupported: "default",
};

function humanTime(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : "No observed event";
}

export function SecurityPostureClient({ initial }: { initial: SecurityPosture | null }) {
  const { data, error } = useOpsPoll<SecurityPosture>("/v1/security/posture", 5_000, true, initial);
  const [expanded, setExpanded] = useState<string | null>("cryptography");
  const crypto = data?.layers.cryptography;
  const fleet = data?.fleet;

  return (
    <div>
      <PageHeader
        title="Security architecture"
        desc="Evidence-based operational posture. A green negotiated claim is scoped to the reported lane, not a fleet certification."
        action={data ? <Badge tone="blue">/ops leader-observed · {data.node}</Badge> : undefined}
      />
      {!data || !crypto ? (
        <Card className="text-sm text-secondary">{error ? "Posture data is unavailable. The operator endpoint may be unreachable or this node may not support it." : "Loading live posture…"}</Card>
      ) : (
        <>
          <Card className="mb-5 border-amber-500/30 bg-amber-500/5 text-sm">
            <div className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> Scope and authorization</div>
            <p className="mt-1 text-secondary">This page is read through <code>/ops</code>, so the direct response is the current leader’s node-local view. The fleet section is replicated/gossiped evidence observed by that leader.</p>
            <p className="mt-2 text-secondary">{data.auth_mode?.detail ?? "Auth mode is unavailable from this pre-upgrade response; do not infer operator enforcement."}</p>
          </Card>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Metric label="Hybrid sessions" value={crypto.live_hybrid_sessions} tone="green" />
            <Metric label="Classical fallback" value={crypto.live_classical_sessions} tone="blue" />
            <Metric label="Unknown sessions" value={crypto.live_unknown_sessions} tone="amber" />
            <Metric label="Observed connections" value={crypto.total_observed_connections} />
            <Metric label="Last verified" value={crypto.last_verified_ms ? new Date(crypto.last_verified_ms).toLocaleTimeString() : "—"} />
          </div>
          {fleet ? <FleetEvidence fleet={fleet} /> : <Card className="mb-5 text-sm text-secondary">Fleet evidence is unavailable from this node. During a rolling upgrade, absent node reports are unknown—not healthy.</Card>}

          <Card className="mb-5 overflow-hidden p-0">
            <div className="border-b border-border bg-subtle/50 px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="h-4 w-4" /> Architecture and execution lanes</div>
              <p className="mt-1 text-xs text-secondary">A visual map of real runtime evidence and explicit boundaries.</p>
            </div>
            <div className="relative mx-auto max-w-3xl px-5 py-5">
              <div className="absolute bottom-8 left-1/2 top-8 w-px bg-border" aria-hidden />
              <ol className="relative space-y-2">
                {layers.map(({ key, label, subtitle }, index) => {
                  const layer = data.layers[key] as SecurityLayer;
                  const open = expanded === key;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : key)}
                        aria-expanded={open}
                        className="relative grid w-full grid-cols-[2.25rem_1fr_auto] items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left shadow-sm transition-colors hover:bg-subtle"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-bg font-mono text-xs text-muted">{index + 1}</span>
                        <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-secondary">{subtitle}</span></span>
                        <span className="flex items-center gap-2">{layer.evidence ? <Badge tone={evidenceTone[layer.evidence]}>evidence: {layer.evidence}</Badge> : null}<Badge tone={statusTone[layer.status]}>{layer.status}</Badge><ChevronDown className={`h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} /></span>
                      </button>
                      {open ? <LayerDetail layer={layer} layerKey={key} /> : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Activity className="h-4 w-4" /> Security activity</h2>
              <p className="mt-1 text-xs text-secondary">Events observed by {data.node}; no peer identities or addresses are exposed.</p>
              <div className="mt-4 space-y-3 border-l border-border pl-4 text-sm">
                <Timeline label="First hybrid KEM session" value={humanTime(crypto.first_hybrid_activation_ms)} active={!!crypto.first_hybrid_activation_ms} />
                <Timeline label="Latest negotiated-KEM observation" value={humanTime(crypto.last_verified_ms)} active={!!crypto.last_verified_ms} />
                <Timeline label="ML-DSA gossip verification" value={`${data.layers.identity.gossip_v2_verified} verified messages`} active={data.layers.identity.gossip_v2_verified > 0} />
                <Timeline label="DHT / discovery evidence" value={`${data.layers.discovery.providers.mainline_dht.resolve_hits ?? 0} DHT resolve hits`} active={(data.layers.discovery.providers.mainline_dht.resolve_hits ?? 0) > 0} />
              </div>
            </Card>
            <Card>
              <h2 className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4" /> Security claims and boundaries</h2>
              <ul className="mt-3 space-y-3 text-sm text-secondary">
                <li><strong className="text-fg">No post-quantum iroh transport identity:</strong> hybrid ML-KEM protects session key exchange; iroh endpoint identity remains Ed25519.</li>
                <li><strong className="text-fg">Litebox is not confidential computing:</strong> it is a weaker seccomp-backed fallback, not hardware isolation.</li>
                <li><strong className="text-fg">Host containers are not microVMs:</strong> their isolation depends on the host runtime configuration.</li>
                <li><strong className="text-fg">Availability is operational:</strong> discovery and relay diversity help resilience but do not cryptographically guarantee reachability.</li>
                <li><strong className="text-fg">CRDT is lane-specific:</strong> leader-driven wholesale state synchronization has different conflict behavior.</li>
              </ul>
            </Card>
          </div>
          <p className="mt-5 text-xs text-muted">Last refreshed: {new Date(data.observed_at_ms).toLocaleString()}. Older or mixed-fleet nodes must be treated as unknown when they cannot supply this endpoint.</p>
        </>
      )}
    </div>
  );
}

function FleetEvidence({ fleet }: { fleet: NonNullable<SecurityPosture["fleet"]> }) {
  const [open, setOpen] = useState(false);
  return <Card className="mb-5">
    <div className="flex items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold">Fleet-replicated evidence</h2><p className="mt-1 text-xs text-secondary">Observed by {fleet.observer}. {fleet.unavailable_nodes} node report(s) unavailable; those nodes are not assumed healthy.</p></div>
      <Badge tone={evidenceTone[fleet.summary.evidence]}>evidence: {fleet.summary.evidence}</Badge>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-3 text-sm lg:grid-cols-5">
      <Metric label="Hybrid total" value={fleet.summary.hybrid_connections_total} tone="green" />
      <Metric label="Classical total" value={fleet.summary.classical_connections_total} tone="blue" />
      <Metric label="Unknown total" value={fleet.summary.unknown_connections_total} tone="amber" />
      <Metric label="ML-DSA verified" value={fleet.summary.mldsa_verified_total} />
      <Metric label="Discovery hits" value={fleet.summary.discovery_resolve_hits} />
    </div>
    <button type="button" onClick={() => setOpen(!open)} className="mt-4 flex items-center gap-1 text-xs font-medium text-secondary hover:text-fg"><ChevronDown className={`h-4 w-4 ${open ? "rotate-180" : ""}`} /> Per-node evidence ({fleet.reported_nodes}/{fleet.reported_nodes + fleet.unavailable_nodes})</button>
    {open ? <div className="mt-3 space-y-2">{fleet.nodes.map((node) => <NodeEvidence key={node.node} node={node} />)}</div> : null}
  </Card>;
}

function NodeEvidence({ node }: { node: NonNullable<SecurityPosture["fleet"]>["nodes"][number] }) {
  const e = node.evidence;
  return <div className="rounded border border-border p-3 text-xs">
    <div className="flex justify-between gap-2 font-medium"><span>{node.node} · {node.region}</span><span className="flex gap-1"><Badge tone={node.healthy_from_observer ? "green" : "amber"}>{node.healthy_from_observer ? "healthy from observer" : "not healthy from observer"}</Badge><Badge tone={e ? "blue" : "amber"}>{node.report_state}</Badge></span></div>
    {e ? <div className="mt-2 grid gap-1 text-secondary sm:grid-cols-2"><span>KEX: {e.kex.hybrid_connections_total} hybrid / {e.kex.classical_connections_total} classical / {e.kex.unknown_connections_total} unknown ({e.kex.evidence})</span><span>Trust: {e.trust.configured_trusted_peers} configured, {e.trust.reachable_healthy_trusted_peers} reachable healthy, {e.trust.mldsa_verified_total} ML-DSA verified</span><span>Discovery: {e.discovery.resolve_hits}/{e.discovery.resolves} resolve hits, DHT {e.discovery.dht_registered ? "registered" : "unavailable"}</span><span>Execution: {e.execution.selected_backend} ({e.execution.evidence}); containers: {e.execution.container_hardening_evidence}</span></div> : <p className="mt-2 text-secondary">No compatible report: evidence is unavailable.</p>}
  </div>;
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "green" | "blue" | "amber" }) {
  return <Card className="p-3"><div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div><div className={`mt-1 text-xl font-semibold tabular-nums ${tone === "green" ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{value}</div></Card>;
}

function Timeline({ label, value, active }: { label: string; value: string; active: boolean }) {
  return <div className="relative"><span className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${active ? "bg-emerald-500" : "bg-muted"}`} /><div className="font-medium">{label}</div><div className="text-xs text-muted">{value}</div></div>;
}

function LayerDetail({ layer, layerKey }: { layer: SecurityLayer; layerKey: string }) {
  const discovery = layerKey === "discovery" ? layer as SecurityPosture["layers"]["discovery"] : null;
  const synchronization = layerKey === "synchronization" ? layer as SecurityPosture["layers"]["synchronization"] : null;
  const isolation = layerKey === "workload_isolation" ? layer as SecurityPosture["layers"]["workload_isolation"] : null;
  return (
    <div className="mx-3 mb-2 grid gap-2 rounded-b-lg border border-t-0 border-border bg-subtle/40 p-3 text-xs sm:grid-cols-2">
      <p><strong>Protects:</strong> {layer.protects}</p>
      <p><strong>Does not protect:</strong> {layer.does_not_protect}</p>
      {discovery ? <p className="sm:col-span-2"><strong>Providers:</strong> {Object.entries(discovery.providers).map(([name, provider]) => `${name.replaceAll("_", " ")}: ${provider.status}`).join(" · ")}</p> : null}
      {synchronization ? <p className="sm:col-span-2"><strong>Synchronization:</strong> {synchronization.crdt_lanes} {synchronization.snapshot_lanes}</p> : null}
      {isolation ? <><p className="sm:col-span-2"><strong>Selected function backend:</strong> {isolation.selected_backend}. Firecracker/KVM is the only strong microVM lane. Litebox is partial syscall mediation plus seccomp—not confidential computing, hardware isolation, Firecracker, or gVisor.</p><p className="sm:col-span-2"><strong>Separate lanes:</strong> Firecracker/KVM microVM; Litebox syscall mediation + seccomp fallback; host-container runtime; mock/host-process development runtime. Container hardening is not inferred here without measured runtime configuration.</p></> : null}
    </div>
  );
}
