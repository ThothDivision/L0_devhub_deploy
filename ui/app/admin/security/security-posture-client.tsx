"use client";

import { Activity, AlertTriangle, ChevronDown, Layers3, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge, Card, PageHeader } from "@/components/ui";
import { type SecurityLayer, type SecurityLayerStatus, type SecurityPosture, useOpsPoll } from "@/lib/api";

const layers: Array<{ key: keyof SecurityPosture["layers"]; label: string; subtitle: string }> = [
  { key: "application", label: "Application security", subtitle: "Authenticated platform controls and tenant-scoped APIs" },
  { key: "identity", label: "Identity, tenant authorization, and peer trust", subtitle: "Ed25519 endpoint identity; ML-DSA is message-level only" },
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

function humanTime(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : "No observed event";
}

export function SecurityPostureClient({ initial }: { initial: SecurityPosture | null }) {
  const { data, error } = useOpsPoll<SecurityPosture>("/v1/security/posture", 5_000, true, initial);
  const [expanded, setExpanded] = useState<string | null>("cryptography");
  const crypto = data?.layers.cryptography;

  return (
    <div>
      <PageHeader
        title="Security architecture"
        desc="Live, leader-observed operational posture. Each statement is scoped; it is not a fleet-wide certification."
        action={data ? <Badge tone="blue">scope: {data.scope} · {data.node}</Badge> : undefined}
      />
      {!data || !crypto ? (
        <Card className="text-sm text-secondary">{error ? "Posture data is unavailable. The operator endpoint may be unreachable or this node may not support it." : "Loading live posture…"}</Card>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Metric label="Hybrid sessions" value={crypto.live_hybrid_sessions} tone="green" />
            <Metric label="Classical fallback" value={crypto.live_classical_sessions} tone="blue" />
            <Metric label="Unknown sessions" value={crypto.live_unknown_sessions} tone="amber" />
            <Metric label="Observed connections" value={crypto.total_observed_connections} />
            <Metric label="Last verified" value={crypto.last_verified_ms ? new Date(crypto.last_verified_ms).toLocaleTimeString() : "—"} />
          </div>

          <Card className="mb-5 overflow-hidden p-0">
            <div className="border-b border-border bg-subtle/50 px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="h-4 w-4" /> Layered security model</div>
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
                        <span className="flex items-center gap-2"><Badge tone={statusTone[layer.status]}>{layer.status}</Badge><ChevronDown className={`h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} /></span>
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
      {isolation ? <p className="sm:col-span-2"><strong>Selected function backend:</strong> {isolation.selected_backend}. Container workload counts are not inferred by this endpoint.</p> : null}
    </div>
  );
}
