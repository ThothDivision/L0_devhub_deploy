> Produced 2026-09-25 by an adversarially-verified investigation (live fleet measurements + code read against HEAD 43445a9). Queued as PRD rows (see section 8). Scratchpad helper paths ($SP/…) refer to the investigating session's scratch directory and are illustrative.

# User-app ingress latency, cold starts and session affinity: design, spec and plan

**Scope.** This covers user apps served by hive-cloud. The worked example is survey-botdemo.shadw.app, an Express app running in a litebox guest on fc-sanjose (sj).

**Inputs.**
- Four live investigations, each followed by an adversarial refutation pass, on 2026-09-25 between 01:42Z and 03:05Z.
- A fresh read of the current tree. At 03:14Z it matched HEAD 43445a9 and no file under crates/ was newer than 02:23:54Z; every file:line anchor below is against that tree.
- I edited nothing, restarted nothing and deployed nothing. I made no PRD writes: section 8 is the queue.

**Tags used throughout.**
- **[M]** measured live.
- **[C]** confirmed by reading code.
- **[I]** inferred.
- **[P]** partially confirmed by the refutation pass; only the part that survived is stated.

**Excluded.** Claims the refutation pass refuted are left out: the compile-cache warm-up costs and runs as root; a 197 s continuous socket closure; 3–32 KB/s on every path.

**Binary versions.** Measurements taken before 02:41Z are on binaries that predate 43445a9. The CS-1/2/7 roll restarted va3 at 02:37Z, va at 02:41Z, phx at 02:43Z and sj at 02:46Z.

---

## 1. Executive summary

Five causes, ordered by user-visible impact.

**1. sj's egress was saturated by a runaway UDP flood from the GuardianDB iroh endpoint.**
- [M] sj's NIC was sending 34.6–47.1 Mbit/s at 55–77k packets/s. Tencent metadata puts the egress limit at `bandwidth-limit-egress=41943040`, about 40 Mbit/s (the unit is inferred).
- [M] One flow dominated: sj `:60541` (the guardian endpoint) to phx `:45494`. It carried 78–79 % of bytes and 98–98.7 % of packets, with ~30-byte payloads at 27–64k pps. phx received only 6–12 % of those packets.
- [M] Effect on everything else sj sends: 22.5–95 % ICMP loss into sj, 8.5–11.2 % TCP retransmits, TLS handshake p90 0.89 s and max 3.82 s. Through the edges a 10 KB page took 1–10 s and a 360 KB image 17–95 s.
- [M] Lifecycle: the flood started 30 s after sj booted at 22:22:23Z. It grew every hour (`dropped transmit … :45494` went from 5,052/h to 61,813/h) and stopped at the 02:46Z restart. Afterwards sj sent 10–11 Mbit/s at ~1.7k pps with 0–3.3 % outbound loss, and forwarded 10 KB responses took 0.05–1.0 s.
- [P] Loss did not fully go away. At 02:59Z inbound loss to sj was still 12.5–20 % with 5.3 % retransmits, and 100 ms egress bursts reached 52.6 Mbit/s.
- The trigger is unknown, so the flood can recur on any boot.

**2. A single permit serializes every mesh-forwarded request into a node, across all tenants.**
- [C] `main.rs:690` builds `LiteboxBackend::default()` on every node. That constructor sets `set_local_connect_permits(1)` for the whole process (`litebox.rs:1322`).
- [C] The mesh `STREAM_TUNNEL` arm proxies each forwarded request to `0.0.0.0:8787` and holds that permit for the whole exchange. There is no connect, head or idle deadline and no cancellation (`fluid-tunnel/src/server.rs:396-446`, `hive-p2p/src/lib.rs:4814-4820`).
- [M] Forwarded exchanges never overlapped: 18 of them before the roll, 24 after, and 590 samples never saw more than one in flight.
- [M] Single exchanges held the permit for 60–168 s without sending one response byte.
- [M] A request to one tenant's warm app waited 2.52–2.56 s behind another tenant's 2.9 s cold start (normal: 0.07–0.15 s; reproduced 2/2).
- [M] The per-app guest gate has the same flaw. Production survey123 answered nothing for at least 5 min (SYN-SENT, 10 retransmits). survey-botdemo logged 12 `instance nack (overloaded)` 504s in 6 min.

**3. Fault handling turns short hiccups into 15 s waits, 30 s 502s and 503s.**
- [C] A forwarded request gets a 15 s first-byte budget over iroh, then an HTTP retry inside a shared 30 s budget (`lib.rs:1071-1073`, `edge.rs:857-1117, 2254-2264`).
- [M] Result: runs of 15.08–15.8 s TTFB, and 502 PEER_UNREACHABLE at 30.0–30.37 s.
- [C] A 120 s cooldown is supposed to limit this to one slow request per window. It only arms on a typed `PostSendTimeout` (`edge.rs:979-982`). But `request_stream` wraps `client.request(…, 15 s)` in an outer timeout with the same 15 s (`lib.rs:3471-3474`). When both expire in the same timer tick, the inner untyped "timed out waiting for response head" error wins and the cooldown never arms. [I] This fits the measured runs of consecutive 15 s requests.
- [P] Routes expire 30 s after a peer's last successful `/v1/serve-hosts` fetch, even while the registry still reports that peer healthy (`state.rs:37, 44-66`). The entry then answers `503 DEPLOYMENT_NOT_READY` in 49–51 ms, in windows of about 21 s. va's event ring held 52 not-ready events against 58 forwarded requests for survey-botdemo.
- [M] Truncated bodies are delivered as clean 200s: 0 and 7,707 of 10,334 bytes; 15,911, 7,719, 56,871 and 138,791 of 360,663 bytes.

**4. Nearly every request crosses the mesh.**
- [M] survey-botdemo runs only on sj. Its DNS answer is the `*.shadw.app` wildcard: va, va3 and phx until about 01:53Z, plus sj since. So 75–100 % of requests land on a node that has to forward them.
- [C] Records that point a label straight at its owner exist only for the first 60 labels in alphabetical order across the fleet (`vercel_dns.rs:642-643, 994`). survey-botdemo sorts 103rd among sj's labels and 117th fleet-wide.
- [C] The entry edge forwards before it looks in its own cache (`edge.rs:563-1135` runs before `:1276`), so even immutable assets cross the mesh on every request.
- [M] sj hosts 109 of the 128 labels eligible for owner records.

**5. Cold starts are amplified 10–30× around an intrinsic ~3 s.**
- [M] An uncontended survey-botdemo cold start takes 2.9–3.1 s:
  - provision: 136–157 ms
  - pre-spawn: 836 ms
  - litebox loading libnode: 1.17 s (`echo` takes 0.051 s)
  - app init: about 0.8 s
- [C] One `artifact_lock` for the whole node is held from artifact resolution through the 15 s readiness wait (`litebox.rs:4767-4992`).
- [M] After a restart, init times climb in 1.6–2.5 s steps up to 61.8–65.7 s. survey-botdemo took 41.0 s and 85.5 s after the 02:46Z restart. Before that restart, the pool median was 30.5 s, p90 118.9 s, max 151.7 s.
- [C] Three more amplifiers:
  - Requests coalesce onto an in-flight cold start for only 800 ms, then start duplicates (`fluid-compute/src/lib.rs:1384-1385, 1508-1535`).
  - Hourly recycling retires the old instance before a replacement exists (`:67-75, 2062-2096`).
  - On boot, every restored deployment is warmed, superseded ones included (`fluid-gateway/src/lib.rs:2216-2312`).
- [M] What that looked like:
  - The 02:40:17Z recycle dropped survey-botdemo to 0 instances. The next request took 8.59 s TTFB instead of 51 ms, and two duplicate cold starts ran.
  - 44 of 46 non-production pools were warmed after a restart.
  - sj has restarted 13 times since 09-18.

**Sticky sessions.** There is no affinity at any layer [C]:
- DNS is round-robin.
- Each edge rotates its candidate nodes (`edge.rs:2328-2360`).
- The owner picks the instance with the fewest in-flight requests (`fluid-compute/src/lib.rs:1487-1501`).
- Instances change on recycle, restart, scale-out and deploy.

survey-botdemo signs sessions with a per-process random secret because `SESSION_SECRET` is unset (the project env is `[]`), and stores its data as per-instance JSON because `DATABASE_URL` is unset [M]. Every instance change therefore logs every user out and forks the data.

Section 3 ranks two cross-tenant issues as high severity: a forgeable internal header that served another tenant's page under survey-botdemo's hostname [M], and the node-wide gate above.

**Targets** (section 5 has the verification numbers):
- A warm forwarded request completes in ≤ 0.6 s on a new connection from LA through any edge. That matches today's phx-hosted tokenhun (0.45–0.62 s). It holds while sj's egress stays under 60 % of its limit.
- A transport fault adds ≤ 3.2 s (today 15–30 s).
- No 503s while the owner is healthy in the registry.
- No cross-tenant head-of-line blocking.
- A survey-class cold start takes ≤ 2.4 s. The slowest pool after a roll comes up in ≤ 12 s. No recycle is visible to users.
- Apps that use the managed secret or opt-in affinity see no platform-caused logouts.

---

## 2. Current-state map

### 2.1 Warm request path: survey-botdemo /login.html (10,334 B) arriving at a non-owner edge

| # | Hop | Anchor | Healthy cost | Pathological cost |
|---|---|---|---|---|
| 1 | DNS: `*.shadw.app` wildcard, TTL 60, hosted on Vercel. Owner records only for the first 60 labels alphabetically | `vercel_dns.rs:597-686` (sort and truncate at 642-643), `:994`; owners built at `:2373-2400` | 3 ms when cached [M] | 75–100 % of answers are not the owner [M] |
| 2 | Client to entry: TCP + TLS 1.3. rustls with an SNI resolver, a session cache per node, and no ticketer shared across the fleet | `main.rs:2186-2215`, `acme.rs:203-209` | Handshake median 96 ms at phx, 193–198 ms at va/va3/sj [M] | sj p90 0.89 s, max 3.82 s because of packet loss [M] |
| 3 | Entry edge: request id, account IP allowlist, route lookup (peer routes that are also healthy in the registry) | `edge.rs:362-366, 397-450, 458-630` | < 1 ms [I] | `503 DEPLOYMENT_NOT_READY` in 49–51 ms during ~21 s windows when routes had expired (`state.rs:37, 44-66`) [M]; the TTL mechanism is [P] |
| 4 | Forward over iroh: a new QUIC stream and a new `TunnelClient` for every request; two nested 15 s budgets | `hive-p2p/src/lib.rs:3418-3502, 1071-1078`; `edge.rs:880-1003` | 1 RTT (va↔sj 63 ms) plus ~40 ms stream setup [M] | 15.08–15.8 s, then retried over plain HTTP; 502 at 30.0–30.37 s [M] |
| 5 | Owner's mesh arm: 1-permit gate on `0.0.0.0:8787`, then loopback TCP, then a second pass through the whole edge pipeline | `lib.rs:4814-4820`; `server.rs:396-431`; `edge.rs:1174-1358` | ~50 ms per exchange including the app (packet captures) [M] | Queueing: holds of 60–168 s; 2.52–2.56 s behind another tenant's cold start [M] |
| 6 | Owner gateway: picks the least-busy instance, uses the in-process `TunnelClient`, reaches the cell's `TunnelServer`, waits on the 1-permit guest gate, opens a fresh TCP connection to the guest | `fluid-gateway/src/lib.rs:4956-5163`; `fluid-compute/src/lib.rs:1466-1536`; `server.rs:396-397` | 44–54 ms end to end on sj itself; the guest answers in 1–15 ms [M] | Waits of 22.6 s, 60 s and 90–117 s; 504 FUNCTION_NO_RESPONSE after 3 reroutes to the same instance [M] |
| 7 | Owner buffering: the gateway buffers every response that has a Content-Length; the owner edge buffers `max-age=0` responses and then refuses to store them | `fluid-gateway/src/lib.rs:5353-5366`; `edge.rs:1361-1386`; `cdn.rs:193-195` | Adds the time to read the body | TTFB includes reading the whole body: the jpg had 21.1 s TTFB, then 3.5 s of body [M] |
| 8 | Body back to the client: Content-Length is stripped; the body ends cleanly on EOF, idle timeout or connection close | `edge.rs:927-948`; `lib.rs:1191-1211`; `fluid-tunnel/src/client.rs:121-129` | 93 KB in 0.22–0.27 s on healthy node pairs after the roll [M] | During the flood: 10 KB in 1–10 s, 360 KB in 17–95 s; truncated 200s [M] |

### 2.2 Cold-start path (litebox, survey-botdemo)

