"use client";

import { useState } from "react";
import { Globe2, Server, Share2, ShieldCheck, Database, Network, Boxes } from "lucide-react";
import { Card, Badge, Button, PageHeader, Table, Th, Td } from "@/components/ui";
import { apiSend, usePoll, type NodeInfo, type AnycastTable, type RateLimitStats } from "@/lib/api";
import { SATELLITE_ONLINE_COLOR, SATELLITE_DEGRADED_COLOR } from "@/components/region-map";
import type { BrowserPresence } from "@/lib/run-node-client";
import { timeAgo } from "@/lib/utils";

interface ClusterStatus { term: number; leader: string; is_leader: boolean; members: string[]; consensus: string }

/** Amber, and NOT one of the existing mesh hues, because the ring means a
 *  role rather than a health state: green/blue/gray are already spoken for
 *  by node health and GPU, and teal is the browser-peer body color the ring
 *  has to stay legible against. */
const SHARD_HOLDER_COLOR = "#f59e0b";

/**
 * A presence record as the constellation reads it.
 *
 * `node_name` and `shard_eligible` are SERVER-DERIVED additions on the Rust
 * record (crates/hive-cloud/src/browser_presence.rs) — the browser sends
 * neither and cannot. They are declared as optional here, rather than made
 * required on the shared `BrowserPresence` interface, for one concrete
 * reason: this dashboard and the backend deploy independently (AGENTS.md's
 * ui-deploy-gap rule), so a freshly deployed UI routinely talks to a node
 * that predates them. Optional keeps that case a rendering fallback instead
 * of a type lie — and the fallback is exact, because the backend recomputes
 * `node_name` from the endpoint id on every read.
 */
type BrowserNode = BrowserPresence & { node_name?: string; shard_eligible?: boolean };

/** `bn-<adj>-<noun>-<tag>` — the backend's own name for this peer, with the
 *  endpoint-id prefix as the last-resort fallback if we are talking to a node
 *  that predates the field. Never the tenant-scoped `display_label`: that one
 *  names the OWNER, not the node. */
function browserNodeName(p: BrowserNode): string {
  return p.node_name || `bn-${p.endpoint_id.slice(0, 8)}`;
}