| Step | Anchor | Uncontended | Contended |
|---|---|---|---|
| lease, then `decide_lease`, then ColdStart | `fluid-compute/src/lib.rs:1380-1416, 1508-1535` | microseconds | After 800 ms of coalescing, waiting requests launch their own starts: +2 duplicates on the recycle [M] |
| Cold-start semaphore | `:1591-1596`; capacity `(cores/2).clamp(4,32)` at `:436-439` | 0 | none observed |
| `runtime_artifact_identity` (app-tar hash #1), then provision (TUN via `allocate_link`) | `fluid-compute:1751`; `litebox.rs:4635-4660, 1614` | provision 136–157 ms [M] | Creating the TUN triggers an iroh rebind that fails with AddrInUse 0.3–0.6 s later [M] |
| `provision_runtime` recomputes the identity (hash #2) | `litebox.rs:4496-4530` | included below | runs under `artifact_lock` [C] |
| `start_function`: take `artifact_lock`; load the reference (hash #3); verify the app tar (hash #4); run `ldd`; hash the runtime closure (96.5 MB); verify the combined tar (222.6 MB) | `litebox.rs:4767-4851`, `:1071-1093`, `:1962-2035` | 836 ms from cell creation to runner exec [M]; about 837 MB hashed, ≈0.64 s at 1.3 GB/s [I] | Queue climbs in 1.6–2.5 s steps [M] |
| Spawn the runner; libnode syscall patching at map time | `litebox.rs:4871-4934` | 1.17 s, whether or not `--rewrite-syscalls` is passed [M, P] | none |
| App init and readiness polling (25 ms polls, 15 s budget) | `litebox.rs:4967-4982, 3365-3401` | ≈0.8 s app init [M] | 5 of 6 readiness failures at boot were superseded deployments [M] |
| Release the lock | `litebox.rs:4992` | total 2.9–3.1 s; 3.09 s and 5.55 s when triggered by a request [M] | After restart: 41.0 s and 85.5 s for survey-botdemo, max 61.8–65.7 s. Before: median 30.5 s, p90 118.9 s, max 151.7 s [M] |
| Recycle once age ≥ 3600 s and the instance has served ≥ 1 request | `fluid-compute:67-75, 2088-2096` | none | 0 instances, then 8.59 s TTFB at 02:40:17Z [M] |
| Restart: reap every cell, restore every deployment, warm them all in one blocking `join_all` | `fluid-gateway:2216-2312`; `fluid-compute:2115-2173` | none | 44/46 non-production pools warmed; the autoscaler blocked for more than 2 min [M] |

### 2.3 Session and instance selection
- **DNS.** Round-robin over 3–4 IPs, and the set changes over time: {va, va3, phx} at 01:44Z, sj added by 02:31Z [M].
- **Edge.** Candidates are sorted by (cold, same region, latency). The group of equally good candidates is rotated by one global counter (`edge.rs:2286-2360`) [C].
- **Owner.** Picks the non-draining instance with the fewest in-flight requests (`fluid-compute/src/lib.rs:1487-1501`) [C].
- **Instance lifetime.**
  - Age recycling needs at least one request served, so idle instances are never recycled [C, P]. survey-botdemo's pool showed `recycled` 1–2 over ~4 h.
  - Instances above `min_instances` scale to zero after `idle_ttl` (60 s).
  - Every restart reaps every cell.
  - Every deploy supersedes the old instances.
- **Observed on survey-botdemo.** The serving instance went from cell-ad392e07 to cell-16207546 at the 02:40Z recycle, then to cell-af8036b2 and cell-dd6398ae after the roll [M].
- **WebSockets to functions never upgrade.**
  - [M] Through an edge they get a 200 with an empty body.
  - [C] The tunnel strips `upgrade` and `connection` headers (`server.rs:596-601`).
  - [C] The owner handles WebSockets only inside the mesh block (`edge.rs:563, 760-834`).
  - [P] `local_ws_proxy` cannot be reached while serving locally.
- **Cache key.** Host plus path only (`cdn.rs:101-103`) [C].

### 2.4 Background conditions on the path
- **Mesh blips on every cell creation.**
  - [M] `failed to rebind … AddrInUse` appears 0.3–0.6 s after each cell creation. Reproduced 2/2 at 03:04:51Z and 03:05:28Z, with 1,376 and 1,590 dropped-transmit lines each time.
  - [P] These are repeated short closures that recover after ~250 ms, not one long outage.
  - [C] netwatch 0.19.1 treats any added or removed interface as a major change (`interfaces.rs:319`, `netmon/linux.rs:210`), and vendored iroh rebinds on major changes (`vendor/iroh/src/socket.rs:1636-1654, 1732-1760`).
  - [M] sj logged 87,808 "too many addresses" warnings per hour.
- **Gossip payload.**
  - [M] Every peer pulls sj's `/v1/fleet-deployments` every round: 809,146–810,204 bytes each time, every 5–13 s [C] (`main.rs:4202-4227`, `gossip.rs:700`).
  - [I] That is a large share of sj's remaining egress.
- **DNS state.**
  - [M] Vercel creates have been succeeding again since ~01:53Z.
  - [I] The likely fair-use trigger is churn. Replicated labels flip their owner record between va and va3 on ~3 ms latency differences (`vercel_dns.rs:2384`). On 09-19 that meant 334 passes a day each doing created=3 deleted=3; the churn resumed between 01:57Z and 02:30Z today.
  - One 65-character branch label has been rejected with a permanent 400 since 2026-09-19T22:23:23Z, which holds the reconciler at ~4.6-minute passes.
  - The two-writer DNS problem is fixed: CS-1 has been live since 02:47Z (the PRD witness shows zero acquired lines on va, va3 and phx).

---

## 3. Security findings, ranked by severity

1. **HIGH — The internal header `x-hive-proxied` is trusted when it comes from the public internet.**
   - *Exploit.* Send `curl -H 'x-hive-proxied: 1'` for any victim host to any edge that does not host it. The edge skips mesh routing, the not-found guard and the container lease redirect. `Gateway::select` then falls back to `st.default`, which is some other tenant's deployment. That serves another tenant's app under the victim's name, cold-starts arbitrary apps, and on a node holding a container alias without its lease can start a second writer of a stateful container.
   - *Evidence.* [M] va3 returned 200, 10,114 B, `<title>Autheo — Meeting Docs` for survey-botdemo.shadw.app (twice). [M] phx cold-started its default app (cell-6fabef80, 42.24 s). [C] `edge.rs:458, 563, 1147`; `fluid-gateway/src/lib.rs:2371`.
   - *Fix.* IS-2 now (strip the header on 443/80; no default deployment for a named host; 421 MISROUTED), then IS-9 (HMAC-authenticated hop).

2. **HIGH — Cross-tenant denial of service through the node-wide gate, and per-app wedges.**
   - *Exploit.* Anyone requests a slow, streaming or cold route through a non-owner edge. That one exchange holds the only permit into the owner for up to `max_duration` (300 s), or forever for an endless body, because nothing cancels it. A single SSE client can also deny its own app to everyone, because the guest gate has one permit and no deadlines.
   - *Evidence.* [M] Victim TTFB 2.52–2.56 s vs 0.07–0.15 s (2/2). Holds of 60–168 s. survey123 down for at least 5 min. [C] The cooldown that should cap the damage does not arm (section 1, cause 3).
   - *Fix.* IS-1 (scoped gates, deadlines, cancellation) and IS-3 (the requester dropping out propagates cancellation).

3. **HIGH — The CDN replays `Set-Cookie` and per-user responses, and ignores `Vary`.**
   - *Exploit.* An app answers an authenticated request with `public, max-age=60` (or any `s-maxage`) together with `Set-Cookie`. The owner edge caches it under host plus path and replays that user's session cookie or page to every visitor for 60 s. A gzip body stored for one client is served to clients that did not ask for gzip.
   - *Evidence.* [C] `cdn.rs:101-103, 138-214, 260-282`; `edge.rs:1276-1314, 1690-1706` (`insert` also collapses multiple `Set-Cookie` headers). [M] `Accept-Encoding: identity` got a gzip HIT on a nodes-wtf chunk.
   - *Fix.* IS-11 (one `storable` predicate, variant-aware key).

4. **MEDIUM-HIGH — Per-client rate limiting and WAF IP rules run on the owner and are keyed on 127.0.0.1.**
   - *Exploit.* The entry forwards before it rate-limits. The owner sees every iroh-forwarded client as 127.0.0.1, so they all share one bucket of 100 requests per 10 s. One client sending ~11 requests/s can get every mesh user of every app on the owner rate-limited [I]. WAF IP rules never match real clients.
   - *Evidence.* [M] sj blocked 803 requests with only 8 tracked keys in 3.8 h; the entry nodes blocked 0. [C] `edge.rs:112, 563, 1176, 1218`. [P] Account-level IP allowlists already run at the entry (`edge.rs:397-450`).
   - *Fix.* IS-9 (HopContext; policy evaluated at the entry).

5. **MEDIUM — The client's X-Forwarded-For passes through untouched, and the platform never sets the real client IP.**
   - *Exploit.* Rotate `X-Forwarded-For` to bypass survey-botdemo's login throttle, which keys on `x-forwarded-for[0]`. Without the header, all users share one address and 8 bad passwords lock the account for everyone.
   - *Evidence.* [C] An exhaustive search finds no code that sets XFF, X-Real-IP or Forwarded (`fluid-gateway/src/lib.rs:4989-5019`, `edge.rs:731-749`). [M] The app's `routes/auth.js` reads it.
   - *Fix.* IS-9.

6. **MEDIUM — The HTTP fallback crosses the public internet in plaintext.**
   - *Exploit.* Anyone on the path between phx (Hostinger) and sj (Tencent) can read session cookies, Authorization headers and request bodies sent as `http://170.106.158.151:8787`.
   - *Evidence.* [C] `edge.rs:1024-1047`. [M] Responses carried `x-hive-transport: http-direct`. The lockdown limits who can connect to 8787, not who can read the traffic.
   - *Fix.* IS-18.

7. **MEDIUM — `Expect: 100-continue` loses the response after the app has already run the request.**
   - *Exploit.* An upload client retries, and the side effect happens twice.
   - *Evidence.* [M] Over h2 the final response was `HTTP/2 100` (curl exit 16). Over h1 it was `100 Continue` then `500` with content-length 0. [C] `server.rs:437-446, 494-497`.
   - *Fix.* IS-13a.

8. **MEDIUM — Superseded production deployments stay public and anyone can cold-start them.**
   - *Exploit.* Enumerate commit or dpl aliases (the unauthenticated `/v1/serve-hosts` lists 1,043 dpl ids). Hit old code that lacks later fixes, and exhaust memory with cold starts of about 290 MB each.
   - *Evidence.* [M] survey-botdemo has 16 superseded deployments in Ready state; two cold-started in 3.72 s and 3.75 s, producing runners of 296 MB and 269 MB. [C] `edge.rs:1898-1923`; `max_instances_per_tenant=0` at `fluid-compute:335`.
   - *Fix.* IS-13b.

9. **MEDIUM — Operator and topology data is readable without authentication.**
   - *Exploit.* Reconnaissance: `api.shadw.cloud/v1/anycast` returns 15,775 B including private 10.0.0.x addresses, iroh identities and each node's backend (including `mock`). `/v1/serve-hosts` lists 1,827 hosts, `/v1/leases` 36 leases, and `/v1/functions`, `/v1/ratelimit` and `/v1/mesh` are open too.
   - *Evidence.* [M] curl without a token. [C] `auth.rs:255-279` never rejects a GET.
   - *Fix.* IS-13c (report first, then enforce).

10. **MEDIUM — Buffering is unbounded.**
    - *Exploit.* A response with a multi-GB Content-Length is collected into a `Vec` with no size cap. Tunnel channels are unbounded. The CDN holds up to 10k entries of 16 MiB each with no byte budget and clones bodies under a global lock. Any of these can run the shared node out of memory.
    - *Evidence.* [C] `fluid-gateway/src/lib.rs:5353-5366`; `client.rs:60,173`; `server.rs:126`; `cdn.rs:80-122, 197-212`. [M] sj's RSS was 3.9–4.4 GB, above memwatch's 3,072 MB threshold, from 02:55Z.
    - *Fix.* IS-10 and IS-11.

11. **MEDIUM — Truncated responses look like successes.**
    - *Exploit.* None is needed; any fault in the middle of a body causes it. A short body is delivered as a 200. Request bodies over 16 MiB are forwarded empty. Cacheable responses over 16 MiB are served empty with their original headers. Weak ETags of the form `W/"size-0"` then make the broken copy stick through 304s.
    - *Evidence.* [M] The truncation sizes listed in section 1, and an ETag of `W/"285e-0"` that returns 304. [C] `edge.rs:843-847, 927-948, 1366-1381`; `litebox.rs:3589`.
    - *Fix.* IS-3, IS-10, IS-11.

12. **MEDIUM — Tenants can trigger mesh blips.**
    - *Exploit.* Any anonymous request to a scaled-to-zero preview causes a cold start. The cold start creates a TUN, iroh rebinds, the rebind fails with AddrInUse, and every mesh transmit on the node is dropped for ~250 ms.
    - *Evidence.* [M] Reproduced 2/2 with 1,376 and 1,590 dropped transmits. [P] Not every interface change causes a failed rebind (3 during the ~48-creation boot).
    - *Fix.* IS-14.

13. **MEDIUM (latent) — A stateful volume can get two writers.**
    - *Exploit.* A busy container is recycled. It is kept alive while draining, and keep-warm starts its replacement on the same `hive-vol-*`. The single-writer guard does not run once the boot reap has been confirmed.
    - *Evidence.* [C] `fluid-compute:2089-2096, 2062`; `cell_orphans.rs:664-711`. [P] Not witnessed.
    - *Fix.* IS-5: no age recycling for volume-backed or raw-TCP pools; stop-then-start only.

14. **LOW — No session affinity, and instances are ephemeral.**
    - *Exploit.* Not an attack. Per-process session and state is lost on every instance change.
    - *Evidence.* [M] survey-botdemo's random per-process secret and per-instance JSON storage.
    - *Fix.* IS-12a/c, plus the tenant action row.

15. **LOW — WebSockets to functions never upgrade.**
    - *Exploit.* Not an attack. Any client sending Upgrade headers through an edge gets a 200 with an empty body.
    - *Evidence.* [M] See section 2.3.
    - *Fix.* IS-12b.

16. **LOW — Topology headers, a spoofable `x-hive-served-by`, and a client-controlled request id.**
    - *Exploit.* Count instances and time recycles. A tenant app can spoof `x-hive-served-by`. A client can forge `x-hive-request-id`, which is echoed.
    - *Evidence.* [C] `edge.rs:58-68, 364-366`. [M] The forged id was echoed on mesh responses; locally served responses carry no id at all.
    - *Fix.* IS-13d.

17. **LOW — Host names are not normalized.**
    - *Exploit.* An uppercase Host gets a 503. An empty Host gets sj's default tenant, which also cold-starts it.
    - *Evidence.* [M] Uppercase returned 503. Empty Host returned 200 "SurveyBot Dashboard" from cell-21c0923a.
    - *Fix.* IS-2.

18. **LOW [P] — `x-fluid-wait-until-ms` is not clamped.**
    - *Exploit.* A tenant can pin a gateway lease and its in-flight count, which blocks drain and recycle. It does not hold the guest or mesh permits.
    - *Evidence.* [C] `server.rs:476-478`; `fluid-gateway:5301-5343`.
    - *Fix.* IS-13e.

19. **LOW (latent) — A dangling DNS record.**
    - *Exploit.* `dan.shadw.app` points at 43.166.233.114. That IP is the inventory host fc-sanjose-cvm-2, which is still up and resets connections on 443. Releasing that IP without cleaning the record would allow a takeover.
    - *Evidence.* [M] `dig`; `ansible/inventory/hosts.ini:99`.
    - *Fix.* The ops row `dan-shadw-app-dangling-record`, then IS-15 (managing orphaned records).

20. **LOW [P] — Seer answers authoritative NXDOMAIN with no SOA for zones it does not serve.** Responses are 25–29 B, so there is no amplification risk. *Fix.* IS-20.

21. **INFO — Request-smuggling boundaries hold [P].** Request bodies are buffered and Content-Length is recomputed. Headers named in `Connection` are not stripped, and `ws_proxy` replays client headers raw. *Fix.* Folded into IS-9.

22. **INFO — Observability gaps.** Owner-side events have no request_id, forwarded events have an empty project, transport failures do not appear in the event ring, and journald suppressed 42,771 lines in one burst. *Fix.* OBS-1 and OBS-2.

23. **RESOLVED — Two nodes wrote DNS at once** (2026-09-20, plus ~45 takeovers by va on 09-24). CS-1 and `va-ops-config-cleanup` fixed it; CS-6 (pending) closes the related delete ratchet.

---

## 4. Target design

### 4.1 Invariants (each one is checked in section 5)
- **I1.** A request's cost on the owner does not depend on any other tenant's requests. Every reservation has a deadline and is released when the requester goes away.
- **I2.** Transport liveness and application latency are separate signals. The edge falls back within about 3 s when the transport is dead. It never replays a request the owner has acknowledged unless the request is safe to replay.
- **I3.** Every body either completes with its declared framing or aborts visibly (RST or connection close). A short body never looks like a clean 200.
- **I4.** A route lives as long as the fleet knows the node is alive (registry liveness), not as long as one gossip fetch succeeds.
- **I5.** Internal headers are never trusted from the public internet. The client's identity is set once, at the entry, and is authenticated from hop to hop.
- **I6.** A shared cache stores only responses that are provably not per-user and not per-variant.
- **I7.** A cold start is paid once, by one owned task. It is never duplicated, never thrown away, and never queued behind unrelated tenants. Replacements come up before retirements.
- **I8.** Clients land on a node that can serve them locally whenever the platform knows of one. Forwarding is the fallback.
- **I9.** Affinity is explicit, signed, scoped to one tenant and deployment, and never a cause of failure. State that must survive an instance change lives outside the instance.
- **I10.** Host-local interface churn never disturbs the mesh. Egress saturation is detected within about a minute and attributed to a flow.
- **I11.** All canonical state is in memory, in gossip, or in `store_sync`. Nothing on the request or decision path reads GuardianDB or the relational mirror. Keys are derived from `HIVE_SECRET_KEY`; nothing is stored in a database.

### 4.2 One primitive per failure class
The operator's rule applies throughout: fix a failure class once, at a shared primitive, never per app or per node.

| Failure class | The one primitive | Every caller |
|---|---|---|
| A reservation held across an unbounded wait | `fluid_tunnel::gate::Exchange` = permit + connect/idle deadlines + cancel signal bound to the delivering stream; `Cancel` frame enabled by a capability bit | mesh arm, litebox/container/mock cell tunnels |
| A concurrency limit scoped to the wrong resource | `GateClass {Gateway, Guest, Container, Default}`, registered by whoever owns the endpoint | main.rs (gateway), litebox (guests), hive-backend (containers) |
| Transport death confused with a slow app | Two-signal forward: `Accepted` frame plus per-stream heartbeat (liveness) vs response head (app progress); typed timeout errors | edge mesh forward, `ws_proxy`, `PeerPool::request` |
| Silent truncation | Body contract: every body stream ends in `Ok(None)` (RespEnd) or `Err(BodyAbort)`; declared Content-Length kept | fluid-tunnel client/server, `TunnelStream`, edge mesh and HTTP passes, `build_response`, cache tee, request bodies |
| Routing state lost on one missed fetch | `merge_routes_ttl` keyed on registry liveness (the same rule as `merge_deployments_ttl`) plus a fleet-deployments fallback | gossip loop, edge candidate builder |
| Client-controlled internal headers; lost client identity | `PublicIngress` layer plus `HopContext` (HMAC hop marker, client IP, request id) | 443/80 listeners, entry edge, owner edge, gateway, ws_proxy |
| Per-client policy evaluated at the wrong node | Rate limit, WAF IP rules and bot checks run at the entry on `HopContext.client_ip` | edge |
| Caching per-user or per-variant responses | `cdn::storable(req, status, headers)` plus a variant-aware key | owner cache, entry cache, revalidation |
| Unbounded buffering | Bounded channels, sized streaming, byte-budget LRU | fluid-tunnel, gateway, CDN |
| Queued or duplicated cold starts | `ColdStartFlight`: detached, owned, first ready instance wakes all waiters; per-image `ArchivePin` | request path, keep-warm, recycle replacement, boot warm |
| Break-before-make replacement | `replace_instance(old)`: warm the new one, then drain the old one | recycle, crash replacement, later adoption |
| Host interface churn disturbing the mesh | `platform_iface(name)` predicate in vendored iroh (major-change classification and the advertised address set), plus a pool of TUN devices | mesh endpoint, guardian endpoint |
| Egress saturation nobody sees | `egresswatch` (NIC vs provider limit, per-endpoint send counters, incident) | every node |
| DNS owner records capped arbitrarily and flapping | Ranked, hysteretic affinity selection; every record pointing at a fleet IP is managed; guarded deletes | vercel_dns |
| Session state lost on instance change | Managed per-project secret plus opt-in signed affinity token | env injection, edge, fluid-compute |
| Operator data readable without authentication | Route classification (public / tenant / operator) enforced in one layer, with redaction | admin router |
| Rolling back requires a restart | `RuntimeFlags`, node-local and in memory, changed through the operator endpoint on 8786 | every IS-* behavior |

### 4.3 Ingress and TLS
- **Where TLS ends.** TLS still terminates at the entry: rustls, TLS 1.3, h2 or http/1.1 (`acme.rs:203-209`). The measured handshake floor is 96–198 ms from LA. sj's tail latency is packet loss, which §4.9 addresses.
- **Public listeners.** The 443 and 80 listeners get one `PublicIngress` layer in front of `edge_pipeline` (`main.rs:2193` `https_router`, and the port-80 router). It:
  - strips `x-hive-*`, `x-fluid-*`, `x-mfe-*`, `x-forwarded-*`, `x-real-ip`, `forwarded`, `x-vercel-forwarded-for` and `expect`;
  - lowercases Host;
  - creates `HopContext{client_ip = TCP peer, proto = https|http, rid = minted by the server, entry = this node}`.
- **Session resumption.** TLS 1.3 resumption is added with a ticket key shared across the fleet (IS-22, low priority). A full TLS 1.3 handshake is already one round trip, so the gain is CPU time and a few KB of certificate bytes on lossy paths [I].

### 4.4 Routing and forwarding: serve locally first
**Decision order at the entry** (one function):
1. Serve locally if this node has the host in Ready state and not stale (today's `serve_local` / `prefer_peer` logic).
2. Answer from the entry cache (§4.6).
3. Forward to candidates from routes, which are now kept alive by registry liveness, or from the fleet-deployments fallback.
4. Only when no Ready owner exists anywhere, answer `DEPLOYMENT_NOT_READY` or `NOT_FOUND`.

**Per-client policy.** Rate limit, WAF IP rules and bot checks run at the entry on `HopContext.client_ip` before step 3. The owner skips them for authenticated hops.

**Forwarding transport: one iroh stream per request, with two signals.**
- *Capabilities.* `ReqMeta.caps` announces ACK, ABORT, CANCEL and FINISH. `Metrics.caps` advertises what the owner supports.
- *Liveness.* An owner on the new version sends an `Accepted` frame (11) as soon as it has parsed the request. The existing Metrics frames, which already arrive every 500 ms on every stream, serve as the heartbeat.
- *Entry behavior.*
  - Wait up to 2 s for `Accepted`, or 3 s for the first frame of any kind from an old owner. If nothing arrives, the transport is dead: mark it bad, arm the cooldown, and fall back (only for requests that are safe to replay).
  - After that, wait for the response head for up to min(deployment `max_duration`, 120 s) as long as heartbeats keep arriving no more than 5 s apart.
  - Remove the 15 s application cutoff, and never replay a request the owner has acknowledged.
- *Body.* Bounded channels. `RespAbort` (12) or losing the connection makes the entry yield `Err`, and the client sees an RST or close. Content-Length is preserved.
- *Stream lifecycle.* The client finishes its send half after the request (FINISH). Dropping the client aborts both of its tasks, so the owner gets STOP_SENDING, its writer fails, the cancel signal fires, and the exchange, its permits and its guest connection are released. `Cancel` (13) is sent on long-lived multiplexed tunnels only to peers that advertised CANCEL.

**Owner side.** The mesh arm now goes through the `Gateway` gate class (256 permits), never the guest gate. IS-24 later dispatches in-process and removes the loopback re-entry.

**Fallback transport.** Today the fallback is plaintext `http://<ip>:8787`. The target is HTTPS to the owner's 443:
- Connect by name `<node>--origin.<apps-domain>`. A resolver built from the registry maps that name to the owner's IP, and the `*.shadw.app` certificate covers it.
- Keep Host set to the app's host, and send `x-hive-hop`.
- Hedging (starting a second transport if the first is slow) stays off until forward-stats show it is safe.

**Route liveness.** An unreached peer's routes are kept for up to 10 min while the registry still has the peer alive, marked `stale`, and tried after fresh routes (`state.rs:78-95` already applies this rule to deployments).

### 4.5 DNS and placement affinity
**Mechanisms, in priority order:**
- **(a) Vercel owner records, done properly.**
  - Rank labels by per-label request volume, not alphabetically.
  - Leave out preview, branch, commit and dpl labels unless they are hot.
  - Filter for publishable nodes *before* applying the cap.
  - Reject labels longer than 63 bytes.
  - Hysteresis: keep a published node set while every member still hosts the label and is publishable.
  - For replicated labels, publish the full sorted owner set, which stays stable.
  - Read the cap from env once Vercel's limits are known (`vercel-limits-and-registrar`).
- **(b) Replicate opted-in stateless production apps to every node the wildcard returns** (IS-17b). Every DNS answer is then an owner, and this works even when DNS writes are frozen.
- **(c) Seer as the authoritative server for the apps zone** (IS-20). Unlimited, health-aware answers per label. Long term: needs at least 3 proven nameservers across at least 2 regions.

**Hot-label counters.** Each node keeps a Space-Saving top-512 of labels, halved every hour. It is published as an additional `hot` field in `/v1/serve-hosts`, which every gossip round already fetches, so no `NodeInfo` change is needed until CS-3 and mac-cs6 land. The DNS writer sums the counters in memory.

**Orphaned records.** Every single-label A/AAAA record whose value is a fleet IP becomes managed. Names that leave the managed set go back to the wildcard. At most 10 deletes per pass, and never while creates are failing (CS-6 rule).

**Placement.** New projects without a region avoid the control-plane owner and any node above 60 % egress utilization. Existing projects move only when an operator relocates them explicitly.

### 4.6 Edge caching of static assets
**The `storable` predicate:**
- *Refuse* if the response has `Set-Cookie`; if `Vary` is `*` or includes `cookie` or `authorization`; if the request carries `Authorization` or `Cookie`, unless the response says `public` or `s-maxage`; on `private` or `no-store`; and, in strict mode, on a bare `max-age` without `public`.
- *Allow* on `s-maxage`, `CDN-Cache-Control` or `Vercel-CDN-Cache-Control`; on `public, max-age=N`; and, for entries backed by revalidation, on `public, max-age=0` with a real validator. A validator is not real if it matches `W/"<hex>-0"` or has a 1970 Last-Modified.

**Cache mechanics.**
- *Key.* Lowercase host + deployment id + path?query + variant (normalized `Accept-Encoding` when `Vary` lists it).
- *Storage.* A byte-budget LRU (256 MiB by default, each host limited to 10 %) holding `Arc<Bytes>`, so nothing is cloned under the lock.
- *Stores.* Tee-store: stream to the client while accumulating, and store only if the body ends cleanly. The owner no longer buffers responses it would refuse to store.
- *Entry cache.* The entry edge looks up GET/HEAD requests with no Authorization before forwarding. It takes the deployment id from `peer_deployments`, stores from forwarded responses via the tee, and revalidates with a conditional GET to the owner, relaying a 304 without a body.

**Validators.** Litebox guest files get the commit timestamp as their mtime instead of 0 (`litebox.rs:3589`). It is deterministic per commit, so artifact dedup is preserved, and Express ETags change on every deploy.

### 4.7 Cold-start pipeline
- **Tier 0 — keep instances warm.**
  - Production keeps `min_instances ≥ 1`.
  - Replacement is make-before-break.
  - Age-based recycling is off by default, since there is no measured leak. Request-count recycling stays and becomes make-before-break.
  - Volume-backed and raw-TCP pools are never recycled automatically; they only get stop-then-start.
- **Tier 1 — one flight per cold start.**
  - `ColdStartFlight` runs as a detached task owned by Fluid. A `Notify` wakes waiters when any instance becomes ready or frees a slot.
  - Scale out only when queued demand exceeds (live + provisioning) × `max_c`.
  - Callers wait at most 25 s, then get `503 COLD_START_IN_PROGRESS` with `Retry-After: 2` while the flight continues.
  - A request that gives up never throws away an instance that is already starting.
  - The autoscaler never awaits a cold start (JoinSet).
  - Scale-out reacts to nacks: a saturated instance, as reported by the cell's Metrics, triggers scale-out instead of three reroutes and a 504.
  - Liveness checks cover every instance, using the runner's `try_wait`.
- **Tier 2 — litebox pipeline.**
  - A lock per image plus an `ArchivePin` (open fd and alias), released before spawn.
  - Hash each artifact once at delivery, remember it by stat tuple, and scrub every 24 h.
  - Compute the artifact identity once.
  - Readiness is signalled by the in-guest guard writing `HIVE_READY <port>` to stderr, with 25 ms polling as a fallback.
  - The readiness budget depends on the runtime.
  - One INFO line per cold start, broken down by phase.
- **Tier 3 — restarts.**
  - `restore` registers only production pools as warm.
  - Production pools are warmed first and staggered.
  - Long term: adopt running runners and containers across restarts instead of reaping them (IS-21, extending `cell-adoption-instead-of-reap`).
- **Tier 4 — research.**
  - Prove whether pre-rewriting libnode skips the 1.17 s shim patch.
  - Firecracker snapshot restore for apps placed on FC nodes.
  - Predictive warming from SNI or Host for scale-to-zero previews.

### 4.8 Session affinity model
- **Default: stateless**, matching Vercel, and documented as such. The platform guarantees nothing about which instance serves a request.
- **Fixing the per-process-secret class.**
  - The platform injects `HIVE_SESSION_SECRET` = HMAC-SHA256(HKDF(`HIVE_SECRET_KEY`, "hive-session-secret-v1"), tenant‖project) into every function's environment.
  - An optional project setting `session_secret_env` also injects it under a name the tenant chooses, but only when that name is unset.
  - The value is derived and never stored. It changes only if `HIVE_SECRET_KEY` rotates, which is documented as resetting sessions.
- **Opt-in affinity.**
  - Enabled per project with `fluid.json` `"affinity": {"mode": "cookie", "ttl_secs": 3600}`.
  - Cookie: `__hive_aff=v1.<deployment>.<node>.<cell>.<exp>.<mac>`.
  - MAC = HMAC-SHA256(K_aff, host‖tenant‖deployment‖node‖cell‖exp), with K_aff = HKDF(`HIVE_SECRET_KEY`, "hive-affinity-v1"). Cookies are also accepted under keys derived from `HIVE_SECRET_KEY_OLD`.
  - Attributes: `HttpOnly; Secure; SameSite=Lax; Path=/`, and host-only (no Domain), so the cookie never crosses tenant subdomains.
  - The platform strips the cookie before the request reaches the app.
- **When the cookie is honored.** All of these must hold: the MAC is valid; it has not expired; the deployment in the cookie is the one currently serving the host; the named node is healthy in the registry and hosts that deployment.
  - The named node is then tried first.
  - On the owner, the named cell is used if it is not draining and has a free slot. Otherwise the least-busy cell is used and the cookie is re-issued.
- **Failure modes.**
  - Any failed check falls back to normal routing and re-issues the cookie. Affinity never causes a 4xx or 5xx.
  - It never crosses tenants: tenant and deployment are both inside the MAC.
  - It never pins to a draining or dead cell.
  - Hot-spotting is bounded by `max_c`.
- **WebSockets.**
  - A WebSocket is pinned for its lifetime by its lease.
  - The owner serves upgrades itself (when serving locally, or for an authenticated hop).
  - If the upstream answers anything other than 101, the client gets `502 WS_UPGRADE_REFUSED`.
  - Each deployment has a WebSocket cap.
  - On litebox, raw splices bypass the guest gate [C] (`serve_raw` connects without `connect_gate`). WebSockets on litebox are therefore enabled only after `litebox-raise-connect-permits` proves the guest can handle at least two concurrent connections.
- **Stateful-app lint at build time.** Flag express-session without a store, in-memory session libraries, JSON storage directories, and a missing `DATABASE_URL`. Result: a WARN in the build log and a dashboard banner saying "state is per-instance".

### 4.9 Transport and egress health
- **egresswatch.** Every 5 s, compare TX bytes and packets on the default-route interface with the provider limit (Tencent metadata, or `HIVE_EGRESS_CAP_BPS`). Attribute traffic to the mesh and guardian endpoints. WARN at 80 % for 60 s, open a deduplicated incident at 5 min, and serve the numbers at `/v1/egress`.
- **Platform interfaces do not count as network changes.**
  - The `platform_iface` predicate matches the prefixes lbt, veth, podman, cni-, tap, fc, vnet, virbr, docker and br-.
  - Matching interfaces are excluded from the major-change decision and from the addresses iroh advertises. The default-route interface is never excluded.
  - A pool of TUN devices removes the add/remove churn at its source, and stale TUNs are swept.
- **Guardian endpoint.** Pin its UDP port (`HIVE_GUARDIAN_IROH_PORT`) so it can be policed and attributed. Add a per-remote transmit breaker once the flood's mechanism has been captured (IS-19). The structural fix is one shared endpoint (`iroh-guardian-endpoint-unify-finding`) or no guardian at all (CS-11).
- **Gossip.** `/v1/fleet-deployments` becomes conditional on a digest, and payloads over 64 KiB are zstd-compressed.

### 4.10 Observability
All node-local, operator-only on 8786, with no database involved:
- `/v1/tunnel/gates`
- `/v1/edge/forward-stats`
- `/v1/egress`
- `/v1/runtime-flags`
- `tunnel_streams_open` added to `/v1/relay`
- a per-phase INFO line for each cold start
- owner events carry request_id and project
- cache states `BYPASS` and `DYNAMIC`
- noisy transport WARNs converted into counters plus one rate-limited line

---

## 5. Spec per change set

### 5.0 Common: fixture, flags, helpers, roll discipline

**IS-0 — ingress-probe fixture (no platform code).**
- An operator-owned Express app. Its source lives outside this repo, it is deployed through the normal git path, and it is the only app used for verification.
- Deployments:
  - `ingress-probe` and `ingress-probe-b` on sj (litebox)
  - `ingress-probe-phx` on phx (litebox)
  - `ingress-probe-va3` on va3 (firecracker)
  - every one with `min_instances 1`, `max_instances 3`, `max_concurrency 10`.
- Routes:
  - `/fast` — 1 KB
  - `/size?kb=N` — sized response
  - `/chunked?kb=N&ms=M`
  - `/die-midbody?kb=N[&chunked=1]` — writes half the body, then destroys the socket
  - `/sleep?ms=N`
  - `/sse?n=&ms=`
  - `/headers` — echoes the request headers and the socket's remote address
  - `/cookie?maxage=N` — `public, max-age=N` plus `Set-Cookie`
  - `/static/app.<hash>.js` — `public, max-age=31536000, immutable`
  - `/count` (POST) — increments a counter
  - `/ws` — WebSocket echo
  - `/instance` — process id plus a random boot id
  - `/stats` — counters: `sleep_started`, `sleep_aborted`, `count`
  - `/secret-digest` — sha256 of `HIVE_SESSION_SECRET`
- A commit alias of `ingress-probe` with `min_instances 0` serves as the preview (`$PV`).

**IS-0b — RuntimeFlags.**
- `crates/hive-cloud/src/runtime_flags.rs` (new, under 200 lines) keeps a typed table, initialized from env and changed through `GET/PUT /v1/runtime-flags` (operator only, 8786).
- The path is added to the node-local exemptions next to `owner_routed()` (`main.rs:2390`), so a PUT is never forwarded to the leader.
- Each crate exposes atomic setters (for example `fluid_tunnel::gate::set_policy`, `hive_p2p::set_forward_flags`, `fluid_compute::Fluid::set_policy`), and the flags module calls them.
- Flags do not survive a restart; env remains the durable configuration.
- The journal logs an INFO line `runtime flag set key= value= by=` for every change.

**Helpers used below** (laptop):

```bash
SSH='ssh -i ~/.ssh/billing.pem -o StrictHostKeyChecking=no -o LogLevel=ERROR'
VA=43.166.206.175; VA3=43.172.25.45; SJ=170.106.158.151; PHX=93.188.162.67
SP=/private/tmp/claude-501/-Users-dylanwong-fluid-hive/4f80db69-06dd-4849-a63c-6e2a25b04055/scratchpad
# $SP/adm.sh <ip> <path> [port]       GET with an operator JWT minted on-node from HIVE_JWT_SECRET (never printed)
# $SP/adm_svc.sh <ip> <path> [port]   same, role=service (unscoped pool view)
# $SP/adm_put.sh <ip> <path> <port> <json>   copy of adm.sh with: curl -X PUT -H 'content-type: application/json' --data "$4"
W='%{http_code} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n'
t() { curl -s -o /dev/null -w "$W" "$@"; }
P=ingress-probe.shadw.app; PB=ingress-probe-b.shadw.app; PP=ingress-probe-phx.shadw.app; PV=<ingress-probe commit alias>.shadw.app
```

**Roll gate** (every change set, every node, 30–60 min apart, order va3 → va → phx → sj):

```bash
# regression matrix: expect only 2xx/3xx/404 identical across edges; zero 502/503/504
for ip in $VA3 $VA $PHX $SJ; do for hp in survey-botdemo/login.html actor-mapping/ survey123/ map-animations/ nodes-wtf/ tokenhun/; do
  h=${hp%%/*}; printf '%-15s %-16s ' $ip $h; t --resolve $h.shadw.app:443:$ip https://$h.shadw.app/${hp#*/}; done; done
# storm check at +2 min and +30 min after each restart, on every node: expect pps < 15000 and no UDP flow > 50 % of packets
for ip in $VA3 $VA $PHX $SJ; do $SSH root@$ip 'IF=$(ip -o route get 1.1.1.1 | sed -n "s/.* dev \([^ ]*\).*/\1/p"); \
  a=$(cat /sys/class/net/$IF/statistics/tx_packets); sleep 5; b=$(cat /sys/class/net/$IF/statistics/tx_packets); echo pps=$(( (b-a)/5 )); \
  timeout 4 tcpdump -i $IF -nn -Q out -c 20000 -q 2>/dev/null | awk "{print \$3\" > \"\$5}" | sort | uniq -c | sort -rn | head -3'; done
# mesh health (design.md §4): isolated=false, visible_healthy_peers >= pre-roll, accept_stuck ~0, owner changes 0
$SP/adm.sh $SJ /v1/mesh 8786 | jq '{isolated,visible_healthy_peers}'; $SSH root@$SJ 'journalctl -u hive-node --since -1h | grep -c "control-plane owner changed"'
```

**Build discipline** (AGENTS.md):
- `cargo test --workspace --no-run` before every push. `PeerRoute`, `ReqMeta`, `Metrics` and `FunctionStats` gain fields that test literals must include.
- Build Linux-only code on a node.
- Run `scripts/audit-runtime-versions.sh` for the glibc groups.
- `touch` synced sources before building.
- sha256 plus a `.old` backup for every binary.
- One change set per roll, never in the same roll as a CS change set, and never while another workflow's roll is between sync and build.
- Edit `vendor/` only between rolls.

---

### IS-1 — Tunnel exchange: scoped gates, deadlines, cancellation
*Depends on IS-0 and IS-0b. Its own roll. Proven first on phx, then sj.*

**Files and functions**
- `crates/fluid-tunnel/src/gate.rs` (new) replaces `connect_gate` and `LOCAL_CONNECT_PERMITS` (`server.rs:48-77`). `set_local_connect_permits` stays as a shim that sets the Guest class default.
- `server.rs::serve` (121-215): a `watch<bool>` cancel signal per connection. It fires when the writer task ends (the peer stopped reading or the connection closed) or when the reader errors. A clean EOF does not fire it. Each spawned `handle_request` runs under `select!{cancel, work}`.
- `server.rs::proxy_local` (379-594): `TcpStream::connect` under `HIVE_TUNNEL_CONNECT_MS`. Each `conn.read` under `HIVE_TUNNEL_BODY_IDLE_MS`, reset on every read. The permit is held by an `ExchangeGuard` that records how long it was held and releases in `Drop`.
- `litebox.rs::LiteboxBackend::new` (1294-1331): delete the `set_local_connect_permits(1)` call.
- `main.rs` backend selection (716-735): when litebox is selected, set the Guest default. After `gateway_addr` (1583), register it as `GateClass::Gateway`.
- `hive-backend/src/lib.rs` container serve path registers each container endpoint as `Container`.
- `litebox.rs` accept loop (4995-5015) registers the instance's guest address as `Guest`.
- `admin.rs` gets `GET /v1/tunnel/gates`.

**Interface**

```rust
pub enum GateClass { Gateway, Guest, Container, Default }
pub fn register(addr: &str, class: GateClass, permits: usize);
pub fn set_class_default(class: GateClass, permits: usize);
pub fn stats() -> Vec<GateStats>; // addr, class, permits, in_use, waiters, oldest_hold_ms,
                                  // acquired, connect_timeouts, idle_timeouts, cancelled
```

**Knobs**
- `HIVE_TUNNEL_GATEWAY_PERMITS=256`
- `HIVE_TUNNEL_GUEST_PERMITS=1`
- `HIVE_TUNNEL_CONTAINER_PERMITS=64`
- `HIVE_TUNNEL_CONNECT_MS=3000`
- `HIVE_TUNNEL_BODY_IDLE_MS=300000`
- `HIVE_TUNNEL_CANCEL=1`
- flags `tunnel.gate_policy=scoped|legacy` and `tunnel.cancel=on|off`

**Observability**
- INFO at boot: `tunnel gate policy: gateway=256 guest=1 container=64 default=64`.
- WARN, at most once per minute per address: `tunnel: exchange held gate addr= class= held_ms= method= host= rid=` once a hold exceeds 30 s. This names whoever is holding the gate, which answers `gate-holder-identity`.

**Mixed versions.** Local change only; nothing on the wire changes.

**Rollback.** Set `tunnel.gate_policy=legacy` and `tunnel.cancel=off`, or restore the `.old` binary.

**Verify**

```bash
$SP/adm.sh $SJ /v1/tunnel/gates 8786 | jq -c '.gates[]|select(.class=="gateway")|{addr,permits}'   # {"addr":"0.0.0.0:8787","permits":256}
# cross-tenant head-of-line (the defining witness)
$SSH root@$VA3 "curl -s -o /dev/null -m 20 --resolve $P:443:127.0.0.1 'https://$P/sleep?ms=8000' & sleep 0.5; \
  curl -s -o /dev/null -w '%{time_starttransfer}\n' --resolve $PB:443:127.0.0.1 https://$PB/fast; wait"
#   expect <= 0.35 s   (pre-IS-1 >= 7.5 s; witnessed 2.52-2.56 s behind a 2.9 s cold start)
# parallelism across guests
$SSH root@$VA3 "for h in $P $PB $P $PB; do curl -s -o /dev/null -w '%{time_starttransfer}\n' --resolve \$h:443:127.0.0.1 \"https://\$h/sleep?ms=1000\" & done; wait" | sort -n
#   expect ~[1.0,1.0,2.0,2.0] s (per-guest serialization only); pre-IS-1 ~[1,2,3,4] s
# cancellation
$SSH root@$VA3 "curl -s -o /dev/null -m 2 --resolve $P:443:127.0.0.1 'https://$P/sleep?ms=30000'"; sleep 3
$SP/adm.sh $SJ /v1/tunnel/gates 8786 | jq '([.gates[].in_use]|add), ([.gates[].cancelled]|add)'   # in_use 0; cancelled +1
curl -s --resolve $P:443:$SJ https://$P/stats | jq .sleep_aborted                                      # +1 within 3 s
# 24 h after sj rolls
$SSH root@$SJ 'journalctl -u hive-node --since -24h | grep -c "instance nack (overloaded)"'         # <= 2 (baseline 11 per 3 h)
```

---

### IS-2 — Minimal hop-trust hotfix
*No dependencies. Can share a release window with IS-1, but not the same roll.*

**Files and functions**
- `main.rs:2193` becomes `https_router = public.clone().layer(from_fn(edge::public_ingress))`; the port-80 router gets the same layer.
- `edge::public_ingress` (new): strips the internal header list from §4.3, lowercases Host, and marks the request `PublicIngress`.
- `edge.rs:458`: `already_proxied` now also requires that the request is not `PublicIngress` and that the peer is loopback or a public IP of a node on the roster.
- `fluid-gateway/src/lib.rs::select` (2348-2372): returns `None` for a non-empty host with no alias unless `HIVE_GATEWAY_DEFAULT_FALLBACK=1`, and lowercases `sub`.
- `edge.rs:1147`: a proxied request for a host this node does not serve gets `421` with `x-hive-error: MISROUTED`. A candidate that answers 421 is skipped and its route marked stale.

**Knobs.** `HIVE_EDGE_STRIP_INTERNAL=1`, `HIVE_GATEWAY_DEFAULT_FALLBACK=0`.

**Observability.** Counter `internal_headers_stripped{name}`; event action `misrouted`.

**Mixed versions.** Old entries send `x-hive-proxied` only over iroh and 8787, never 443, so they are unaffected.

**Rollback.** Flags.

**Verify**

```bash
curl -s -D - -o /dev/null --resolve survey-botdemo.shadw.app:443:$VA3 -H 'x-hive-proxied: 1' https://survey-botdemo.shadw.app/login.html | grep -iE '^(HTTP|x-hive-routed-to)'
curl -s --resolve survey-botdemo.shadw.app:443:$VA3 -H 'x-hive-proxied: 1' https://survey-botdemo.shadw.app/login.html | grep -o '<title>[^<]*'
#   expect 200, x-hive-routed-to: fc-sanjose, survey-botdemo's own title (pre: "<title>Autheo — Meeting Docs", 10,114 B)
$SSH root@$PHX 'pgrep -c litebox-runner'; t --resolve survey-botdemo.shadw.app:443:$PHX -H 'x-hive-proxied: 1' https://survey-botdemo.shadw.app/login.html; $SSH root@$PHX 'pgrep -c litebox-runner'
#   expect unchanged runner count (pre: new runner, 42.24 s)
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 --resolve survey-botdemo.shadw.app:443:$SJ -H 'Host:' https://survey-botdemo.shadw.app/                                   # 404 or 421 (pre: 200 SurveyBot Dashboard)
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 --resolve survey-botdemo.shadw.app:443:$SJ -H 'Host: SURVEY-BOTDEMO.shadw.app' https://survey-botdemo.shadw.app/login.html   # 200 (pre: 503)
```

---

### IS-3 — Two-signal mesh forward, stream lifecycle, typed timeouts, visible aborts
*Depends on IS-1. Roll after CS-3's hive-p2p commit lands, or before CS-3 begins; never at the same time.*

**Files and functions**
- `fluid-tunnel/src/codec.rs`: new frame kinds `Accepted=11`, `RespAbort=12`, `Cancel=13`. `read_frame` still rejects unknown kinds, so new kinds are sent only to peers that advertised them.
- `fluid-tunnel/src/lib.rs`:
  - `ReqMeta.caps: u32` and `Metrics.caps: u32`, both `#[serde(default)]`.
  - Typed errors `DeliverTimeout`, `HeadTimeout`, `TunnelClosed`, `Nacked`, `BodyAbort{Idle,Closed,Reset,Aborted}`.
- `client.rs`:
  - The body channel becomes bounded `mpsc::Sender<Result<Bytes, BodyAbort>>`.
  - On `RespAbort` or connection close, every pending body receives `Err`.
  - `last_frame_at` watch.
  - `finish_after_request` option.
  - `Drop` aborts the reader and writer through their `AbortHandle`s.
  - A `ResponseGuard` sends `Cancel` if it drops before RespEnd and the server advertised CANCEL.
- `server.rs`:
  - Send `Accepted` once `ReqMeta` is parsed, if caps has ACK.
  - Send `RespAbort` on the failure path after the head was sent (replacing the silent return at 319-330), if caps has ABORT.
  - The ticker stops when the reader has ended and nothing is in flight, so streams close.
  - `Cancel` fires that request's cancel signal.
- `hive-p2p/src/lib.rs::request_stream` (3418-3502): one owner for each budget.
  - Deliver phase: wait for `Accepted` for up to `HIVE_P2P_ACK_MS`, or any frame for up to `HIVE_P2P_FIRST_FRAME_MS` from old owners. Otherwise `PostSendTimeout{phase:"deliver"}`.
  - Head phase: wait while the gap between heartbeats stays within `HIVE_P2P_HEARTBEAT_GAP_MS`, up to a `head_budget` the caller supplies. Otherwise `PostSendTimeout{phase:"heartbeat"|"head"}`.
  - The outer `tokio::time::timeout` at 3471-3474 is deleted, and each phase is counted separately.
- `TunnelStream::next() -> Result<Option<Bytes>, BodyAbort>`. `recv()` stays as a wrapper.
- `relay_stats` gains `tunnel_streams_open{peer}`.
- `edge.rs` mesh forward (911-1003):
  - `head_budget = min(max_duration from peer_deployments, HIVE_EDGE_LIVE_HEAD_MS)`.
  - Keep `content-length` when the owner sent one (929-931, 1070-1074).
  - Build the body stream from `next()`, turning `Err` into `io::Error`.
  - Cooldown and fallback on `deliver` and `heartbeat`, with the unchanged `can_retry` gates.
- `/v1/edge/forward-stats` (new, operator, 8786).

**Knobs**
- `HIVE_P2P_ACK_MS=2000`
- `HIVE_P2P_FIRST_FRAME_MS=3000`
- `HIVE_P2P_HEARTBEAT_GAP_MS=5000`
- `HIVE_EDGE_LIVE_HEAD_MS=120000`
- `HIVE_EDGE_KEEP_CONTENT_LENGTH=1`
- `HIVE_P2P_FIRSTBYTE_MS=15000`, now only the head budget for owners that send no frames at all
- flags `forward.two_signal`, `forward.keep_content_length`

**Observability**
- forward-stats per peer: attempts, iroh_ok, deliver_timeouts, heartbeat_timeouts, head_timeouts, http_fallbacks, http_ok, http_fail, cooldown_armed, body_aborts, not_ready, misrouted.
- `tunnel_streams_open`.

**Mixed versions**
- Everything new is gated by capability bits.
- An old owner: its first Metrics frame, sent within 500 ms, stands in for `Accepted`.
- An old entry: the owner sends it nothing new.
- A Firecracker cell-agent that has not been rebuilt: it never advertises anything, so it never receives new frames.

**Rollback.** `forward.two_signal=off`. The typed-timeout fix stays in place.

**Verify**

```bash
# transport-death drill (maintenance window, 120 s; same shape as the CS-3 replay)
$SSH root@$VA3 "nohup sh -c 'iptables -I OUTPUT -d $SJ -p udp -j DROP; sleep 120; iptables -D OUTPUT -d $SJ -p udp -j DROP' >/dev/null 2>&1 &"
$SSH root@$VA3 "for i in 1 2 3 4 5; do curl -s -o /dev/null -w '%{http_code} %{time_starttransfer}\n' --resolve $P:443:127.0.0.1 https://$P/fast; sleep 2; done"
#   expect every TTFB <= 3.2 s (pre: 15.08-15.8 s each); forward-stats peer fc-sanjose: deliver_timeouts == cooldown_armed
#   (0 deliver_timeouts is also a pass if the trunk moved to the relay path)
for i in $(seq 300); do curl -s -o /dev/null --resolve $P:443:$VA3 https://$P/fast; done
$SP/adm.sh $VA3 /v1/relay 8786 | jq '.tunnel_streams_open["fc-sanjose"]'       # <= 3 (pre: one leaked stream per request until the trunk died)
curl -s -o /dev/null -w '%{http_code} %{size_download} ' --http1.1 --resolve $P:443:$VA3 "https://$P/die-midbody?kb=100&chunked=1"; echo "exit=$?"   # exit=18
curl -s -o /dev/null -w '%{http_code} %{size_download} ' --http2   --resolve $P:443:$VA3 "https://$P/die-midbody?kb=100&chunked=1"; echo "exit=$?"   # exit=92
#   pre: exit=0, 200, short body after the 45 s idle budget
curl -s -D - -o /dev/null --resolve $P:443:$VA3 "https://$P/size?kb=100" | grep -i '^content-length'     # content-length: 102400 (pre: absent)
t --resolve $P:443:$VA3 "https://$P/sleep?ms=25000"; curl -s --resolve $P:443:$SJ https://$P/stats | jq .sleep_started
#   expect 200 at 25.0-25.5 s over iroh-p2p and sleep_started +1 exactly (pre: 15 s cutoff, HTTP replay, +2)
```

---

### IS-4 — Route liveness equals registry liveness, plus a fleet-deployments fallback
*No dependencies. Touches `spawn_gossip_loop` only, not `sync_one_peer` (which mac-cs4 owns).*

**Files and functions**
- `state.rs`: `PeerRoute` gains `#[serde(default)] stale: bool`. The signature becomes `merge_routes_ttl(prev, fresh, seen, alive, now, max_stale_ms)` (44-66): an unreached peer's routes are carried while the peer is alive in the registry and newer than `max_stale_ms`, and marked stale.
- `main.rs:4487-4497`: passes `&alive` (already computed at 4456-4461).
- `edge.rs:569-598`: stale routes sort after fresh ones. When `raw` is empty and there is no container owner, candidates come from Ready `peer_deployments` whose alias matches the host (the matcher at 527-540) on nodes healthy in the registry, using the registry's `public_url` and `iroh_addr`. The event is `mesh-route-fleet-fallback`.

**Knobs.** `HIVE_ROUTE_MAX_STALE_MS=600000`, `HIVE_EDGE_FLEET_FALLBACK=1`.

**Rollback.** `route.max_stale_ms=30000`, which restores today's behavior.

**Verify**

```bash
for i in $(seq 720); do $SP/adm.sh $VA3 /v1/anycast 8786 | jq -r '.serving["fc-sanjose"] // 0'; sleep 5; done | sort -n | head -1   # >= 1 for 1 h
$SP/adm.sh $VA '/v1/logs?limit=2000' 8786 | jq '[.[]|select(.action=="deployment-not-ready")]|length'
#   expect 0 for sj-hosted labels over 24 h (pre: 52 for survey-botdemo in ~2 h)
```

---

### IS-5 — Fluid lifecycle: make-before-break, flights, detached cold starts, nack-aware scale-out, liveness
*Depends on IS-1. Changes the `CellBackend` trait: coordinate with the owner of `cell-adoption-instead-of-reap`.*

**Files and functions** (`fluid-compute/src/lib.rs`, unless noted)
- `FluidConfig::from_env()`, used at `main.rs:821`.
- `instance_recyclable` (67-75): age recycling now also requires `requests_served >= recycle_min_requests`, and is skipped entirely for pools with volumes or `raw_proxy`.
- `reconcile` (2022-2173):
  - A recyclable instance becomes `retiring`, which can still be leased, and a replacement starts.
  - When the replacement is ready, the retiring instance becomes `draining`.
  - Warms and drains are spawned into a JoinSet and never awaited.
- `lease` (1297-1464):
  - Waiters await `pool.ready.notified()` instead of polling every 20 ms.
  - Coalescing lasts until the in-flight cold start finishes, unless waiters exceed (live + provisioning) × `max_c`.
  - ColdStart becomes a flight owned by Fluid; the caller awaits a oneshot for at most `HIVE_FLUID_COLDSTART_WAIT_MS`.
- `decide_lease` (1466-1536): skips instances marked saturated.
- `health_loop` (1988-2011): also calls `backend.is_alive(handle)` for every instance.
- `hive-backend` trait: `CellBackend::is_alive(&CellHandle) -> Option<bool>`. The default returns `None`; litebox implements it with `child.try_wait()`.
- `fluid-gateway/src/lib.rs::proxy_function` (5048-5141):
  - On `Nacked`, call `fluid.note_saturated(key, cell)`.
  - Back off 50, 100, 200 ms between reroutes.
  - Map the new `COLD_START_IN_PROGRESS` to 503 with `Retry-After: 2`.
- `FunctionStats` gains `production`, `replacements_ok`, `replacements_failed`, `flight_waiters_max`, `detached_completed`, `nack_scaleouts`, `saturated_skips` and `reconcile_last_ms`.

**Knobs**
- `HIVE_FLUID_MAX_INSTANCE_AGE_SECS=0`
- `HIVE_FLUID_RECYCLE_MIN_REQUESTS=100`
- `HIVE_FLUID_MAX_REQUESTS_PER_INSTANCE=10000`
- `HIVE_FLUID_MAKE_BEFORE_BREAK=1`
- `HIVE_FLUID_COLDSTART_WAIT_MS=25000`
- `HIVE_FLUID_DETACHED_COLDSTART=1`
- `HIVE_FLUID_NACK_SCALEOUT=1`
- `HIVE_FLUID_REROUTE_BACKOFF_MS=50`

**Observability.** INFO line `fluid: replaced instance func= old= new= overlap_ms=`.

**Rollback.** Flags `fluid.make_before_break=0`, `fluid.detached=0`, `fluid.coalesce=legacy`.

**Verify**

```bash
$SP/adm_put.sh $PHX /v1/runtime-flags 8786 '{"fluid.max_instance_age_secs":120}'
for i in $(seq 600); do curl -s -o /dev/null -w '%{time_starttransfer}\n' --resolve $PP:443:$PHX https://$PP/fast; sleep 1; done | sort -n | tail -1
#   expect <= 0.35 s; in parallel poll adm_svc /v1/functions?local=true: instances never 0, recycled >= 4 (pre: 0 instances, 8.59 s TTFB)
$SP/adm_put.sh $PHX /v1/runtime-flags 8786 '{"fluid.max_instance_age_secs":0}'
sleep 90; for i in 1 2 3 4 5; do curl -s -o /dev/null -D - --resolve $PV:443:$SJ https://$PV/instance | grep -i '^x-fluid-instance' & done; wait
#   expect 5 identical instance ids; pool scale_out_total +1, coldstart_deduped +4 (pre: +2..+4 duplicate starts)
sleep 90; curl -s -m 1 -o /dev/null --resolve $PV:443:$SJ https://$PV/fast; sleep 5
#   expect pool instances == 1 (pre: 'cold start failed … abandoned=true', no instance)
for i in $(seq 12); do curl -s -o /dev/null -w '%{http_code}\n' --resolve $P:443:$SJ "https://$P/sleep?ms=2000" & done; wait
$SSH root@$SJ 'journalctl -u hive-node --since -5min | grep -c "reroute budget"'   # 12x 200 above; 0 here
```

---

### IS-6 — Boot warm order: production first
*No dependencies. Ship before the next CS roll so rolls stop costing 60–85 s.*

**Files and functions**
- `fluid-gateway/src/lib.rs::restore` (2216-2312): `PoolSpec.cfg.min_instances = 0` unless the record is production and is the current production alias (read from the in-memory `production_deployments` store, never a database).
- `reconcile_keepwarm` (1909) runs once synchronously right after restore, instead of at `spawn_lease_loop` +3 s (`main.rs:3543-3550`).
- Production pools are warmed in order of their hot-label counts, `HIVE_BOOT_WARM_STAGGER_MS=250` apart.

**Knobs.** `HIVE_BOOT_WARM_NONPROD=0`.

**Observability.** INFO line `boot warm plan: production=N nonproduction_skipped=M`.

**Verify** (at boot + 120 s of the next sj restart)

```bash
$SP/adm_svc.sh $SJ '/v1/functions?local=true' 8786 | jq '[.[]|select(.production==false and .instances>0)]|length'   # 0 (pre: 44 of 46)
$SP/adm_svc.sh $SJ '/v1/functions?local=true' 8786 | jq '[.[]|select(.production==true and .instances==0)]|length'   # 0
```

---

### IS-7 — Litebox cold-start pipeline
*Recommended after IS-5. Own track: nothing in the CS plan touches `litebox.rs`.*

**Files and functions** (`litebox.rs`)
- `artifact_lock` (495, 4767, 4556, 4643, 2211, 2348) becomes `artifact_locks: HashMap<ImageRef, Arc<AsyncMutex>>` plus `ArchivePin`, reusing the alias guard from `allocate_initial_files_alias`.
- `start_function` releases the image lock right after `allocate_initial_files_alias` (4873-4879), before spawn and readiness. GC and publication skip pinned archives.
- `verify_immutable_open` (1071-1093) and `runtime_source_sha256` (2707) consult a `DigestMemo` keyed on `(dev, ino, size, mtime_ns, ctime_ns)` and filled at delivery. A scrubber re-hashes everything at low priority every `HIVE_LITEBOX_SCRUB_SECS`; on a mismatch it quarantines the archive and opens an incident.
- `ldd_closure` (3467) is remembered per stat tuple of the runtime binary.
- `provision_runtime` (4496-4530) receives the identity through the trait instead of recomputing it (hash #2 removed).
- Readiness: the guard preload writes `HIVE_READY <port>` to stderr, the stderr reader (4941-4958) completes a oneshot, and `wait_litebox_ready` (3365-3401) keeps its 25 ms poll as a fallback. The budget comes from `HIVE_LITEBOX_READY_MS=15000`, or `HIVE_LITEBOX_READY_MS_NEXT=45000` for Next.js.
- Boot sweep: remove DOWN `lbt*` devices that have no runner. Respect `litebox-network-allocation-reentry`.

**Knobs.** `HIVE_LITEBOX_ARTIFACT_LOCK=per-image|global`, `HIVE_LITEBOX_HASH_MEMO=1`, `HIVE_LITEBOX_SCRUB_SECS=86400`, `HIVE_LITEBOX_READY_SIGNAL=1`.

**Observability.** INFO line `litebox cold start func= lock_wait_ms= hash_ms= memo_hit= prespawn_ms= listen_ms= total_ms=`.

**Rollback.** `litebox.artifact_lock=global`, `litebox.hash_memo=off`.

**Verify**

```bash
$SSH root@$SJ 'journalctl -u hive-node --since -30min -o cat | grep "litebox cold start"'
#   expect memo hits hash_ms <= 20, prespawn_ms <= 150 (pre: 836 ms), total_ms <= 2400 for the probe (pre: 2.9-3.1 s)
$SP/adm_svc.sh $SJ '/v1/functions?local=true' 8786 | jq '[.[]|.last_runtime_init_ms]|max'
#   after the next sj restart: <= 12000 (pre: 61,796-65,700 ms staircase; survey-botdemo 41.0 s / 85.5 s)
```

---

### IS-8a — egresswatch
*No dependencies. IS-8b (below) is a vendor edit.*

**Files and functions**
- `crates/hive-cloud/src/egresswatch.rs` (new): 5 s samples of `/sys/class/net/<default-route iface>/statistics/{tx_bytes,tx_packets}`.
- Cap: Tencent metadata `bandwidth-limit-egress`, fetched once at boot with a 2 s timeout, or `HIVE_EGRESS_CAP_BPS`.
- Attribution to the mesh and guardian endpoints from their iroh send counters.
- `GET /v1/egress`.
- WARN at `HIVE_EGRESS_WARN_UTIL=0.8` sustained for 60 s. After `HIVE_EGRESS_INCIDENT_SECS=300`, a deduplicated incident "egress saturated on <node>", auto-resolved.
- The alarm is off where the cap is unknown (phx), until the inventory sets the cap.

**Verify**

```bash
$SP/adm.sh $SJ /v1/egress 8786 | jq '{tx_bps,cap_bps,util}'    # cap_bps 41943040; tx_bps within ±10 % of:
$SSH root@$SJ 'a=$(cat /sys/class/net/eth0/statistics/tx_bytes); sleep 10; b=$(cat /sys/class/net/eth0/statistics/tx_bytes); echo $(( (b-a)*8/10 ))'
$SP/adm_put.sh $VA3 /v1/runtime-flags 8786 '{"egress.cap_bps":100000}'   # 6 min: one incident opens; clear the flag: resolves within 2 min
```

### IS-8b — Pin the guardian endpoint's port
*vendor window; with or after CS-10.*
- `vendor/guardian-db/src/p2p/network/core/mod.rs` (~2270): bind the guardian endpoint to `0.0.0.0:$HIVE_GUARDIAN_IROH_PORT`, using the same bind-address API `hive-p2p` uses for `HIVE_IROH_PORT`. Default 0, which keeps today's ephemeral port. The fleet inventory sets 11205.
- Record the change in `vendor/guardian-db` notes.
- Verify: `ss -uanp | grep ':11205 '` shows `hive-cloud` on every node, and `/v1/egress` attributes guardian bytes to that port.

---

### IS-9 — HopContext: client identity, entry-side policy, header hygiene
*Depends on IS-2.*

**Files and functions**
- `edge.rs` entry (after `public_ingress`): mint `HopContext`. For forwarded requests, run `cloud.ratelimit.check(client_ip)` and the WAF IP-prefix rules before the mesh block at 563. Sign `x-hive-hop: v1;<ts_ms>;<entry>;<client_ip>;<rid>;<b64 hmac>`, where the HMAC is HMAC-SHA256(K_hop, ts‖entry‖host‖client_ip‖rid) and K_hop = HKDF(`HIVE_SECRET_KEY`, "hive-hop-v1") via `secrets.rs`. `HIVE_SECRET_KEY_OLD` keys verify only.
- Owner: verify within `HIVE_HOP_SKEW_MS`. An authenticated hop skips rate limit, WAF IP rules and bot checks (already done at the entry) and uses `client_ip` for everything else.
- `fluid-gateway::proxy_function` (4989-5019): overwrite `x-forwarded-for`, `x-real-ip`, `x-vercel-forwarded-for` and `forwarded` from HopContext, never from the client.
- Strip headers nominated by `Connection`.
- `ws_proxy` (2384-2438) replays only an allowlisted set of headers.

**Knobs.** `HIVE_HOP_AUTH=report` in release 1, then `enforce` once `hop_bad_sig + hop_skew = 0` for 24 h on all four nodes. `HIVE_HOP_SKEW_MS=30000`, `HIVE_EDGE_SET_XFF=1`, `HIVE_EDGE_ENTRY_RATELIMIT=1`.

**Observability.** Counters `hop_ok`, `hop_missing`, `hop_bad_sig`, `hop_skew`.

**Mixed versions.** An old entry sends no `x-hive-hop`; in report mode the owner accepts it and counts it.

**Verify**

```bash
$SSH root@$VA3 "curl -s --resolve $P:443:$VA -H 'X-Forwarded-For: 1.2.3.4' https://$P/headers" | jq -r '.headers["x-forwarded-for"], .headers["x-real-ip"]'
#   expect 43.172.25.45 twice (va3's public IP as seen by va), never 1.2.3.4
$SP/adm_put.sh $VA /v1/runtime-flags 8786 '{"edge.ratelimit_limit":10}'
$SSH root@$VA3 "for i in \$(seq 20); do curl -s -o /dev/null -D - --resolve $P:443:$VA https://$P/fast | grep -iE '^(HTTP|x-hive-served-by|x-hive-ratelimit)'; done" | sort | uniq -c
#   expect 429s served by fc-virginia with x-hive-ratelimit: exceeded; sj /v1/ratelimit has no 127.0.0.1 key growth
$SP/adm_put.sh $VA /v1/runtime-flags 8786 '{"edge.ratelimit_limit":100}'
```

---

### IS-10 — Bounded, sized streaming bodies
*Depends on IS-3.*

**Files and functions**
- `fluid-tunnel` channels become bounded at `HIVE_TUNNEL_CHANNEL_FRAMES=64` (`client.rs:60,173`, `server.rs:126`).
- `fluid-gateway::build_response` (5240-5367) streams Content-Length responses with the header passed through; hyper enforces the length and `BodyAbort` aborts. The buffered path is removed.
- `edge.rs:1361-1386`: check `cdn::storable` before buffering. Storable responses are tee-streamed; everything else passes through.
- `edge.rs:843-847`: request bodies over `HIVE_EDGE_MAX_BUFFERED_BODY=16777216` get `413` with `x-hive-error: PAYLOAD_TOO_LARGE` instead of being forwarded empty.

**Verify**

```bash
t --resolve $P:443:$VA3 "https://$P/size?kb=102400"      # TTFB <= 1.0 s (pre: owner buffered the whole body before the head)
$SSH root@$SJ 'ps -o rss= -p $(systemctl show -p MainPID --value hive-node)'   # delta during the transfer <= 64 MB
head -c 17825792 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST --data-binary @- --resolve $P:443:$VA3 https://$P/count   # 413
```

---

### IS-11 — CDN correctness, entry-edge cache, validators
*Depends on IS-10 and IS-9. Serialize with IS-7 (both touch `litebox.rs`).*

**Files and functions**
- `hive-edge/src/cdn.rs`: `storable()` implementing §4.6; key `(host_lc, deployment_id, path_q, variant)`; byte-budget LRU with `Arc<Bytes>`; per-host share limit; counters `refused_setcookie`, `refused_vary`, `refused_auth`, `bytes`, `evictions`.
- `edge.rs`:
  - Entry lookup before 563 for GET/HEAD with no Authorization, using the deployment id from `peer_deployments`.
  - Tee-store on forwarded responses.
  - Revalidation by conditional GET to the owner.
  - `x-hive-cache: HIT|STALE|MISS|BYPASS|DYNAMIC`.
  - `cached_response` uses `append` for multi-value headers (1690-1706).
- `litebox.rs:3589`: tar mtime = commit timestamp.

**Knobs.** `HIVE_CDN_STRICT=1`, `HIVE_CDN_MAX_BYTES=268435456`, `HIVE_CDN_MAX_OBJECT_BYTES=16777216`, `HIVE_CDN_HOST_SHARE=0.1`, `HIVE_CDN_ENTRY_CACHE=1`.

**Verify**

```bash
for i in 1 2; do curl -s -D - -o /dev/null -H 'Accept-Encoding: identity' --resolve nodes-wtf.shadw.app:443:$SJ https://nodes-wtf.shadw.app/_next/static/chunks/0~xljvxpvpchi.js | grep -iE '^(x-hive-cache|content-encoding)'; done
#   expect no content-encoding; second x-hive-cache: HIT (pre: HIT with content-encoding: gzip)
for i in 1 2; do curl -s -D - -o /dev/null --resolve $P:443:$SJ "https://$P/cookie?maxage=60" | grep -iE '^(x-hive-cache|set-cookie)'; done
#   expect BYPASS twice and two different Set-Cookie values
for i in 1 2; do curl -s -D - -o /dev/null --resolve $P:443:$VA3 "https://$P/static/app.<hash>.js" | grep -iE '^(x-hive-cache|x-hive-served-by|x-hive-routed-to)'; done
#   expect second: HIT, served-by fc-virginia-3, no x-hive-routed-to
```

---

### IS-12a — Signed opt-in affinity
*Depends on IS-5 and IS-9.*

**Files and functions**
- `fluid-core` manifest: `affinity: {mode, ttl_secs}`.
- `edge.rs`: verify and issue `__hive_aff`, place the named node first in candidate ordering (2286-2360), strip the cookie before the app.
- `fluid-compute::decide_lease`: optional `preferred: Option<CellId>` (1487-1501).

**Knobs.** `HIVE_AFFINITY=1`.

**Observability.** Counters `affinity_honored`, `affinity_fallback`, `affinity_invalid`, `affinity_reissued`.

**Verify**

```bash
for i in $(seq 25); do curl -s -o /dev/null --resolve $P:443:$SJ "https://$P/sleep?ms=3000" & done   # forces 3 instances
rm -f jar; for i in $(seq 20); do curl -s -b jar -c jar --resolve $P:443:$VA3 https://$P/instance; echo; done | sort | uniq -c   # 1 distinct id x20
#   forged cookie (flip one char): 200, cookie re-issued, affinity_invalid +1; $P cookie sent to $PB: ignored
```

### IS-12b — WebSockets for functions
*Depends on IS-1; on litebox, also on `litebox-raise-connect-permits`.*
- `edge.rs`: on an upgrade with `serve_local` (or an authenticated hop), call `local_ws_proxy` directly. `ws_proxy` returns 502 `WS_UPGRADE_REFUSED` when the upstream's head is not 101.
- Per-deployment cap: `HIVE_WS_MAX_PER_DEPLOYMENT=256`. Flag `HIVE_WS_FUNCTIONS=1`.
- Verify: `curl -s -i -N --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' --max-time 3 --resolve $P:443:$VA3 https://$P/ws | head -1` should return `HTTP/1.1 101` (today: 200 with Content-Length 0).

### IS-12c — Managed session secret and stateful-app lint
*No dependencies.*
- Derive and inject `HIVE_SESSION_SECRET`; optional `session_secret_env` project setting (stored in ProjectSettings, the replicated `projects` store).
- `git.rs` build lint: WARN in the build log plus a `stateful_hint` flag.
- Verify: `/secret-digest` returns the same value from 3 instances and again after a redeploy.

---

### IS-13 — Security hygiene (five independent commits)
- **a. Expect and interim responses** (`server.rs:437-446`, the `expect` strip in `public_ingress`). Verify:
  `curl -s -o /dev/null -w '%{http_code} ' -X POST --data-binary x -H 'Expect: 100-continue' --resolve $P:443:$SJ https://$P/count; echo "exit=$?"` over h2 and `--http1.1` returns `200 exit=0` both times, and `/stats.count` goes up by 1 each time. Today: h2 gives a final 100 with exit 16; h1 gives 100 then 500 with Content-Length 0.
- **b. Superseded deployments** (`edge.rs::preview_gate` 1898-1923): production-target deployments that are not the current production alias are protected like previews unless the project sets `public_superseded:true`. Cold starts are limited per client IP and deployment (`HIVE_COLDSTART_PER_CLIENT_PER_MIN=6`), and tenants get a default quota (`HIVE_FLUID_MAX_INSTANCES_PER_TENANT=40`). Verify: `t --resolve survey-botdemo-e77078e.shadw.app:443:$SJ https://survey-botdemo-e77078e.shadw.app/login.html` returns 401 and no new litebox-runner appears (today: 200 in 3.7 s and a new 296 MB runner).
- **c. Route classification for admin reads** (a layer on `admin::router()`, with a table covering every GET): `/v1/anycast`, `/v1/serve-hosts`, `/v1/leases`, `/v1/fleet-deployments` and `/v1/functions` become operator-or-tenant only on the public API host. Gossip arms are unaffected because they call handlers directly (`gossip.rs:203, 700`). Deploy the UI first (`scripts/deploy-ui-fleet.sh`). `HIVE_ADMIN_READ_AUTH=report` logs anonymous hits per route for 7 days, then switches to `enforce`. Verify: `curl -s -o /dev/null -w '%{http_code}\n' https://api.shadw.cloud/v1/anycast` returns 401 in enforce mode, and the dashboard's network page still loads.
- **d. Diagnostic headers and request id**: always mint the request id on the server and keep the client's value as `x-hive-client-request-id`; always overwrite `x-hive-served-by` (`edge.rs:63-66`); `HIVE_EDGE_DIAG_HEADERS=all|operator|off` switches to `operator` after the UI update.
- **e. Wait-until clamp**: `min(value, HIVE_AFTER_MAX_MS)` at `server.rs:476-478`.

---

### IS-14 — Keep platform interfaces out of iroh, and pool TUNs
*vendor window. Supersedes `sj-iroh-rebind-addrinuse-storm` and `litebox-tun-links-leak-and-iroh-addr-flood`; related to `leader-udp-11204-rebind-addrinuse`.*

**Files and functions**
- `vendor/iroh/src/socket.rs`, the link-change arm (1636-1654): compute `is_major` over the interface state with `platform_iface` interfaces removed. The default-route interface is never removed.
- The same predicate applies to local address collection.
- Record the change in `vendor/iroh/CHANGES.md`.
- `litebox.rs::allocate_link` (1614-1690): take a TUN from a pool of `HIVE_LITEBOX_TUN_POOL=32` devices created at boot, and return it on teardown after flushing its addresses and policy. The rules in `litebox-network-allocation-reentry` apply.

**Knobs.** `HIVE_IROH_IGNORE_IFACE_PREFIXES=lbt,veth,podman,cni-,tap,fc,vnet,virbr,docker,br-`.

**Observability.** Counters `link_change_ignored` and `major_rebinds`.

**Verify.** Run 10 preview cold starts of the probe, 70 s apart, on phx.

```bash
$SSH root@$PHX 'journalctl -u hive-node --since -15min | grep -cE "failed to rebind|Tried to add too many addresses"'   # 0
$SSH root@$PHX 'ip -o link | grep -c ": lbt"'                                                                    # == pool size before and after
```

Today: a failed rebind 0.3–0.6 s after every cell creation (2/2), and 87,808 "too many addresses" lines per hour on sj.

---

### IS-15a — DNS affinity hysteresis
*Ship inside CS-6's commit: same file, same owner.*
- `vercel_dns.rs:2378-2389`: for a label served by more than one node, publish the full sorted set of healthy owners, not the lowest-latency one. Keep the previous set while its members are still valid, for `HIVE_DNS_AFFINITY_HYSTERESIS_PASSES=3` passes.
- Verify: `dig +short autheo-meeting-docs-main.shadw.app @ns1.vercel-dns.com` is identical across 10 consecutive passes, and `journalctl -u hive-node --since -24h | grep 'records created domain=shadw.app' | wc -l` stays ≤ 10. On 09-19 there were 334 passes a day with created=3 deleted=3.

### IS-15 — DNS affinity v2
*Depends on CS-6, `vercel-402-unpaid-invoice`, `dns-label-over-63-chars-dark-preview` and OBS-1.*

**Files and functions**
- `desired_apps_affinity` (597-686): rank by summed `hot` counts; prefer production; exclude preview, branch, commit and dpl labels below `HIVE_DNS_AFFINITY_MIN_HITS=100` per day; filter publishable nodes first, then cap; drop labels over 63 bytes.
- Orphan management in the managed-name derivation (842-906, 2429-2435): at most `HIVE_DNS_ORPHAN_MAX_DELETES_PER_PASS=10` deletes, and none while `creates_blocked()`.
- `HIVE_DNS_APPS_AFFINITY_CAP=60`, raised once the Vercel limit is known.

**Observability.** INFO line `apps affinity: published= ranked_top= flips= orphans_deleted=`.

**Verify.** `dig +short survey-botdemo.shadw.app A @ns1.vercel-dns.com` returns `170.106.158.151` only, and `dig +short dan.shadw.app @ns1.vercel-dns.com` returns the wildcard set or NXDOMAIN.

### IS-16 — Conditional fleet-deployments fetch
*Depends on CS-4 and mac-cs4, because `sync_one_peer` is shared.*
- `/v1/fleet-deployments?if_digest=<blake3-128>` answers `{node, unchanged:true, digest}` when the digest matches (`admin.rs:4173`, `gossip.rs:700`). `?enc=zstd` compresses bodies over 64 KiB.
- `main.rs::sync_one_peer` (4202-4227) sends the last digest it saw. Old peers ignore the query and return the full body.
- Knobs: `HIVE_GOSSIP_CONDITIONAL_FLEET=1`, `HIVE_GOSSIP_ZSTD_MIN_BYTES=65536`.
- Verify: `$SSH root@$SJ 'timeout 10 tcpdump -i eth0 -nn -q -Q out "udp src port 11204" 2>/dev/null | awk "{s+=\$NF} END{print s}"'` totals ≤ 30 % of the same measurement taken before the change. For reference, that measured ~1.0 MB per 3 s to phx and 0.8 MB per 3 s to the laptop's IP.

### IS-17a — Placement aware of egress; avoid the leader
*Depends on IS-8a, CS-3 and mac-cs6.*
- `schedule.rs::place` (662-671, 734-746): stop preferring the coordinator for region-less production projects. Exclude the control-plane owner when another capable public node fits. Exclude nodes above `HIVE_PLACEMENT_EGRESS_MAX_UTIL=0.6`.
- `NodeInfo` egress fields go in after CS-3 and mac-cs6 land; until then they ride in the `/v1/serve-hosts` payload.
- Verify: a throwaway region-less project lands on a node other than the leader with utilization < 0.6.

### IS-17b — Replicate stateless hot apps to the wildcard set
*Depends on IS-12c and IS-17a.*
- Opt in with `fluid.json` `"replicas": "edge"` together with `"stateless": true`: one Ready production instance on every publishable node in the `*` record, `failover=true`.
- Never for projects with volumes, `raw_proxy`, or a `stateful_hint`.
- Verify: every edge serves the probe locally (`x-hive-routed-to` absent).

### IS-18 — Encrypted fallback transport
*Depends on IS-9 and IS-3.*
- `edge.rs:1024-1047`: fall back to `https://<node>--origin.<apps-domain>` through a reqwest `dns_resolver` that maps registry names to public IPs, with Host set to the app host and `x-hive-hop` attached. Plain HTTP only for private addresses in the same VPC.
- Knobs: `HIVE_EDGE_FALLBACK_SCHEME=https`, `HIVE_EDGE_HEDGE_MS=0`.
- Verify: during the IS-3 drill, fallback responses carry `x-hive-transport: https-direct`, and `$SSH root@$SJ 'timeout 30 tcpdump -i eth0 -nn -A "tcp dst port 8787 and src host 43.172.25.45" 2>/dev/null | grep -c "Host: ingress-probe"'` returns 0.

### IS-19 — Guardian transmit breaker
*Gated on `guardian-storm-mechanism-capture` and the CS-10 window. Superseded if CS-11 or `iroh-guardian-endpoint-unify-finding` lands first.*
- In vendored iroh's transmit path, per remote address: when sends exceed `HIVE_IROH_REMOTE_PPS_MAX=5000` for 10 s while less than 1 % as many packets come back, suspend sends to that address for 30 s, log a rate-limited WARN and count it.
- Proven only by replaying the captured mechanism on fc-lax2, never on a production node first.

### IS-20 — Seer as the apps zone's authority (long term)
- `dnsserver.rs:512-548`: apex NS and SOA records, a negative SOA, and REFUSED (not authoritative NXDOMAIN) for zones Seer does not serve.
- At least 3 proven nameservers across at least 2 regions: sj's Seer publicly reachable and declaring `dns_ns`, and phx gets `HIVE_DNS_ADDR`.
- Then change the registrar's NS records and set `HIVE_DNS_SERVE_APPS=1`.
- Staged cutover with a rollback to Vercel NS. Gated on `vercel-limits-and-registrar` and a mesh that has been stable for 7 days.

### IS-21 — Warm-restart adoption (long term)
- Adopt litebox runners and containers from the previous boot into their pools, which needs a deterministic cell-to-deployment mapping and a rebuilt tunnel listener. Extends `cell-adoption-instead-of-reap`.
- Verify: after a restart, `last_runtime_init_ms` is untouched and `x-fluid-reused` stays true.

### IS-22 — Fleet TLS session tickets (low)
- A rustls `Ticketer` with a key derived from `HIVE_SECRET_KEY` and rotated every 24 h (current plus previous), and a session cache of 4096.
- Verify: a session file from va is presented to va3 with `openssl s_client -sess_in` and reports `Reused`. Today it reports `New`.

### IS-23 — Predictive warming (low)
- The first ClientHello with a known SNI for a pool with `min_instances=0` warms it. Rate-limited per deployment (1 per 30 s) and per client IP. Never for unknown hosts.

### IS-24 — In-process mesh dispatch
*Depends on IS-9 and IS-1.*
- `hive-p2p` `serve_tunnels_full` accepts a `LocalDispatch` callback, and the `STREAM_TUNNEL` arm calls the axum service directly with HopContext as an extension. Removes the loopback connect, the HTTP/1.1 re-serialization and the second pipeline pass.
- Verify: probe TTFB on the owner drops by at least 5 ms at the median [I], and the loopback sampler reads 0.

### IS-25 — Firecracker snapshot research
- Measure snapshot and restore of a Node app on va3 (FC). Proceed only if restore is ≤ 500 ms and placement egress headroom allows (va 21 Mbit/s, va3 10 Mbit/s).

### OBS-1 — Edge forward observability
- Owner events carry request_id and project (`edge.rs:1361-1363`); forwarded events carry project from `peer_deployments`.
- Per-label Space-Saving top-K of local vs forwarded counts, exposed at `/v1/edge/labels` and in the `hot` field of `/v1/serve-hosts`.

### OBS-2 — Noisy transport logs become counters
- A tracing layer rate-limits targets `netwatch::udp`, `iroh::socket` and `noq_proto` to one line per 10 s with counts, and exports the counters in `/v1/relay`. journald suppressed 42,771 lines in one burst, so grep-based sizing is unreliable.

---

## 6. Plan

### 6.1 Order (each change set ships on its own)

| Wave | Change sets | Why here | Gate to start |
|---|---|---|---|
| A (now, no code) | `survey-botdemo-tenant-notice`, `sj-egress-cap-decision`, IS-0 fixture, `roll-gate-storm-check`, `dan-shadw-app-dangling-record` | Removes survey-botdemo's logouts once the tenant sets `SESSION_SECRET` and `DATABASE_URL`; creates the verification surface; watches for the storm | none |
| B | IS-0b, IS-1, IS-2 | The two HIGH cross-tenant issues; small diffs; no wire change | IS-0 deployed |
| C | IS-3, IS-4, IS-6, IS-8a, OBS-1, OBS-2 | Removes the 15 s, 30 s and 503 failure classes; makes CS rolls cheap; detects the storm | IS-3 after CS-3's hive-p2p commit (or before CS-3 starts) |
| D | IS-5, IS-7, IS-12c | Removes cold-start amplification; closes the per-process-secret class | IS-5 after IS-1 |
| E | IS-9, IS-10, IS-11, IS-13a–e | Security and body/cache correctness | UI deploy before IS-13c enforce; IS-9 enforce after 24 h clean |
| F (vendor window) | IS-14, IS-8b, IS-19 | `vendor/iroh` and `vendor/guardian-db` | With or after CS-10's 48 h phx canary; never in mac-cs2's (vendor/noq) roll |
| G | IS-15a (inside CS-6), IS-15, IS-16, IS-17a | The files belong to CS-4, CS-5 and CS-6 | Those commits landed; invoice paid |
| H | IS-12a, IS-12b, IS-18, IS-17b | Session model, encrypted fallback, replication | IS-9 enforce; IS-12b on litebox after `litebox-raise-connect-permits` |
| I (long term) | IS-20, IS-21, IS-22, IS-23, IS-24, IS-25 | Structural and optional | Section 5 gates |

### 6.2 Coexisting with the control-plane work (CS-1, CS-2, CS-7 are live as of 43445a9; CS-3 through CS-6 and CS-8 through CS-11 are pending; mac-cs1 through mac-cs9 are in wf_392d7a31)

| Change set | Functions touched | Shared with | Rule |
|---|---|---|---|
| IS-1 | fluid-tunnel `serve`/`proxy_local`/`handle_request`; `LiteboxBackend::new`; `main.rs` backend selection (652-740) and line 1583 | main.rs: CS-3 (`spawn_cluster_loop` 3664, `admin_ingress` 2599, `admin_loopback_forward` 2421), CS-4 (`spawn_relational_mirror_loop` 5178), CS-5 (cron 3794, billing and guardian loops), mac-cs1 (early `main()` instance lock) | Different functions; rebase only; separate roll |
| IS-2 | `main.rs` `https_router` (2186-2215); `edge_pipeline_inner`; `Gateway::select` | main.rs as above | Different functions |
| IS-3 | hive-p2p `request_stream`, `TunnelStream`, relay stats; fluid-tunnel; edge mesh block | hive-p2p/lib.rs: CS-3 (`PeerPool::sign_blob`/`verify_blob`, new), mac-cs3 (`PeerPool::reset_dial_state`, new), mac-cs4 | Never edit hive-p2p/lib.rs at the same time as CS-3 or mac-cs3; land before or after, not during |
| IS-4 | `state.rs::merge_routes_ttl`, `PeerRoute`; `main.rs::spawn_gossip_loop` (4487-4497); edge candidates | state.rs: CS-3 (`cp_owner`, `is_control_plane_leader`); main.rs: mac-cs4 (`sync_one_peer` 3905+) | Different functions; tell the mac-cs4 owner |
| IS-5 / IS-6 | fluid-compute; fluid-gateway `proxy_function`, `restore`, `reconcile_keepwarm`; `main.rs::spawn_lease_loop`; `CellBackend` trait | hive-backend/src/lib.rs: `cell-adoption-instead-of-reap` | Agree the trait change with that row |
| IS-7, IS-11 (litebox part), IS-14 (TUN pool) | litebox.rs | Other litebox rows only | Serialize these three among themselves |
| IS-8a | new module; one admin route | admin.rs route list: CS-3 (`/v1/cp/status`) | Rebase only |
| IS-8b, IS-14, IS-19 | vendor/iroh, vendor/guardian-db | CS-10 (vendor/iroh actor chain), mac-cs2 (vendor/noq), CS-11 (guardian removal) | Between rolls only; the CS-10 canary window; not in the same roll as mac-cs2 |
| IS-9, IS-10, IS-18, IS-24 | edge.rs, fluid-gateway, fluid-tunnel | none in CS | Free |
| IS-13c | `admin::router` layer, auth.rs | admin.rs: CS-3, CS-5 (`git_webhook`, domain verify), CS-8 (billing and gitops GETs) | Route-table lines only; tell the CS-8 owner |
| IS-15, IS-15a | vercel_dns.rs owners, affinity, managed names | CS-5 (`spawn_reconciler`), CS-6 (`reconcile_zone`, `publishable`, `desired_platform`, `alarm_dark_names`) | IS-15a goes inside the CS-6 commit; IS-15 strictly after |
| IS-16 | gossip.rs fleet arm; `admin::fleet_deployments`; `main.rs::sync_one_peer` | CS-4 (`/v1/store-digests` arm), CS-8 (delete cascade), mac-cs4 (`sync_one_peer`) | After CS-4 and mac-cs4 |
| IS-17a | schedule.rs; `NodeInfo` | CS-3 (`cp_lease`), mac-cs6 (`NodeInfo.build`) | After both; serve-hosts payload until then |

### 6.3 Canary protocol, every roll
1. **Order.** va3, then va, then phx, then sj.
   - Entry-side changes (IS-2, IS-3, IS-4, IS-9, IS-11) are proven on va3.
   - Owner-side changes (IS-1, IS-5, IS-6, IS-7, IS-10) are proven on phx, which hosts ingress-probe-phx, before sj.
2. **Gates between nodes, 30–60 min.** The §5.0 roll gate (regression matrix, storm check at +2 and +30 min, mesh health), plus the change set's own verification on the node that proves it.
3. **Stop and roll back** on any of: a control-plane owner change; `isolated` or `accept_stuck` rising; a storm; a 5xx in the regression matrix; the change set's abort signal from section 7.
4. **Rollback preference.** Runtime flag first (no restart), then the `.old` binary. A restart reaps and cold-starts every cell: about 60–85 s of production impact on sj today, ≤ 12 s after IS-6 and IS-7.

---

## 7. Contingencies

### 7.1 Per change set

| Change set | Failure during rollout | Detection | Abort / rollback |
|---|---|---|---|
| IS-1 | Guest permits accidentally > 1, bringing back litebox accept races | journal `function closed before headers` / `exhausting retries` above 1 per hour; `/v1/tunnel/gates` guest permits ≠ 1 | `tunnel.gate_policy=legacy` |
| IS-1 | Owner overloaded now that mesh ingress runs in parallel | `FUNCTION_THROTTLED` events; hive-cloud CPU; memwatch | `tunnel.gateway_permits=32` |
| IS-1 | Idle deadline cuts legitimate SSE or long-poll | `idle_timeouts` above 0 on streaming hosts | `tunnel.body_idle_ms=900000` |
| IS-1 | Cancellation kills live responses | `cancelled` rising together with 502s | `tunnel.cancel=off` |
| IS-2 | A legitimate internal caller relied on the header over 443 | `internal_headers_stripped` by source (expected 0) | Flag off; add the source to an allowlist |
| IS-2 | Losing the default deployment breaks dev or the `_vercel` beacon | 404 spike on bare-IP or empty Host | `HIVE_GATEWAY_DEFAULT_FALLBACK=1` |
| IS-3 | False "transport dead" under loss when talking to old owners | `deliver_timeouts / attempts` above 1 % | `p2p.first_frame_ms=6000`; `forward.two_signal=off` |
| IS-3 | Visible aborts reported as errors (expected; they used to be silent) | `body_aborts`; tenant reports | None; tell tenants; `forward.keep_content_length=off` only if hyper misbehaves |
| IS-4 | Stale route sends traffic to a node that no longer hosts the app | 421/404 rate from stale candidates | `route.max_stale_ms=30000` |
| IS-5 | Make-before-break briefly doubles memory | memwatch; host memory | `fluid.make_before_break=0` |
| IS-5 | A detached cold start outlives shutdown | `reaped>0` in the next boot's orphan reap | Fluid owns the JoinSet; `fluid.detached=0` |
| IS-5 | Waiters hit 25 s on a hung start | `COLD_START_IN_PROGRESS` 503s | Raise `fluid.coldstart_wait_ms`; investigate the start |
| IS-6 | A production pool is misclassified and starts cold on its first request | Cold-start INFO lines within 5 min of boot for production pools | `boot.warm_nonprod=1` |
| IS-7 | GC removes an archive in use, so the runner fails with ENOENT | guest stderr `No such file or directory (os error 2)` on spawn | `litebox.artifact_lock=global` |
| IS-7 | The memo hides tampering | Scrubber mismatch incident | Quarantine; `litebox.hash_memo=off` |
| IS-8a | Cap unknown (non-Tencent) or wrong unit | `cap_bps=0` or util > 1.5 | Set `HIVE_EGRESS_CAP_BPS` in the inventory |
| IS-9 | Clock skew or key mismatch | `hop_skew`, `hop_bad_sig` | Stay in `report`; fix NTP or keys |
| IS-9 | Apps relied on the client-supplied XFF | Tenant reports | Intended; announce beforehand |
| IS-10 | Backpressure stalls | `backpressure_events` counter (#14) | `tunnel.channel_frames=256` |
| IS-11 | Stale or poisoned content after a deploy | HIT carrying the wrong deployment id | `cdn.entry_cache=off`; `/v1/cdn` purge |
| IS-12a | Hot-spotting | `affinity_fallback` ratio above 20 % | Turn off per project |
| IS-12b | WebSockets starve the litebox guest gate | Guest gate waiters with open WebSockets | `HIVE_WS_FUNCTIONS=0` |
| IS-13c | Dashboard pages break | UI errors; report counts | `admin.read_auth=report` |
| IS-13b | Legitimate old-URL sharing breaks | 401s on superseded aliases | Project `public_superseded:true` |
| IS-14 | Filter hides a real uplink change and the mesh goes dark | `/v1/mesh` isolated; relay-only | `HIVE_IROH_IGNORE_IFACE_PREFIXES=""`; roll back vendor |
| IS-14 | TUN pool reuse collides | Allocation errors per `litebox-network-allocation-reentry` | `litebox.tun_pool=0` |
| IS-15 | A mis-ranked label points at a non-serving node | `alarm_dark_names`; 421/404 on that label | Cap back to 60; the CS-6 rules prevent unsafe deletes |
| IS-16 | Digest bug leaves peers with stale lists | `unchanged=true` while peer counts differ | `gossip.conditional_fleet=off` |
| IS-17b | Replicas of a mislabelled stateful app diverge | `stateful_hint` present; tenant reports | Remove `replicas`; never automatic |
| IS-18 | TLS fallback slower or failing | `http_fallbacks` failure ratio | `edge.fallback_scheme=http` (fleet IPs only) |

### 7.2 If Vercel DNS stays frozen (the 402 returns or persists)
- **Signal.** `vercel create … 402` in every pass, or no `records created` line for 24 h.
- **Still ships without DNS writes:** IS-1 through IS-14, IS-16, IS-17a/b, IS-18 and the OBS rows.
- **Actions:**
  1. The CS-6 rule already forbids deleting records while creates are blocked. Leave it on.
  2. IS-15a stops the va/va3 flip churn, so a paid-up account does not trip fair-use again.
  3. Local serving without DNS: IS-17b replicas make every wildcard IP an owner for opted-in stateless apps; IS-11's entry cache removes the hop for cacheable assets; IS-1, IS-3 and IS-4 cap the cost of a forward at about one RTT plus owner time.
  4. The exit from Vercel record writes is IS-20 (Seer). It depends on who the registrar is and whether NS can be changed during the soft block (`vercel-limits-and-registrar`).
  5. Hard deadline: the wildcard certificate reissue window opens 2026-10-20 (row `vercel-402-unpaid-invoice`). CS-6 moves DNS-01 TXT records into the Seer store under delegation, and needs to land before then.

### 7.3 If the mesh transport degrades
- **Signals.**
  - egresswatch utilization ≥ 80 %
  - forward-stats deliver or heartbeat timeouts above 1 % of attempts
  - more than 10 `trunk opened` per hour for one node pair
  - `failed to rebind` above 0
  - `/v1/mesh` isolated, or `visible_healthy_peers` falling
- **Automatic behavior after IS-3 and IS-4.** Fallback within ≤ 3.2 s, routes kept for 10 min, a 120 s cooldown per candidate.
- **Operator ladder:**
  1. Find the top egress flow with the storm check.
  2. If it is the guardian endpoint, follow 7.4.
  3. If real user traffic exceeds the cap, raise the EIP bandwidth: sj 40 Mbit/s, va 21, va3 10.
  4. Priority for 443, 80, 11204 and 3343 over everything else on the saturated node, using a throwaway nft table or tc class. Try it on va3 first, never first on the leader, and remove it after.
  5. Move hot production apps off the saturated node by explicit region pinning.
  6. Restart only as a last resort, with `orphan_reap_ran()` true, and budget for the boot storm.

### 7.4 If the guardian storm recurs before IS-19 or CS-11
- **Detection.** The roll-gate storm check at +2 and +30 min after every restart (the last storm started 30 s after a boot), and IS-8a.
- **Capture first** (`guardian-storm-mechanism-capture`):
  - 30 s of `tcpdump -i eth0 -nn -Q out -c 200000 'udp src port <guardian port>' -w` (headers only)
  - `ss -uanpm` on both ends
  - journal lines for `dropped transmit`, `failed closing path`, `PTO expired`
- **Contain.**
  - With IS-8b in place: rate-limit the pinned port on the sender with `nft … udp sport 11205 limit rate over 2000/second drop` in a throwaway table, and remove it after capture.
  - Without it: raise the EIP bandwidth, then as a last resort restart the sender's hive-node.
- **Structural fix.** IS-19, or `iroh-guardian-endpoint-unify-finding`, or CS-11.

### 7.5 Cold-start storms caused by rolls
- **Until IS-6 and IS-7 ship:**
  - Roll sj last, in a low-traffic window.
  - Expect 60–85 s of production unavailability on sj per restart.
  - Use the IS-4/IS-3 fallbacks where they exist.
- **After they ship:** measure `max(last_runtime_init_ms) ≤ 12000` at boot + 120 s on every roll, and abort further rolls if it exceeds 20 000.

---

## 8. PRD rows to queue

```json
[
{"id":"ingress-probe-fixture","subject":"IS-0: deploy an operator-owned Express probe app (/fast /size /chunked /die-midbody /sleep /sse /headers /cookie /static /count /ws /instance /stats /secret-digest) as ingress-probe + ingress-probe-b on fc-sanjose, ingress-probe-phx on fc-phoenix, ingress-probe-va3 on fc-virginia-3, plus a min_instances 0 commit alias; source outside this repo; every IS-* verification uses it","witness":"2026-09-25 investigation could only time tenant apps (survey-botdemo, survey123, tokenhun, nodes-wtf) and could not exercise cancellation, SSE, WS, Set-Cookie caching, Expect or affinity without touching tenant state","depends_on":[]},
{"id":"runtime-flags-kill-switches","subject":"IS-0b: node-local operator GET/PUT /v1/runtime-flags on 8786 (exempt from leader forwarding) backed by one in-memory table initialised from env; every IS-* behaviour reads its flag so rollback needs no restart","witness":"each hive-node restart reaps and cold-starts every cell: 02:46Z sj restart gave 60 serialized cold starts, survey-botdemo 41.0 s and 85.5 s, 2 abandoned starts, ~10 nack 504s; main.rs:2390 owner_routed is the existing exemption list","depends_on":[]},
{"id":"tunnel-gate-scope-deadline-cancel","subject":"IS-1: replace the process-global 1-permit connect gate with per-endpoint-class gates (gateway 256, litebox guest 1 only when litebox is selected, containers 64), connect 3 s / body-idle 300 s deadlines, stream-bound cancellation of every proxy_local exchange, /v1/tunnel/gates and a held-gate WARN naming host and rid","witness":"main.rs:690 LiteboxBackend::default() on every node calls litebox.rs:1322 set_local_connect_permits(1); fluid-tunnel server.rs:396-446 permit held for the whole exchange with no timeouts; hive-p2p lib.rs:4814-4820 mesh arm proxies to 0.0.0.0:8787; live: 18+24 forwarded exchanges with 0 overlaps, 590 samples max 1, holds of 60-168 s with 0 response bytes, cross-tenant victim TTFB 2.52-2.56 s vs 0.07-0.15 s (2/2), survey123 down >=5 min","depends_on":["ingress-probe-fixture","runtime-flags-kill-switches"]},
{"id":"hop-trust-minimal-hotfix","subject":"IS-2: PublicIngress layer on the 443/80 listeners strips x-hive-*/x-fluid-*/x-mfe-*/forwarding headers and lowercases Host; x-hive-proxied honoured only from loopback or roster IPs; Gateway::select returns no default deployment for a named host; proxied-but-unserved answers 421 MISROUTED","witness":"live: forged x-hive-proxied via va3 returned another tenant's page (200, 10,114 B, 'Autheo — Meeting Docs') for survey-botdemo.shadw.app; via phx it cold-started cell-6fabef80 in 42.24 s; uppercase Host returned 503; empty Host returned sj's default app; code edge.rs:458,563,1147 and fluid-gateway lib.rs:2371","depends_on":[]},
{"id":"mesh-forward-two-signal-lifecycle","subject":"IS-3: capability-gated Accepted/RespAbort/Cancel frames, deliver (2 s) and heartbeat (5 s gap) signals instead of the 15 s first-byte cutoff, typed tunnel errors so the iroh cooldown always arms, per-request streams that finish and cancel on drop, Content-Length preserved and mid-body failures surfaced as RST/close, /v1/edge/forward-stats and tunnel_streams_open","witness":"hive-p2p lib.rs:3471-3474 nested same-budget timeouts let the untyped inner head timeout win, so edge.rs:979-982 never arms the cooldown; live runs of 15.08-15.8 s TTFB and 502 at 30.0-30.37 s; truncated 200s of 0/10,334, 7,707/10,334 and 15,911, 7,719, 56,871, 138,791 of 360,663 B; leakprobe proved TunnelServer::serve never returns after the client drops","depends_on":["tunnel-gate-scope-deadline-cancel"]},
{"id":"route-liveness-registry-carry","subject":"IS-4: merge_routes_ttl keeps an unreached peer's routes while the registry keeps it alive (<=10 min, stale=true), and the edge falls back to Ready peer_deployments on registry-healthy nodes before answering DEPLOYMENT_NOT_READY","witness":"state.rs:37 ROUTE_TTL_MS=30000 and :44-66 drop routes about 30 s after the last successful serve-hosts fetch while health.rs keeps the peer healthy; live 503s in 49-51 ms for ~21 s windows; va ring had 52 deployment-not-ready vs 58 forwarded for survey-botdemo","depends_on":[]},
{"id":"fluid-lifecycle-mbb-singleflight","subject":"IS-5: make-before-break replacement, age recycling off by default and never for volume/raw pools, one detached cold-start flight per pool with Notify wakeups, a 25 s caller wait then 503 COLD_START_IN_PROGRESS, non-blocking reconcile, nack-aware scale-out, CellBackend::is_alive liveness","witness":"fluid-compute lib.rs:67-75,2062-2096 break-before-make: 02:40:17Z recycle gave 0 instances and TTFB 8.59 s vs 51 ms with 2 duplicate starts; :1384-1385 800 ms coalesce then duplicates (tokenhun 5 scale-outs for 6 requests); :2115-2173 join_all blocked the autoscaler >2 min at boot; 12 nack 504s for survey-botdemo in 6 min","depends_on":["tunnel-gate-scope-deadline-cancel"]},
{"id":"boot-warm-production-first","subject":"IS-6: restore registers only current production pools as warm (non-production min_instances 0), keep-warm reconciled synchronously after restore, production pools warmed first by traffic and staggered 250 ms","witness":"fluid-gateway lib.rs:2216-2312 restores every deployment with its manifest min_instances; at 02:48Z 44 of 46 non-production pools on sj had an instance or provisioning slot; 5 of 6 boot readiness failures were superseded deployments","depends_on":[]},
{"id":"litebox-coldstart-pipeline","subject":"IS-7: per-image artifact lock plus ArchivePin released before spawn, hash once at delivery with a stat-tuple memo and 24 h scrubber, single identity computation, READY signal from the in-guest guard with poll fallback, runtime-aware readiness budget, per-phase INFO cold-start line, boot sweep of DOWN lbt devices","witness":"litebox.rs:4767-4992 node-wide artifact_lock held through the 15 s readiness wait; post-restart init staircase of 1.6-2.5 s per step to 61.8-65.7 s; survey-botdemo 41.0 s and 85.5 s; app tar hashed 4x per start (~837 MB, ~0.64 s inferred); 836 ms from cell creation to runner exec","depends_on":["fluid-lifecycle-mbb-singleflight"]},
{"id":"egresswatch-saturation-alarm","subject":"IS-8a: egresswatch samples default-route NIC tx every 5 s against the provider limit (Tencent metadata or HIVE_EGRESS_CAP_BPS), attributes mesh vs guardian endpoint bytes, WARNs at 80 % for 60 s, opens a deduped incident after 5 min, serves /v1/egress","witness":"sj NIC at 34.6-47.1 Mbit/s vs bandwidth-limit-egress 41943040 for ~4.4 h with nothing in any alarm; one UDP flow sj:60541 to phx:45494 was 78-79 % of bytes and 98-98.7 % of packets","depends_on":[]},
{"id":"guardian-endpoint-port-pin","subject":"IS-8b: bind the GuardianDB iroh endpoint to HIVE_GUARDIAN_IROH_PORT (fleet 11205, default 0 = ephemeral) so its traffic can be attributed and policed","witness":"vendor/guardian-db core/mod.rs ~2270 binds an ephemeral port; the flood socket moved fd 16 to 1289 across rebinds and could not be policed by port","depends_on":["va-cs10-vendored-iroh-bounds"]},
{"id":"hop-context-client-ip-entry-policy","subject":"IS-9: HopContext minted at the entry and HMAC-signed hop to hop (HKDF from HIVE_SECRET_KEY); rate limit, WAF IP rules and bot checks at the entry on the real client IP; X-Forwarded-For/X-Real-IP/Forwarded set by the platform and never passed through; Connection-nominated headers stripped; ws_proxy replays allowlisted headers only","witness":"owner sees 127.0.0.1 for every iroh forward (edge.rs:112); sj rate limiter blocked 803 with 8 keys while entries blocked 0; exhaustive search found no XFF setter (fluid-gateway lib.rs:4989-5019); survey-botdemo's login throttle keys on x-forwarded-for[0]","depends_on":["hop-trust-minimal-hotfix"]},
{"id":"bounded-bodies-sized-streaming","subject":"IS-10: bounded tunnel channels (64 frames), gateway streams Content-Length responses instead of buffering, owner cache checks policy before buffering and tee-stores, request bodies over 16 MiB get 413 instead of being forwarded empty","witness":"fluid-gateway lib.rs:5353-5366 buffers every sized response with no cap; unbounded channels client.rs:60,173 and server.rs:126; edge.rs:843-847 forwards >16 MiB bodies empty; edge.rs:1366-1381 serves empty 200s; sj RSS 3.9-4.4 GB above the 3,072 MB memwatch threshold","depends_on":["mesh-forward-two-signal-lifecycle"]},
{"id":"cdn-storable-variant-entry-cache","subject":"IS-11: one cdn::storable predicate (refuse Set-Cookie, Vary */cookie/authorization, credentialed requests unless public/s-maxage), key host+deployment+path+variant, byte-budget LRU with Arc bodies, entry-edge lookup before forwarding with tee-store and conditional revalidation, litebox tar mtime = commit time so ETags change per deploy","witness":"cdn.rs:101-103 key is host+path; :138-214 stores Set-Cookie; Accept-Encoding identity got a gzip HIT on nodes-wtf; entry forwards before its cache lookup (edge.rs:563-1135 vs 1276); weak ETag W/'285e-0' with Last-Modified 1970 returns 304; litebox.rs:3589 set_mtime(0)","depends_on":["bounded-bodies-sized-streaming","hop-context-client-ip-entry-policy"]},
{"id":"session-affinity-signed-cookie","subject":"IS-12a: opt-in fluid.json affinity (cookie __hive_aff with MAC over host, tenant, deployment, node, cell and expiry using an HKDF-derived key), honoured only for the currently serving deployment on a healthy hosting node and a non-draining cell with free slots, never a failure cause, stripped before the app","witness":"no affinity at any layer: edge.rs:2328-2360 round-robin rotation, fluid-compute lib.rs:1487-1501 least-inflight; survey-botdemo instance changed ad392e07 to 16207546 to af8036b2/dd6398ae within 1.5 h","depends_on":["fluid-lifecycle-mbb-singleflight","hop-context-client-ip-entry-policy"]},
{"id":"websocket-functions-owner-upgrade","subject":"IS-12b: owner serves WebSocket upgrades for functions via local_ws_proxy when serving locally or for an authenticated hop, a non-101 upstream answers 502 WS_UPGRADE_REFUSED, per-deployment WS cap; on litebox only after guest concurrency >= 2 is proven","witness":"live: upgrade via phx and va3 returned 200 with content-length 0; server.rs:596-601 strips upgrade/connection; edge.rs:563,760-834 WS path only in the mesh block; serve_raw bypasses connect_gate","depends_on":["tunnel-gate-scope-deadline-cancel","litebox-raise-connect-permits"]},
{"id":"managed-session-secret-stateful-lint","subject":"IS-12c: inject a derived per-project HIVE_SESSION_SECRET (HMAC over HKDF(HIVE_SECRET_KEY), never stored), optional session_secret_env mapping when unset, and a build lint that flags per-instance state (express-session without store, JSON storage, missing DATABASE_URL)","witness":"survey-botdemo project env is []; its authService.js falls back to randomBytes(32) per process and storage/index.js uses per-instance JSON, so every recycle, restart, scale-out and deploy logs users out and forks data","depends_on":[]},
{"id":"expect-continue-interim-heads","subject":"IS-13a: drop Expect before forwarding and loop past interim 1xx heads (not 101) in proxy_local so the final response is never a 100","witness":"live: POST with Expect over h2 gave a final HTTP/2 100 (curl exit 16) after the app executed; over h1 gave 100 then 500 with content-length 0; server.rs:437-446,494-497","depends_on":[]},
{"id":"superseded-deployment-protection","subject":"IS-13b: superseded production deployments protected like previews unless public_superseded is set, per-client-IP cold-start rate limit (6/min per deployment), default tenant instance quota 40","witness":"16 superseded survey-botdemo deployments are Ready and public; two anonymous requests cold-started them in 3.72 s and 3.75 s creating 296 MB and 269 MB runners; edge.rs:1898-1923; max_instances_per_tenant=0 at fluid-compute lib.rs:335","depends_on":["hop-context-client-ip-entry-policy"]},
{"id":"admin-read-route-classification","subject":"IS-13c: classify every admin GET as public, tenant or operator in one router layer (report mode for 7 days, then enforce); anycast, serve-hosts, leases, fleet-deployments and functions no longer anonymous on the public API host; UI deployed first","witness":"api.shadw.cloud without a token returned /v1/anycast (15,775 B with private 10.0.0.x addresses, peer ids and backend mock), /v1/serve-hosts (1,827 hosts, 1,043 dpl ids), /v1/leases (36), /v1/functions, /v1/ratelimit, /v1/mesh; auth.rs:255-279 never rejects a GET","depends_on":[]},
{"id":"edge-diag-headers-request-id","subject":"IS-13d: server-minted request ids (client value kept as x-hive-client-request-id), x-hive-served-by always overwritten, diagnostic x-hive-*/x-fluid-* headers gated behind HIVE_EDGE_DIAG_HEADERS after the dashboard update","witness":"edge.rs:364-366 accepts a client request id verbatim (a forged value was echoed); edge.rs:63-66 sets served-by only when absent so tenants can spoof it; locally served responses carry no request id","depends_on":["hop-context-client-ip-entry-policy"]},
{"id":"wait-until-clamp","subject":"IS-13e: clamp x-fluid-wait-until-ms to HIVE_AFTER_MAX_MS in proxy_local","witness":"server.rs:476-478 parses the tenant header unbounded; the gateway holds the lease and in-flight count for that long (fluid-gateway lib.rs:5301-5343), blocking drain and recycle (partially confirmed: guest and mesh permits are not held)","depends_on":[]},
{"id":"iroh-platform-iface-filter-tun-pool","subject":"IS-14: vendored iroh ignores platform interfaces (lbt, veth, podman, cni-, tap, fc, vnet, virbr, docker, br-; never the default-route interface) for major link changes and advertised addresses, plus a litebox TUN pool so cold starts never add or remove interfaces; supersedes sj-iroh-rebind-addrinuse-storm and litebox-tun-links-leak-and-iroh-addr-flood","witness":"failed rebind AddrInUse 0.3-0.6 s after each cell creation (2/2 at 03:04:51Z and 03:05:28Z, 1,376 and 1,590 dropped transmits); netwatch-0.19.1 interfaces.rs:319 treats any interface add/remove as major; 87,808 'too many addresses' per hour on sj","depends_on":["va-cs10-vendored-iroh-bounds"]},
{"id":"dns-affinity-hysteresis-in-cs6","subject":"IS-15a (ship inside the CS-6 commit): replicated labels publish the full sorted healthy owner set and keep a still-valid set for 3 passes instead of flipping to the lowest-latency node every pass","witness":"vercel_dns.rs:2384 picks the minimum-latency route; autheo-meeting-docs-* flip between va and va3 on ~3 ms differences; 334 passes/day with created=3 deleted=3 on 09-19; churn resumed 01:57-02:30Z after creates came back; the fair-use/402 link is inferred","depends_on":["va-cs6-dns-correctness"]},
{"id":"dns-affinity-v2-ranked","subject":"IS-15: owner records ranked by summed per-label traffic (not alphabet), previews/branches/commits excluded unless hot, publishable filter before the cap, <=63-byte labels, orphan records pointing at fleet IPs managed with <=10 deletes per pass and none while creates are blocked, cap raised once Vercel limits are known","witness":"vercel_dns.rs:642-643 sorts and truncates to APPS_AFFINITY_CAP=60 (:994) before the publishable filter; survey-botdemo is 103rd of 109 sj labels and 117th fleet-wide; 20-27 labels resolve only via the wildcard; ~45 specific records sit outside the managed window; dan.shadw.app points at a non-registry IP","depends_on":["va-cs6-dns-correctness","vercel-402-unpaid-invoice","dns-label-over-63-chars-dark-preview","edge-forward-observability"]},
{"id":"fleet-deployments-conditional-fetch","subject":"IS-16: /v1/fleet-deployments answers unchanged when the caller's digest matches, and zstd-compresses payloads over 64 KiB; old peers ignore the query and get the full body","witness":"sj's /v1/fleet-deployments is 809,146-810,204 B and every peer (including the laptop nodes behind 142.129.107.198) pulls it every 5-13 s round (main.rs:4202-4227, gossip.rs:700); after the flood, 11204 flows were sj's top egress","depends_on":["va-cs4-db-free-replication","mac-cs4-fleet-never-forgets-member"]},
{"id":"placement-egress-aware-leader-avoid","subject":"IS-17a: region-less new production projects avoid the control-plane owner and nodes above 60 % egress utilisation; existing projects move only by explicit operator relocation","witness":"schedule.rs:662-671 and :734-746 prefer the coordinator, which is the leader because deploys are leader-forwarded; sj hosts 109 of 128 eligible labels on a 40 Mbit/s cap; 132 of 226 projects have no region and 223 have failover=false","depends_on":["egresswatch-saturation-alarm","va-cs3-cp-lease","mac-cs6-topology-source-node-presence"]},
{"id":"replicate-stateless-hot-apps-wildcard","subject":"IS-17b: opt-in fluid.json replicas=edge with stateless=true runs one Ready production instance on every publishable node in the wildcard set (failover=true), never for volume, raw or stateful-hinted projects, so every DNS answer is an owner even while DNS writes are frozen","witness":"the wildcard returns 3-4 IPs for one host, so 75-100 % of requests are forwarded; owner-local serve takes 44-54 ms vs 1-10 s forwarded during the flood","depends_on":["managed-session-secret-stateful-lint","placement-egress-aware-leader-avoid"]},
{"id":"encrypted-fallback-transport","subject":"IS-18: HTTP fallback goes over HTTPS to the owner's 443 using <node>--origin names resolved from the registry, keeps Host, carries x-hive-hop, and uses plain HTTP only for private addresses in the same VPC; hedging stays off until forward-stats justify it","witness":"edge.rs:1024-1047 sends tenant cookies, Authorization headers and bodies as http://170.106.158.151:8787 across providers (phx Hostinger to sj Tencent); live responses carried x-hive-transport: http-direct; the lockdown limits who can connect to 8787, not who can read the traffic","depends_on":["hop-context-client-ip-entry-policy","mesh-forward-two-signal-lifecycle"]},
{"id":"guardian-storm-breaker","subject":"IS-19: per-remote transmit breaker in vendored iroh (suspend sends to an address for 30 s when more than 5000 pps go out for 10 s and fewer than 1 % as many come back), proven only by replaying the captured mechanism on fc-lax2; superseded if va-cs11-db-decoupling-stage2 or iroh-guardian-endpoint-unify-finding lands first","witness":"the guardian endpoint kept sending ~64k pps of ~30-byte packets to phx:45494 after phx had closed that port and was answering ICMP port-unreachable; fewer than 0.1 % arrived; it ran from 22:22:53Z to 02:46Z","depends_on":["guardian-storm-mechanism-capture","va-cs10-vendored-iroh-bounds"]},
{"id":"seer-apps-zone-authority","subject":"IS-20: Seer becomes the apps-zone authority: apex NS/SOA and a negative SOA, REFUSED for zones it does not serve, at least 3 proven nameservers across at least 2 regions, a registrar NS cutover with rollback, then HIVE_DNS_SERVE_APPS=1","witness":"HIVE_DNS_SERVE_APPS is unset on all 4 nodes; only fc-virginia and fc-virginia-3 are proven nameservers (one region); dnsserver.rs:512-548 apps branch has no NS/SOA; unserved zones get an authoritative NXDOMAIN with no SOA","depends_on":["dns-affinity-v2-ranked","vercel-limits-and-registrar"]},
{"id":"litebox-warm-restart-adoption","subject":"IS-21: adopt running litebox runners and containers from the previous boot into their pools (deterministic cell-to-deployment mapping, rebuilt tunnel listener) instead of reaping and cold-starting them","witness":"every restart reaps every cell: 13 sj restarts since 09-18; the 02:46Z restart cost 60 cold starts (41.0 s and 85.5 s for survey-botdemo); extends cell-adoption-instead-of-reap","depends_on":["cell-adoption-instead-of-reap","litebox-coldstart-pipeline"]},
{"id":"tls-fleet-session-tickets","subject":"IS-22: a TLS 1.3 session-ticket key shared across the fleet, derived from HIVE_SECRET_KEY (current plus previous, rotated every 24 h), and a 4096-entry session cache, so resumption works across round-robin edges","witness":"acme.rs:203-209 configures no ticketer; openssl s_client reports Reused on the same node but New when a va ticket is presented to va3; handshake medians 96-198 ms, sj p90 0.89 s","depends_on":[]},
{"id":"predictive-warm-on-sni","subject":"IS-23: the first ClientHello with a known SNI for a min_instances 0 pool sends the owner a warm hint, rate-limited per deployment (1 per 30 s) and per client IP, never for unknown hosts","witness":"scale-to-zero previews pay a 3.09-5.55 s cold start on the first request; the TLS handshake and first-request round trips from remote clients take 0.2-1.0 s that could overlap the start","depends_on":["fluid-lifecycle-mbb-singleflight","hop-context-client-ip-entry-policy"]},
{"id":"mesh-inprocess-dispatch","subject":"IS-24: the STREAM_TUNNEL arm calls the local axum service in-process with HopContext instead of re-serializing HTTP/1.1 to 0.0.0.0:8787 over loopback and running the edge pipeline twice","witness":"server.rs:397-431 opens a fresh loopback TCP connection for every forwarded request; captures showed one 127.0.0.1->8787 connection per request at 44-58 ms each; edge.rs:1174-1358 runs a second full pipeline pass","depends_on":["hop-context-client-ip-entry-policy","tunnel-gate-scope-deadline-cancel"]},
{"id":"firecracker-snapshot-coldstart-research","subject":"IS-25: measure Firecracker snapshot/restore of a Node app on fc-virginia-3; adopt it for apps placed on FC nodes only if restore takes 500 ms or less and egress headroom allows (va capped at 21 Mbit/s, va3 at 10 Mbit/s)","witness":"litebox has no snapshot support; the intrinsic litebox cold start is 2.9-3.1 s, 1.17 s of it loading libnode; the FC nodes va and va3 host no pools today","depends_on":["ingress-probe-fixture"]},
{"id":"edge-forward-observability","subject":"OBS-1: owner events carry request_id and project, forwarded events carry project from peer_deployments, and per-label local vs forwarded counts (Space-Saving top-K) are served at /v1/edge/labels and in the hot field of /v1/serve-hosts","witness":"owner compute-path events are recorded without request_id (edge.rs:1361-1363); forwarded events have project ''; x-hive-request-id could not be traced into sj; the fleet-wide forwarded fraction could only be inferred from DNS structure","depends_on":[]},
{"id":"noisy-transport-log-counters","subject":"OBS-2: a tracing layer rate-limits netwatch::udp, iroh::socket and noq_proto to one line per 10 s with counts, and exports the counters in /v1/relay","witness":"journald suppressed 42,771, 44,283 and 30,226 messages per 30 s during rebind bursts; ~90k socket-closed and ~89k dropped-transmit lines per hour made grep-based sizing wrong (the refuted 197 s outage came from such counts)","depends_on":[]},
{"id":"guardian-storm-mechanism-capture","subject":"Measure: on the next guardian flood, capture 30 s of packet headers on the guardian port, ss -uanpm on both ends, the journal lines and any noq/iroh stats, to identify which frames the ~30-byte packets carry and what starts the flood","witness":"the flood began 30 s after sj booted (22:22:53Z), grew from 5,052 to 61,813 dropped-transmit lines per hour and stopped at the 02:46Z restart; the mechanism (ACK, PTO or path-validation loop) is unproven","depends_on":["egresswatch-saturation-alarm"]},
{"id":"sj-inbound-loss-residual","subject":"Measure: why ICMP loss into sj stayed at 12.5-20 % with 5.3 % TCP retransmits at 10-11 Mbit/s after the flood, and whether 100 ms egress bursts above the 40 Mbit/s cap (p90 22.7, max 52.6 Mbit/s) are being policed; test fq pacing on a canary","witness":"02:59Z: va->sj 20 % and phx->sj 12.5 % loss, 93 of 1747 segments retransmitted; 100 ms tx samples p50 9.6, p90 22.7, max 52.6 Mbit/s","depends_on":["egresswatch-saturation-alarm"]},
{"id":"gate-holder-identity","subject":"Measure: which requests held the node-wide gate for 60-168 s; hypothesis to test: guest upstream calls hang because guests have no DNS or egress (litebox-guests-have-no-egress-or-dns); answered by the held-gate WARN lines from IS-1","witness":"single loopback exchanges sent 192-212 bytes and received 0 for 60-168 s; at 02:57Z the busy pool was dpl-853e03f568/api, at 02:59Z survey-botdemo's own pool","depends_on":["tunnel-gate-scope-deadline-cancel"]},
{"id":"litebox-guest-midbody-stall","subject":"Measure: capture on the guest TUN why 6 parallel 360 KB responses were truncated at 24-40 KB, and why survey123's guest ignored SYNs for at least 5 min while its process stayed alive","witness":"6 of 6 truncated 200s (24,103-40,487 of 360,663 B), followed by 117.3 s TTFB for 6 local requests; survey123 SYN-SENT with 10 retransmits, backoff 6, rto 64 s; it recovered on its own by 03:03:45Z","depends_on":["ingress-probe-fixture"]},
{"id":"litebox-libnode-aot-proof","subject":"Measure: whether a libnode.so pre-rewritten with litebox-packager skips the shim's init_elf_patch_state at map time; ship an ahead-of-time rewritten runtime only if node --version drops from 1.17 s toward 0.1 s","witness":"litebox node-22 --version takes 1.170-1.176 s with or without --rewrite-syscalls, vs 0.055 s for echo; the debug trace jumps from 0.166 s to 1.155 s at the libnode mapping; reading the 81 MB libnode inside the guest takes 0.078 s","depends_on":[]},
{"id":"litebox-idle-runner-cpu","subject":"Measure and fix why 4 of 7 idle litebox runners each burn 24 % of a core (a timer or TUN-poll busy loop) before keeping more instances warm","witness":"10 s utime+stime deltas on sj: 4 runners at exactly 24 %, 3 at 0 %; on phx (8 cores) tokenhun at 49.6 % and nodes-wtf at 24.8 %","depends_on":[]},
{"id":"cooldown-escape-verification","subject":"Verify after IS-3 that no candidate pays more than one delivery timeout per cooldown window (forward-stats deliver_timeouts equals cooldown_armed), and explain the 02:56Z run of three sequential 15.2-15.4 s requests via phx","witness":"three sequential laptop requests via phx at 02:56Z each took 15.2-15.4 s although iroh_mark_bad should have made the later ones HTTP-first; supersedes the verification half of edge-stale-trunk-15s-after-peer-restart","depends_on":["mesh-forward-two-signal-lifecycle"]},
{"id":"vercel-limits-and-registrar","subject":"Measure: Vercel's per-domain record-count and create-rate limits (these set a safe affinity cap), which registrar holds shadw.app, and whether its NS records can be changed while the Vercel team is soft-blocked","witness":"the affinity cap of 60 exists because publishing dpl-* labels hit 429s; the 402 soft block started 2026-09-20T09:28:39Z; creates succeeded again from ~01:53Z on 09-25; IS-20 needs a registrar NS change","depends_on":[]},
{"id":"per-label-traffic-baseline","subject":"Measure: 7 days of per-label local vs forwarded request counts on all four nodes, to size the affinity cap, rank labels, and prove the forwarded fraction drops after IS-15","witness":"local serves are not in the event ring and /v1/functions and /v1/metrics are tenant-scoped, so the forwarded fraction (75-100 % for wildcard-only labels) was inferred from DNS structure rather than counted","depends_on":["edge-forward-observability"]},
{"id":"raw-splice-connect-timeouts","subject":"Measure: why raw-splice loopback connects to container published ports timed out (os error 110) after the 02:46Z restart; check whether containers are marked ready before their published port accepts connections","witness":"sj journal from 02:55:54Z: 'raw splice: local connect failed local=127.0.0.1:42369/42357/44373 … Connection timed out (os error 110)'; 21 SYN-SENT connects, 20 of them to podman-published loopback ports","depends_on":[]},
{"id":"sj-rss-over-memwatch-arm","subject":"Measure: attribute sj's hive-cloud RSS of 3.9-4.4 GB (above the 3,072 MB memwatch threshold, reported every 15 s from 02:55Z) across CDN entries, buffered bodies, unbounded channels and leaked tunnel streams before it triggers a restart","witness":"sj memwatch rss_mb=4024-4122 above the 3072 threshold at 02:50-02:57Z; va at 5.5 GB; a restart reaps and cold-starts every cell","depends_on":[]},
{"id":"container-alias-without-lease-audit","subject":"Measure: whether any node holds a container alias without holding its lease (which would make the forged-header split-brain variant exploitable today); compare serve-hosts with /v1/leases on every node","witness":"a forged x-hive-proxied skips the container lease redirect (edge.rs:563); guard_volume_single_writer returns early once the boot reap is confirmed (cell_orphans.rs:670-711); today container hosts appear only on sj","depends_on":[]},
{"id":"survey-botdemo-tenant-notice","subject":"Ops/tenant: tell the survey-botdemo owner (tenant thoth-division-1783051743046472311) to set SESSION_SECRET (at least 16 characters) and DATABASE_URL, because sessions and data are per-process today","witness":"projects['survey-botdemo'].env == []; the runner env has no SESSION_SECRET or DATABASE_URL; authService.js falls back to randomBytes(32); storage/index.js keeps JSON per instance; the serving instance changed 3 times in 1.5 h","depends_on":[]},
{"id":"sj-egress-cap-decision","subject":"Ops: decide whether to raise fc-sanjose's EIP egress cap (40 Mbit/s), given it is the control-plane leader and hosts 109 of 128 affinity-eligible labels; record the decision and the new cap in the inventory for egresswatch","witness":"Tencent metadata bandwidth-limit-egress is 41943040 on sj (va 22020096, va3 10485760); the post-flood baseline is 10-11 Mbit/s with 100 ms bursts to 52.6 Mbit/s","depends_on":[]},
{"id":"roll-gate-storm-check","subject":"Ops: add the egress storm check (NIC pps and the top UDP flow's share at +2 min and +30 min after every restart, on every node) to every roll gate until IS-19 or CS-11 lands","witness":"the guardian flood began 30 s after sj's 22:22:23Z boot and ran ~4.4 h unnoticed; the CS-1/2/7 roll restarted all four nodes between 02:37Z and 02:46Z","depends_on":[]},
{"id":"dan-shadw-app-dangling-record","subject":"Ops: confirm the EIP 43.166.233.114 (fc-sanjose-cvm-2, ins-hwheutvj) is still owned by the account, and delete or re-point the unmanaged dan.shadw.app A record before that EIP is ever released","witness":"dig dan.shadw.app @ns1.vercel-dns.com returns 43.166.233.114, which is not in the registry; the host answers ICMP and resets connections on 443; ansible/inventory/hosts.ini:99; the reconciler never touches names outside its managed set (vercel_dns.rs:852-855)","depends_on":[]}
]
```

**Existing rows this plan answers or supersedes.** Close each with the named witness; do not re-add them.
- `fluid-tunnel-instance-serialized-no-deadline`: IS-1 (deadlines, cancellation, scoped gates) and IS-5 (nack-aware scale-out). Guest concurrency stays in `litebox-raise-connect-permits`, which runs after IS-1.
- `sj-iroh-rebind-addrinuse-storm` and `litebox-tun-links-leak-and-iroh-addr-flood`: IS-14.
- `leader-udp-11204-rebind-addrinuse`: stays open for the AddrInUse root cause. Close it with IS-14's witness if failed rebinds reach 0.
- `edge-stale-trunk-15s-after-peer-restart`: IS-3 plus `cooldown-escape-verification`.
- `litebox-cold-start-56s-after-roll`: its phases are now measured (section 2.2); IS-6 and IS-7's witnesses close it.
- `litebox-runtime-cache-one-entry-per-key`: part (a), abandoned requests losing their place, is fixed by IS-5's detached flights.
- `litebox-abandoned-cold-start-leaves-unadopted-guest`: IS-5, because a detached cold start now joins the pool.
- `litebox-killed-runner-not-reaped`: IS-5's `is_alive` liveness check.
- `sj-local-serve-latency-spikes`: explained by the node-wide gate holds, the guest gate and the flood. Close it after IS-1 has shipped and egress has stayed under 60 % for 7 days.
- `iroh-guardian-endpoint-unify-finding` and `va-cs11-db-decoupling-stage2`: structural alternatives to IS-19.
- `dns-label-over-63-chars-dark-preview`: prerequisite of IS-15.
- `va-cs6-dns-correctness`: carries IS-15a.
- `ingress-latency-coldstart-sticky-investigation`: this document is its deliverable.