export default function NetworkPage() {
  // Mesh membership/leadership change at gossip cadence (~5s) — 10s polling is
  // fully live for this page (each fetch also shares the per-path TTL cache).
  // The previous /v1/overview poll here was never read anywhere — deleted.
  const { data: nodes } = usePoll<NodeInfo[]>("/v1/nodes", 10000);
  const { data: cluster } = usePoll<ClusterStatus>("/v1/cluster", 10000);
  // Low-trust browser-node presence — a SEPARATE feed from `/v1/nodes`, never
  // merged into the fleet node list or capacity totals anywhere on this page
  // (same discipline as the /regions constellation satellites).
  const { data: presenceFeed } = usePoll<{ presence: BrowserNode[] }>("/v1/browser/presence", 8000);
  const presence = presenceFeed?.presence ?? [];
  const regions = Array.from(new Set((nodes ?? []).map((n) => n.region))).sort();
  // Browser nodes are mesh members and count toward the node total exactly
  // as a fleet node does. They were excluded from this headline while being
  // drawn on the diagram below, so the number contradicted the picture — an
  // operator reading "7" above a ring of nine cubes learns not to trust
  // either. The two kinds are still broken out in the hint, because they are
  // NOT interchangeable: only fleet nodes host deployments.
  const fleetCount = nodes ? nodes.length : null;
  const browserCount = presence.length;
  const nodeTotal = fleetCount === null ? null : fleetCount + browserCount;

  return (
    <div>
      <PageHeader
        title="Constellation"
        desc="Your nodes form a peer-to-peer mesh over iroh QUIC. Gateways reach instances by endpoint id — no public IPs, NAT traversal and relay fallback handled automatically."
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          icon={<Server className="h-4 w-4" />}
          label="Nodes"
          value={nodeTotal ?? "—"}
          hint={
            fleetCount === null
              ? undefined
              : browserCount > 0
                ? `${fleetCount} fleet + ${browserCount} browser`
                : `${fleetCount} fleet`
          }
        />
        <Stat icon={<Globe2 className="h-4 w-4" />} label="Regions" value={regions.length || "—"} />
        <Stat icon={<Share2 className="h-4 w-4" />} label="Transport" value="iroh QUIC" />
        <Stat icon={<Database className="h-4 w-4" />} label="State store" value="replicated" />
      </div>

      {/* P2P mesh map */}
      <Card className="mb-6 overflow-hidden">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium"><Network className="h-4 w-4" /> P2P Mesh</div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rotate-45 rounded-[2px] bg-[#34c759]" /> node</span>
            {/* Blue is the platform-wide "has a GPU" color (see GPU_COLOR in
                region-map.tsx). Listed here because a diagram that renders some
                cubes blue with no legend entry is just an unexplained color. */}
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rotate-45 rounded-[2px] bg-[#3b82f6]" /> GPU</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rotate-45 rounded-[2px] bg-[#9ca3af]" /> unhealthy</span>
            <span className="flex items-center gap-1.5" title="Low-trust volunteer browser peers — the same cube as a fleet node, same size and place on the ring, teal instead of green; counted in the node total but they do not host deployments. Named bn-<adjective>-<noun>-<tag>, derived server-side from the peer's proven endpoint id.">
              <span className="inline-block h-2.5 w-2.5 rotate-45 rounded-[2px]" style={{ background: SATELLITE_ONLINE_COLOR }} /> browser node <span className="font-mono text-[10px] opacity-70">bn-*</span>
            </span>
            <span className="flex items-center gap-1.5" title="This browser node is eligible to hold small fragments of global platform state (see Storage shards below). Eligibility is server-derived from a platform-admin session — a browser cannot claim it.">
              <span className="inline-block h-2.5 w-2.5 rounded-full border border-dashed" style={{ borderColor: SHARD_HOLDER_COLOR }} /> shard holder
            </span>
          </div>
        </div>
        <MeshDiagram nodes={nodes ?? []} presence={presence} />
        <p className="mt-2 text-center text-xs text-muted">
          Every node runs a gateway + Fluid pool, fully meshed over iroh QUIC. The function tunnel protocol
          rides those streams, so a gateway on one node can serve an instance on any other, anywhere reachable.
          {presence.length > 0 && (
            <> Browser nodes are admitted peers on the same ring — low-trust edge capacity attached over the relay, counted in the node total but never hosting deployments.
            Each carries its own <span className="font-mono">bn-…</span> name, derived server-side from its proven endpoint id and stable across reconnects. A thin teal line marks the fleet node a peer relays through; the peer itself sits in its own slot.</>
          )}
        </p>
      </Card>

      <StorageShards />

      {/* Architecture rows */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Arch icon={<Share2 className="h-4 w-4" />} title="P2P transport (iroh)" desc="Multiplexed function tunnels over QUIC; dialed by public-key endpoint id with relay fallback." />
        <Arch icon={<Database className="h-4 w-4" />} title="Replicated state" desc="Platform records persist to disk and replicate across the mesh (guardian-db, iroh-native)." />
        <Card>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4" /> Coordinated cluster</div>
          <p className="text-sm text-secondary">Nodes agree on a leader so deployments stay consistent across regions.</p>
          {cluster && (
            <div className="mt-3 flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between"><span className="text-muted">Leader</span><span className="font-mono">{cluster.leader}{cluster.is_leader ? " (this)" : ""}</span></div>
              <div className="flex justify-between"><span className="text-muted">Term</span><span className="font-mono">{cluster.term}</span></div>
              <div className="flex justify-between"><span className="text-muted">Members</span><span className="font-mono">{cluster.members.length}</span></div>
            </div>
          )}
        </Card>
      </div>

      <AnycastRouting />

      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-fg">Nodes</span>
        <span className="text-xs text-muted">
          Cluster capacity:{" "}
          <span className="font-medium text-secondary">
            {(nodes ?? []).reduce((a, n) => a + (n.cpu_cores ?? 0), 0)} vCPU ·{" "}
            {fmtMem((nodes ?? []).reduce((a, n) => a + (n.mem_total_mb ?? 0), 0))} ·{" "}
            {(nodes ?? []).reduce((a, n) => a + (n.disk_total_gb ?? 0), 0)} GB
          </span>
        </span>
      </div>
      <Table>
        <thead><tr><Th>Node</Th><Th>Region</Th><Th>Endpoint</Th><Th>vCPU</Th><Th>Memory</Th><Th>Disk</Th><Th>GPU</Th><Th>Role</Th><Th>Seen</Th></tr></thead>
        <tbody>
          {(nodes ?? []).map((n) => (
            <tr key={n.id}>
              <Td className="font-medium">{n.name}</Td>
              <Td><Badge tone="blue">{n.region}</Badge></Td>
              {/* Endpoint is operator-only; the sanitized tenant payload omits it. */}
              <Td className="font-mono text-xs text-secondary">{n.public_url ?? "—"}</Td>
              <Td className="tabular-nums">{n.cpu_cores ?? "—"}</Td>
              <Td className="tabular-nums">{fmtMem(n.mem_total_mb)}</Td>
              <Td className="tabular-nums">{n.disk_total_gb ? `${n.disk_total_gb} GB` : "—"}</Td>
              <Td>{(n.gpu_count ?? 0) > 0
                ? <Badge tone="purple">{n.gpu_count}× {n.gpu_model ?? "GPU"}</Badge>
                : <span className="text-secondary">—</span>}</Td>
              <Td>{n.is_self ? <Badge tone="green">this node</Badge> : <Badge>peer</Badge>}</Td>
              <Td className="text-secondary">{timeAgo(n.last_seen_ms)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Card className="mt-4 text-sm text-secondary">
        Join another MacBook to the mesh:{" "}
        <code className="font-mono text-xs">hive-cloud --region fra1 --name node-b --peer http://&lt;this-ip&gt;:8786</code>
      </Card>
    </div>
  );
}

/** Format a memory size given in MB. */
/**
 * `latency_ms` is a MEASUREMENT when a probe succeeded and a SENTINEL when it
 * did not. `health.rs` marks an unhealthy peer `set_health(node, u64::MAX,
 * false)` deliberately — u64::MAX rather than 0 so an unhealthy peer sorts LAST
 * on any latency key instead of first — and that sentinel was rendered
 * literally, so the fleet table showed `18446744073709552000ms` (u64::MAX at
 * JS float precision) beside seven nodes at once. It reads as a catastrophic
 * measured latency; it means "never measured".
 *
 * Anything at or beyond a day is not a round trip, so treat the whole absurd
 * range as the sentinel rather than pattern-matching one constant — the
 * backend is free to pick a different "unreachable" marker later.
 */
const LATENCY_SENTINEL_FLOOR_MS = 24 * 60 * 60 * 1000;

function formatLatency(ms?: number): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "—";
  if (ms >= LATENCY_SENTINEL_FLOOR_MS) return "unreachable";
  return `${ms}ms`;
}

function fmtMem(mb?: number): string {
  if (!mb) return "—";
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb >= 100 ? Math.round(gb) : gb.toFixed(gb % 1 ? 1 : 0)} GB`;
  }
  return `${mb} MB`;
}

/**
 * P2P mesh map: nodes evenly on a circle, fully connected by curved orbital wire
 * lines (blue in light mode, white in dark — see the `stroke-*` classes), each
 * node a 3D green isometric cube with its name below. Admitted browser nodes
 * (the separate low-trust presence feed) orbit further out as small diamonds,
 * anchored beside their relay fleet node when identifiable. Pure SVG,
 * theme-aware, no deps.
 */
function MeshDiagram({ nodes, presence }: { nodes: NodeInfo[]; presence: BrowserNode[] }) {
  const W = 760;
  const H = 560;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) * 0.36;
  const n = nodes.length;

  // Only genuinely empty when there is NOTHING to draw. This used to return on
  // `n === 0` alone, which silently gated every browser satellite behind the
  // FLEET node list: any pass where /v1/nodes was empty or still loading threw
  // away a perfectly good presence feed and rendered "Discovering nodes…", so
  // browser nodes could never appear on their own. Satellites are positioned
  // relative to the ring, not to any individual node, so they draw fine with
  // an empty fleet — `nodes.map` yields no positions and every satellite
  // simply falls into the unanchored ring below.
  if (n === 0 && presence.length === 0) {
    return <div className="py-20 text-center text-sm text-secondary">Discovering nodes…</div>;
  }

  // Browser nodes are drawn as FIRST-CLASS members of this mesh: the SAME
  // ring, the SAME cube size and the SAME label geometry as a fleet node,
  // differing only in color (teal). They used to orbit further out at half
  // size, which read as a lesser object rather than a peer — and, worse,
  // anchoring each one beside the fleet node it relays THROUGH put a Los
  // Angeles browser peer visually inside san-jose whenever its relay lived
  // there, so the diagram answered "where is this peer" with the relay's
  // answer instead of the peer's. One ring, one geometry, one difference.
  //
  // Unlike the geographic /regions map there is no location-sharing
  // requirement here: this diagram is topological, so a browser that declined
  // geo sharing is still a member of the p2p network and still gets a slot.
  // Order is deterministic (fleet in /v1/nodes order, then browser peers in
  // stable lexical endpoint_id order) so a presence refresh doesn't reshuffle
  // the ring. Rendered count is honestly capped and the overflow is stated.
  const MAX_BROWSER_NODES = 60;
  const sortedPresence = [...presence].sort((a, b) => (a.endpoint_id < b.endpoint_id ? -1 : a.endpoint_id > b.endpoint_id ? 1 : 0));
  const browserNodes = sortedPresence.slice(0, MAX_BROWSER_NODES);
  const browserOverflow = sortedPresence.length - browserNodes.length;
  // A `bn-…` name is ~18 characters at 13px ≈ 118px wide; the ring is
  // ~2πR ≈ 1260px, so ~10 labels fit without collision and 24 is the point
  // past which they start overlapping badly. Beyond it the hover title (and
  // the screen-reader list) carries the name instead.
  const showBrowserNames = browserNodes.length > 0 && browserNodes.length <= 24;

  // One ring for EVERY member. Fleet nodes occupy the first `n` slots, browser
  // peers the rest, so both families share one radius and one spacing rule.
  // Declared before the edge pass below, which reads `pos`.
  const total = n + browserNodes.length;
  const ringXY = (i: number) => {
    if (total === 1) return { x: cx, y: cy };
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / total;
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  };
  const pos = nodes.map((_, i) => ringXY(i));
  const browserPos = browserNodes.map((_, k) => ringXY(n + k));

  // Full-mesh edges as quadratic Béziers bowed outward from the center, so the
  // overlapping arcs form the "atomic orbit" look.
  const edges: string[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = pos[i];
      const q = pos[j];
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      let nx = mx - cx;
      let ny = my - cy;
      const ol = Math.hypot(nx, ny);
      if (ol < R * 0.2) {
        // Near-diameter chord (midpoint ~ center): bow perpendicular instead so it
        // still curves rather than collapsing to a straight diameter.
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const dl = Math.hypot(dx, dy) || 1;
        nx = -dy / dl;
        ny = dx / dl;
      } else {
        nx /= ol;
        ny /= ol;
      }
      const bow = R * 0.42;
      const ctrlX = mx + nx * bow;
      const ctrlY = my + ny * bow;
      edges.push(
        `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`,
      );
    }
  }

  // `relay_hint` carries the node's WHOLE connected relay set, comma-joined
  // (the worker publishes `status.relay`, which is `relays.join(",")`), so
  // feeding it straight to `new URL()` always threw and every satellite fell
  // into the unanchored bucket — the relay-anchoring below was dead code from
  // the day it landed. Take the first entry, and tolerate a bare hostname.
  const hostOf = (u?: string | null): string => {
    if (!u) return "";
    const first = u.split(",")[0]?.trim() ?? "";
    if (!first) return "";
    try { return new URL(first).hostname; } catch { /* fall through to bare-host */ }
    return /^[a-z0-9.-]+$/i.test(first) ? first : "";
  };
  // The fleet's OWN headless browser nodes run ON a specific fleet host, and
  // their `subject` names it (`fleet-browser-node:<node>`, minted server-side
  // through the internal-token path — a browser cannot assert it).
  //
  // Prefer that over `relay_hint`, which answers a DIFFERENT question: which
  // relay the peer is connected THROUGH. Every fleet browser node relays via
  // one of the three relay hosts, so relay-anchoring drew the saopaulo,
  // frankfurt and hongkong browser nodes orbiting bangkok/virginia instead of
  // their own regions — they were on the map, but nothing tied them to the node
  // they actually run on, which reads as "no browser node in saopaulo".
  //
  // relay_hint remains the anchor for real user browsers, which run on nobody's
  // fleet host and for which the relay genuinely is the only topological tie.
  const FLEET_BROWSER_SUBJECT = "fleet-browser-node:";
  const hostNodeOf = (p: BrowserNode): string => {
    const subject = (p as { subject?: string }).subject ?? "";
    return subject.startsWith(FLEET_BROWSER_SUBJECT)
      ? subject.slice(FLEET_BROWSER_SUBJECT.length).trim()
      : "";
  };
  const anchorOf = browserNodes.map((p) => {
    const hostNode = hostNodeOf(p);
    if (hostNode) {
      const byHost = nodes.findIndex((nd) => nd.name === hostNode);
      // Fall through to the relay hint only if that node is not on the diagram
      // (e.g. it dropped out of the registry) — never silently mis-anchor.
      if (byHost >= 0) return byHost;
    }
    const hintHost = hostOf(p.relay_hint);
    if (!hintHost) return -1;
    return nodes.findIndex((nd) => hostOf(nd.relay_url) === hintHost || (Boolean(nd.name) && hintHost.includes(nd.name)));
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto block w-full" style={{ maxHeight: 540 }} preserveAspectRatio="xMidYMid meet">
      {/*
        Wire animation lives in an inline <style> rather than a Tailwind class or
        styled-jsx: the keyframes have to travel with this SVG (it is the only
        consumer), and `stroke-dashoffset` is not an animatable Tailwind utility.
        The dash period is 6+6=12, so the offset animates by -24 — an exact
        multiple — which is what makes the loop seamless instead of visibly
        jumping on every restart. Motion is disabled under
        `prefers-reduced-motion`, where a continuously-crawling full-mesh graph
        is exactly the kind of thing that triggers discomfort.
      */}
      <style>{`
        @keyframes hiveMeshFlow { to { stroke-dashoffset: -24; } }
        .hive-mesh-wire {
          stroke-dasharray: 6 6;
          animation: hiveMeshFlow 1.8s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .hive-mesh-wire { animation: none; }
        }
      `}</style>
      {/* mesh wires — blue (light) / white (dark), dashed and flowing */}
      <g fill="none" className="stroke-[#2f7fea] dark:stroke-white" strokeWidth={1.1} strokeOpacity={0.55} strokeLinecap="round">
        {edges.map((d, i) => (
          // Negative, per-edge staggered delay: every wire starts mid-cycle at a
          // different phase, so the mesh reads as many independent links rather
          // than one rigid pulse marching in lockstep. Negative (not positive)
          // so the stagger is already in effect on first paint — a positive
          // delay would show every wire frozen at phase 0 for up to a full
          // cycle before anything moved.
          <path key={i} d={d} className="hive-mesh-wire" style={{ animationDelay: `${-((i * 0.13) % 1.8).toFixed(2)}s` }} />
        ))}
      </g>
      {/* browser-node → relay links: a thin teal line from each browser peer to
          the fleet node it syncs its relay through. Drawn in the wire layer so
          the cubes below sit on top; only relayed peers (ai ≥ 0, i.e. a
          resolvable subject/relay_hint) get a line — an unresolvable one has no
          known relay to point at. Solid (not the flowing mesh dash) so a browser
          link reads as a distinct, quieter relationship than the fleet mesh.
          These carry TOPOLOGY only: both endpoints now sit on the same ring at
          their own slot, so the line never implies the peer is AT that node. */}
      <g fill="none" strokeLinecap="round">
        {browserNodes.map((p, k) => {
          const ai = anchorOf[k];
          if (ai < 0) return null;
          return (
            <line
              key={p.endpoint_id}
              x1={pos[ai].x}
              y1={pos[ai].y}
              x2={browserPos[k].x}
              y2={browserPos[k].y}
              stroke={p.state === "degraded" || p.state === "suspended" ? SATELLITE_DEGRADED_COLOR : SATELLITE_ONLINE_COLOR}
              strokeWidth={1}
              strokeOpacity={0.5}
            />
          );
        })}
      </g>
      {/* nodes */}
      {nodes.map((node, i) => (
        <g key={node.id} transform={`translate(${pos[i].x.toFixed(1)} ${pos[i].y.toFixed(1)})`}>
          <CubeIcon self={!!node.is_self} healthy={node.healthy !== false} gpu={(node.gpu_count ?? 0) > 0} />
          <text y={38} textAnchor="middle" style={{ fontSize: 13 }} className="fill-neutral-700 dark:fill-neutral-200">
            {node.name}
          </text>
        </g>
      ))}
      {/* browser-node satellites — the SAME isometric cube glyph as a fleet
          node, just SMALLER (size 9 vs 18) and in the shared low-trust teal
          hue, so a browser peer reads as the same kind of object on the mesh,
          not a different shape. Degraded/suspended recede to slate.

          Each one is LABELLED with its own node name, the same way a fleet
          cube is labelled with `node.name` — that is the whole point: a
          browser peer is a named member of the mesh, not an anonymous dot.
          The name is drawn only while the ring is legible (`showSatNames`);
          past that the hover title still carries it, which is honest about
          the space rather than rendering 150 overlapping labels. */}
      {/* browser nodes — the SAME isometric cube as a fleet node, at the SAME
          size (18) and the SAME label geometry, differing only in the shared
          low-trust teal hue. They occupy their own slot on the same ring, so a
          peer in Los Angeles renders as a peer in its own position instead of
          orbiting whichever fleet node it happens to relay through. Degraded /
          suspended recede to slate.

          Each one is LABELLED with its own node name, exactly as a fleet cube
          is labelled with `node.name` — a browser peer is a named member of
          the mesh, not an anonymous dot. Names draw only while the ring stays
          legible (`showBrowserNames`); past that the hover title and the
          screen-reader list still carry them. */}
      {browserNodes.map((p, k) => {
        const degraded = p.state === "degraded" || p.state === "suspended";
        // Light top → mid left → dark right, same lit-solid discipline as the
        // fleet CubeIcon, built around the shared satellite hue so the two cube
        // families look like one object in different colors.
        const faces = degraded
          ? { top: "#cbd5e1", left: SATELLITE_DEGRADED_COLOR, right: "#64748b" }
          : { top: "#7dd3fc", left: SATELLITE_ONLINE_COLOR, right: "#0ea5e9" };
        const name = browserNodeName(p);
        return (
          <g key={p.endpoint_id} transform={`translate(${browserPos[k].x.toFixed(1)} ${browserPos[k].y.toFixed(1)})`}>
            <CubeIcon
              self={false}
              healthy={!degraded}
              faces={faces}
              ring={p.shard_eligible ? SHARD_HOLDER_COLOR : undefined}
            />
            {showBrowserNames && (
              <text y={38} textAnchor="middle" style={{ fontSize: 13 }} className="fill-neutral-700 dark:fill-neutral-200">
                {name}
              </text>
            )}
            <title>{`${name} · browser node (low-trust)${p.state ? ` · ${p.state}` : ""}${p.shard_eligible ? " · state-shard holder" : ""}\nendpoint ${p.endpoint_id}`}</title>
          </g>
        );
      })}
      {browserOverflow > 0 && (
        <text x={W - 8} y={H - 10} textAnchor="end" style={{ fontSize: 11 }} className="fill-neutral-500 dark:fill-neutral-400">
          {`+${browserOverflow} more browser node${browserOverflow === 1 ? "" : "s"} not drawn`}
        </text>
      )}
    </svg>
  );
}

/**
 * A 3D isometric cube node icon, centered at (0,0): BLUE for a GPU-bearing node
 * (`gpu_count > 0`), green otherwise, gray when unhealthy.
 *
 * Blue specifically, and not some other accent, because the platform already
 * fixes blue as "this node has a GPU" fleet-wide — see `GPU_COLOR` in
 * `components/region-map.tsx`, whose palette deliberately excludes blue so a
 * non-GPU node can never land on it by round-robin chance. Reusing that exact
 * hue here keeps one meaning for one color across the region map and this mesh
 * diagram; picking an independent blue would let the two drift apart.
 *
 * Health still wins over capability: an unhealthy GPU node renders gray, since
 * "can I use this node at all" is the more urgent signal than what it carries.
 */
function CubeIcon({
  self,
  healthy,
  gpu,
  size = 18,
  faces,
  ring,
}: {
  self: boolean;
  healthy: boolean;
  gpu?: boolean;
  /** Cube radius. Fleet nodes use the default 18; browser satellites pass a
   *  smaller value so they read as the same object, just lighter-weight. */
  size?: number;
  /** Explicit top/left/right face colors, overriding the health/gpu palette —
   *  used to render a browser satellite as a teal cube in the shared
   *  low-trust hue instead of the green/blue fleet palette. */
  faces?: { top: string; left: string; right: string };
  /** Draw the dashed orbit ring in this color regardless of `self` — how a
   *  browser peer that is eligible to hold global-state fragments is marked.
   *  Deliberately the SAME glyph `self` already uses (a dashed ring means
   *  "this cube has an extra role"), just in the shard hue, rather than
   *  inventing a second decoration for the same idea. */
  ring?: string;
}) {
  const r = size;
  // Face shades run light (top) → mid (left) → dark (right) to read as a lit
  // solid; the blue triple mirrors the green's relative luminance steps so the
  // two cube types look like the same object in two colors, not two shapes.
  const top = faces ? faces.top : !healthy ? "#b0b6bd" : gpu ? "#60a5fa" : "#3ad15f";
  const left = faces ? faces.left : !healthy ? "#8a9098" : gpu ? "#3b82f6" : "#23a64e";
  const right = faces ? faces.right : !healthy ? "#6c727a" : gpu ? "#1d4ed8" : "#178a3d";
  return (
    <g>
      {(self || ring) && (
        <circle
          r={r + 9}
          fill="none"
          stroke={ring ?? (gpu ? "#3b82f6" : "#34c759")}
          strokeOpacity={0.55}
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      )}
      {/* top, left, right faces */}
      <path d={`M 0 ${-r} L ${r} ${-r / 2} L 0 0 L ${-r} ${-r / 2} Z`} fill={top} stroke={right} strokeWidth={0.8} />
      <path d={`M ${-r} ${-r / 2} L 0 0 L 0 ${r} L ${-r} ${r / 2} Z`} fill={left} stroke={right} strokeWidth={0.8} />
      <path d={`M ${r} ${-r / 2} L 0 0 L 0 ${r} L ${r} ${r / 2} Z`} fill={right} stroke={right} strokeWidth={0.8} />
      {/* chip detail on the top face */}
      <path d={`M 0 ${-r * 0.5} L ${r * 0.48} ${-r * 0.25} L 0 0 L ${-r * 0.48} ${-r * 0.25} Z`} fill="none" stroke={right} strokeOpacity={0.55} strokeWidth={1} />
    </g>
  );
}

// --- Storage shards -------------------------------------------------------

interface ShardFragment { key: string; store: string; index: number; bytes: number; digest: string }
interface ShardHolding { endpoint_id: string; node_name: string; max_bytes: number; held_bytes: number; fragments: ShardFragment[] }
interface ShardRefusal { reason: string; fragment: string; endpoint_id: string; detail: string }
interface ShardPlan {
  params: { enabled: boolean; max_bytes: number; fragment_bytes: number; replication_factor: number; stores: string[] };
  membership: string[];
  membership_digest: string;
  plan_digest: string;
  fragments_total: number;
  fragment_bytes_total: number;
  replicas_wanted: number;
  replicas_placed: number;
  under_replicated_fragments: number;
  unplaced_fragments: number;
  holdings: ShardHolding[];
  refusals: ShardRefusal[];
  refusals_total: number;
}
interface ShardTrust {
  model: string;
  proves: string[];
  does_not_prove: string[];
  options_for_a_real_possession_guarantee: string[];
  implemented_here: string;
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Which fragments of global platform state each browser node is responsible
 * for (`GET /v1/browser/shards`).
 *
 * Operator-only on the backend, so the poll is gated client-side on the same
 * `hive_is_owner` courtesy flag the notifications page uses — the point is
 * to not fire a 403 every 20s for every ordinary tenant, not to enforce
 * anything (the backend does that). Renders nothing at all when the fetch
 * yields no plan, so a non-operator sees no empty shell.
 */
function StorageShards() {
  const isOwner = typeof window !== "undefined" && localStorage.getItem("hive_is_owner") === "1";
  const { data } = usePoll<{ plan: ShardPlan; trust: ShardTrust }>("/v1/browser/shards", 20000, isOwner);
  const [showTrust, setShowTrust] = useState(false);
  if (!data?.plan) return null;
  const { plan, trust } = data;
  const held = plan.holdings.reduce((a, h) => a + h.held_bytes, 0);
  const shortfall = plan.unplaced_fragments + plan.under_replicated_fragments;

  return (
    <Card className="mb-6">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium"><Boxes className="h-4 w-4" /> Storage shards</div>
        <Badge tone={plan.params.enabled ? (shortfall > 0 ? "amber" : "green") : "default"}>
          {!plan.params.enabled ? "disabled" : shortfall > 0 ? "under-replicated" : "placed"}
        </Badge>
      </div>
      <p className="mb-4 text-sm text-secondary">
        A browser cannot hold the platform&apos;s replicated state, so it holds small fragments of it. Every
        node derives the same assignment with no coordinator: rendezvous (HRW) hashing over the eligible
        browser peers, keyed on the fragment — the same hash container placement and the inference
        coordinator already agree through. A fragment that would push a peer past its byte cap is refused
        outright and reported below; it is never trimmed to fit and never re-homed onto a peer the hash did
        not rank.
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
        <Fact label="Eligible peers" value={String(plan.membership.length)} />
        <Fact label="Fragments" value={`${plan.fragments_total} · ${fmtBytes(plan.fragment_bytes_total)}`} />
        <Fact label="Replicas placed" value={`${plan.replicas_placed} / ${plan.replicas_wanted}`} />
        <Fact label="Held by browsers" value={fmtBytes(held)} />
        <Fact label="Cap per peer" value={fmtBytes(plan.params.max_bytes)} />
        <Fact label="Fragment size" value={fmtBytes(plan.params.fragment_bytes)} />
        <Fact label="Replication" value={`${plan.params.replication_factor}×`} />
        <Fact label="Stores sharded" value={String(plan.params.stores.length)} />
      </div>

      {plan.holdings.length > 0 ? (
        <Table>
          <thead><tr><Th>Browser node</Th><Th>Fragments</Th><Th>Held</Th><Th>Cap used</Th><Th>Endpoint</Th></tr></thead>
          <tbody>
            {plan.holdings.map((h) => (
              <tr key={h.endpoint_id}>
                <Td className="font-mono text-xs font-medium">{h.node_name}</Td>
                <Td className="tabular-nums">{h.fragments.length}</Td>
                <Td className="tabular-nums">{fmtBytes(h.held_bytes)}</Td>
                <Td className="tabular-nums">{h.max_bytes ? `${Math.round((h.held_bytes / h.max_bytes) * 100)}%` : "—"}</Td>
                <Td className="font-mono text-[11px] text-secondary">{h.endpoint_id.slice(0, 16)}…</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-sm text-muted">
          {plan.params.enabled
            ? "No eligible browser peers online. Eligibility is derived server-side from a platform-admin session — a browser cannot claim it."
            : "Shard planning is off on this node (HIVE_BROWSER_SHARDS=0)."}
        </p>
      )}

      {plan.refusals.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-fg">
            Refusals{plan.refusals_total > plan.refusals.length ? ` (showing ${plan.refusals.length} of ${plan.refusals_total})` : ""}
          </div>
          <ul className="flex flex-col gap-1 text-xs text-secondary">
            {plan.refusals.map((r, i) => (
              <li key={`${r.fragment}-${r.endpoint_id}-${i}`}>
                <span className="font-mono text-[11px] text-muted">{r.reason}</span> {r.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The trust disclosure ships FROM the backend (`trust` in the same
          response) rather than being retyped here, so the claim on screen and
          the claim in the code cannot drift apart. */}
      <div className="mt-4 border-t border-border pt-3">
        <button onClick={() => setShowTrust((v) => !v)} className="text-xs font-medium text-secondary underline underline-offset-2">
          {showTrust ? "Hide" : "What this does and does not prove"}
        </button>
        {showTrust && (
          <div className="mt-2 flex flex-col gap-3 text-xs">
            <div><span className="font-medium text-fg">Model.</span> <span className="text-secondary">{trust.model}</span></div>
            <TrustList title="Proves" items={trust.proves} tone="text-secondary" />
            <TrustList title="Does NOT prove" items={trust.does_not_prove} tone="text-amber-600 dark:text-amber-500" />
            <TrustList title="Options for a real possession guarantee (none implemented)" items={trust.options_for_a_real_possession_guarantee} tone="text-secondary" />
            <div><span className="font-medium text-fg">Implemented here.</span> <span className="text-secondary">{trust.implemented_here}</span></div>
          </div>
        )}
      </div>
    </Card>
  );
}

function TrustList({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div>
      <div className="mb-1 font-medium text-fg">{title}</div>
      <ul className={`flex list-disc flex-col gap-1 pl-4 ${tone}`}>
        {items.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="font-medium tabular-nums text-fg">{value}</span>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  /** Optional sub-line. Optional so every existing call site is unchanged. */
  hint?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">{icon}{label}</span>
      <span className="text-2xl font-semibold text-fg">{value}</span>
      {hint ? <span className="text-xs text-secondary">{hint}</span> : null}
    </Card>
  );
}

function Arch({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">{icon}{title}</div>
      <p className="text-sm text-secondary">{desc}</p>
    </Card>
  );
}

/** Anycast routing table + L7 DDoS rate limiting. */
function AnycastRouting() {
  // Anycast/ratelimit change at gossip cadence / via this page's own mutations
  // (which invalidate the cache + refresh()) — slow polls lose nothing.
  const { data: any } = usePoll<AnycastTable>("/v1/anycast", 10000);
  const { data: rl, refresh } = usePoll<RateLimitStats>("/v1/ratelimit", 15000);
  const [limit, setLimit] = useState("");
  const [windowS, setWindowS] = useState("");
  const [saveErr, setSaveErr] = useState("");

  async function save(enabled: boolean) {
    // This is a node-wide (not per-tenant) safety control, so the backend
    // restricts it to platform operators — surface a clear message instead of
    // a silently-swallowed console error for anyone else.
    setSaveErr("");
    try {
      await apiSend("PUT", "/v1/ratelimit", {
        enabled,
        limit: Number(limit) || rl?.limit || 100,
        window_ms: (Number(windowS) || (rl ? rl.window_ms / 1000 : 10)) * 1000,
      });
      refresh();
    } catch (e) {
      setSaveErr(String(e));
    }
  }

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      {/* Anycast table */}
      <Card>
        <div className="mb-1 flex items-center gap-2 text-sm font-medium"><Globe2 className="h-4 w-4" /> Anycast Routing</div>
        <p className="mb-4 text-sm text-secondary">
          Requests are routed to the lowest-latency healthy node (region-preferred), with automatic
          failover — the network-hop equivalent of anycast, over the iroh mesh.
        </p>
        <Table>
          <thead><tr><Th>Node</Th><Th>Region</Th><Th>Latency</Th><Th>Health</Th><Th>Routing</Th></tr></thead>
          <tbody>
            {(any?.table ?? []).map((n) => (
              <tr key={n.id}>
                <Td className="font-medium">{n.name}</Td>
                <Td><Badge tone="blue">{n.region}</Badge></Td>
                <Td className="font-mono text-xs">{n.is_self ? "0ms (local)" : formatLatency(n.latency_ms)}</Td>
                <Td>{n.healthy ? <Badge tone="green">healthy</Badge> : <Badge tone="red">down</Badge>}</Td>
                <Td>{(any?.serving?.[n.name] ?? 0) > 0 ? <Badge tone="green">● serving</Badge> : <span className="text-xs text-muted">standby</span>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {/* L7 DDoS rate limiting */}
      <Card>
        <div className="mb-1 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4" /> L7 DDoS Mitigation</div>
        <p className="mb-4 text-sm text-secondary">Per-IP rate limiting at the edge — floods are shed (429) before any compute.</p>
        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-secondary">Status</span>
          <Badge tone={rl?.enabled ? "green" : "default"}>{rl?.enabled ? "enabled" : "off"}</Badge>
        </div>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted">Limit / IP</label>
            <input value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ""))} placeholder={String(rl?.limit ?? 100)} className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted">Window (s)</label>
            <input value={windowS} onChange={(e) => setWindowS(e.target.value.replace(/[^0-9]/g, ""))} placeholder={String((rl?.window_ms ?? 10000) / 1000)} className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm focus:outline-none" />
          </div>
        </div>
        <div className="mb-4 flex items-center justify-between text-sm">
          <span className="text-secondary">Blocked (total)</span>
          <span className="font-semibold tabular-nums text-red-500">{rl?.blocked_total ?? 0}</span>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => save(true)} className="flex-1">Apply</Button>
          <Button variant="outline" onClick={() => save(!rl?.enabled)}>{rl?.enabled ? "Disable" : "Enable"}</Button>
        </div>
        {saveErr && <p className="mt-2 text-xs text-red-500">{saveErr}</p>}
      </Card>
    </div>
  );
}
