# macOS nodes (shadw1/shadw2) mesh loss 2026-09-25: root cause, remediation, never-again design

> Adversarially-verified investigation, 2026-09-25. Queued as PRD rows mac-cs1..mac-cs9. Runbook B1 (shadw1 duplicate gui/501 job bootout + plist archive) was executed 2026-09-25 ~03:20Z.

**(A) Root cause: why shadw1 and shadw2 went missing**

Both Macs went missing together because they are the only fleet members running the same hand-installed Aug-20 debug build (sha256 1525dcdb73e2de6a…, 278,869,760 B), and one home Wi-Fi disruption hit both at once. A crash put each node on a new process while the network was still down. That process wedged, and nothing on either side could recover it.

1. **Trigger: home Wi-Fi, 23:55Z–00:40Z.**
   - airportd shows link-down and "Will disassociate due to failed association request" events. They occur only in this window across logs retained since 09-20, on all three Wi-Fi hosts:
     - shadw1: 00:05:39–00:07:44
     - shadw2: 00:05:48–00:06:21
     - the laptop: 00:05:29–00:06:30
   - Both Mac minis dropped again in the same second at 00:38:16.
   - After each reconnect, the iOA utun4 full tunnel left DNS and routes broken for another ~2–3 minutes ("no ServerAddresses key", AF_ROUTE bursts, "Resolve failed" until 00:40:55).
   - Not the cause: iOA (SmartVPN has run since Aug 14), sleep, clock, disk, file descriptors.

2. **Crash: the noq debug-build abort.**
   - At `noq-1.0.1/src/endpoint.rs:648`, `self.recv_state.connections.active_connections -= 1` sits on the Draining event in `handle_events`. It underflows because a Draining event arrives for a connection the counter no longer holds. Six `push_back(EndpointEventInner::Draining)` sites in noq-proto can fire.
   - A debug build panics on the underflow while holding the endpoint mutex. `impl Drop for EndpointDriver` then calls `lock().unwrap()` on the poisoned mutex (`:495`), a non-unwinding double panic ends in SIGABRT, and launchd shows exit -6.
   - Abort times: shadw2 at 00:05:53 and 00:39:18; shadw1 at 00:06:21 and 00:39:27. Each followed a link or bridge100 event by 5–60 s.
   - launchd KeepAlive respawned each process straight into the broken network.

3. **Wedge: the Aug-20 build dials once, then never again.**
   - shadw2 has no duplicate launchd job, so its log is clean evidence. Each boot made exactly one dial round (00:06:01–05 and 00:39:25–29), then logged zero hive_p2p lines for 33 and 101 minutes. That silence held while connectivity was demonstrably back: relay HTTPS probes answered, and the laptop nodes and shadw3 rejoined.
   - The gossip loop kept ticking every 25.0 s (the `peer_iroh.json` rewrite cadence, i.e. 2 × 10 s outer budget + 5 s sleep). Meanwhile `/v1/relay` connect timeouts stayed frozen at 2 per seed. So every round burned its outer `tokio::time::timeout` without reaching connect, and that path logs only at debug (`gossip.rs:2128-2137`).
   - Setup that runs once at boot also stayed failed: "mainline DHT address lookup NOT registered", `region=local`.
   - The exact blocking await is not pinned down. Two candidates exist in HEAD, and it is unverified whether the Aug build has either:
     - seeds re-asserted into `peer_iroh` every round (`main.rs:4296-4302`), because `fetch` evicts on failure at `gossip.rs:2132/2137`;
     - `DialLeaderGuard`'s cancel-on-drop of a dial flight (`hive-p2p/src/lib.rs:2402-2433`). Without it, later acquires wait on a leaked in-flight dial.

4. **Nothing rescued them.**
   - **The fleet side forgot them.** `fetch()` evicts `peer_iroh` entries, `registry.nodes()` hides any peer silent for more than 30 s (`hive-edge/src/region.rs:1116`), and the health loop probes only nodes with a `public_ip` (`main.rs:5643`). The Macs have none. Result: zero server dials to either Mac from 00:06:07 to 01:45:20Z.
   - **meshwatch could not fire.**
     - `should_restart` requires `ever_saw_peer` (`meshwatch.rs:146-153`).
     - The BOOT-WEDGE arm requires `audible_peers >= degraded_floor(27) = 6` (`meshwatch.rs:599-603`), and an isolated Mac hears 0.
     - At HEAD, `RestartReason::admissible` (`main.rs:269-274`) refuses every non-memory restart unless `orphan_reap_ran()`. That is permanently false on macOS (`cell_orphans.rs:572-644`), so an upgraded Mac would also never self-heal.
   - **No alert exists for a missing member.** No incident is opened when a known node disappears, and `/v1/nodes` just drops absent nodes. shadw2 is not in any Linux `HIVE_TRUSTED_NODE_IDS`; it survives only through hot-join. `expected_peers=26` counts about 19 powered-off nodes, so "missing" is the normal state.

5. **Recovery was an accident.** A later noq abort happened to land while the network was up: shadw1 at 01:45:01Z, shadw2 at 02:20:26Z. Each had trunks within ~1 s. At 02:58Z both reported `isolated:false`, `visible_healthy_peers:8`.

**The control that separates trigger from cause.** shadw3 (Sep-18 build) and fc-lax2 (current tree) sit behind the same Wi-Fi and NAT (142.129.107.198). They were marked unhealthy at the same moments and also aborted (00:07:02 and 00:06:08), but rejoined within about a minute. The network explains why it happened to both at once; the Aug-20 binary explains why they stayed missing.

**Aggravating factor, shadw1 only: a second launchd job for the same node.**
- The live process is supervised correctly by `system/dev.shadw.shadw1` (`/Library/LaunchDaemons`, `UserName=dylan`, pid 57308). PPID 1 is normal for every launchd child.
- A duplicate job, `gui/501/dev.shadw.shadw1` (`~/Library/LaunchAgents`), was restored on 09-22 after a misdiagnosis. That check looked only at the gui domain and PPID 1. The duplicate has respawned every ~10.7 s since 2026-09-22T22:36:00Z (runs ≈ 17.5k).
- Each duplicate:
  - binds identity a6f9943b…;
  - publishes an EMPTY 84-byte pkarr record (ANCOUNT=0) at the va and sj discovery servers;
  - overwrites `run_marker.json` and `restart_history.json`, so all 64 history entries are false `unclean_exit` and the real SIGABRT history is gone;
  - dies at the final TCP bind (`main.rs:2361`, "Address already in use (os error 48)").
- This is why the leader sj keeps flapping shadw1 after it rejoined (12 UNHEALTHY since 02:21Z), while shadw2 behind the same NAT shows 0.
- Episode 1 had the same shape (2026-08-14 → 09-01). The root enabler is that hive-cloud has no single-instance guard and the Macs have no single-writer supervision.

**Contributing config drift:**
- the plists list dead seeds, relays and discovery hosts (bkk, sj2, 170.106.40.67);
- the owner chain includes fc-bangkok;
- `HIVE_P2P_DISCOVERY_MS` is unset (4000 ms instead of 8000);
- the launchd exit timeout is 5 s against a 75 s graceful stop;
- the gui plist has no `NumberOfFiles`;
- logs are 3 GB and 1.2 GB, unrotated.

**Refuted as causes:** the trust gate, hybrid-PQ interop, NAT hairpin behaviour, a continuous iOA outage, and sj's budget exhaustion (that ended at 22:22Z).

---

**(B) Immediate remediation runbook: minimal, reversible, no restarts of healthy processes**

Access: shadw1 is `dylan@192.168.1.82` and shadw2 is `dylan@192.168.1.89`, both with password auth. Pace the SSH attempts, because macOS auth throttling was seen. sudo takes the operator password on stdin; never echo or log it. Run each block on the named host.

**shadw1**

B1.0 Snapshot (read-only). If the gate at the end fails, abort.
```
for d in system gui/501; do echo "== $d"; launchctl print $d/dev.shadw.shadw1 2>&1 | grep -E '^\s*(path|state|pid|runs|last exit code|last terminating signal) ='; done
PID=$(launchctl print system/dev.shadw.shadw1 | awk '$1=="pid"{print $3; exit}'); echo live=$PID
ps -o pid,ppid,lstart,rss,args -p "$PID"
lsof -nP -a -p "$PID" -iTCP -sTCP:LISTEN        # note the admin port (ADM); default 127.0.0.1:8786
ls -la ~/Library/LaunchAgents | grep shadw; ls -la /Library/LaunchDaemons | grep shadw
SIZE0=$(stat -f %z ~/Library/Logs/shadw/shadw1.log); echo $SIZE0
cat ~/.hive-cloud/run_marker.json
```
Gate: the system job must be `state = running`, and `$PID` must hold the public and admin listeners. If not, STOP: the gui job may then be the only working supervisor.

B1.1 Remove the duplicate supervisor.
```
launchctl bootout gui/501/dev.shadw.shadw1
sleep 5; pgrep -fl 'hive-cloud --name shadw1'   # must list only $PID
```
A duplicate child caught mid-life exits by itself in under 1 s. If a pid other than `$PID` is still there after 5 s, `kill` that pid. Never touch `$PID`.

B1.2 Move every copy and backup out of the directories launchd scans. The live system plist stays.
```
A=~/shadw-launchd-archive/20260925; mkdir -p "$A"; mv ~/Library/LaunchAgents/dev.shadw.shadw1.plist* "$A"/
sudo -S mkdir -p /usr/local/var/shadw-launchd-archive/20260925
sudo -S mv /Library/LaunchDaemons/dev.shadw.shadw1.plist.* /usr/local/var/shadw-launchd-archive/20260925/
ls -l /Library/LaunchDaemons/dev.shadw.shadw1.plist   # must still exist
```
The `.plist.*` glob cannot match the live plist.

B1.3 Verify at 60–120 s, then again at 15 min.
- `launchctl print gui/501/dev.shadw.shadw1` returns "Could not find service".
- The system job shows the same `pid = $PID`, and `runs` has not changed.
- `tail -c +$SIZE0 ~/Library/Logs/shadw/shadw1.log | grep -cE 'Address already in use|UNCLEAN RESTART'` returns 0.
- `~/.hive-cloud/run_marker.json` pid equals `$PID`, and stays that way.
- `curl -s http://$ADM/v1/mesh` shows `isolated:false` and `visible_healthy_peers >= 5`.
- On va, check the discovery record: `curl -s http://127.0.0.1:3350/<z32 of a6f9943b…> | wc -c` must be well above 84 (≈201) at 0, 20, 40 and 60 s. Use the z32 key from the investigation scratchpad (`rv/`).
- On sj: `journalctl -u hive-node --since '-15 min' | grep -c 'UNHEALTHY.*shadw1'` returns 0 at the 15-minute mark (shadw2 is the control).

Rollback (recreates the fault; do not use unless required): `mv "$A"/dev.shadw.shadw1.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/501 ~/Library/LaunchAgents/dev.shadw.shadw1.plist`.

Do NOT:
- boot out the system job or kill `$PID`;
- hand-edit the system plist (its 3 seeds vs 4 and the dead bkk entry get reconciled by CS-7);
- restore any retired plist.

**shadw2** (pid 1575 since 02:20:28Z, healthy, a single gui job)

B2.0 Snapshot.
- `launchctl print gui/501/dev.shadw.shadw2`: record pid, runs and last exit.
- `launchctl print system/dev.shadw.shadw2` must return "Could not find service". This confirms there is no second supervisor.
- `ls ~/Library/LaunchAgents /Library/LaunchDaemons | grep shadw2`.
- `/v1/mesh` on its admin port (found with `lsof` as in B1.0).

B2.1 Only if copies without the `.plist` suffix or backups exist: move them to `~/shadw-launchd-archive/20260925` and the sudo archive, as in B1.2. No bootout; they are not loaded.

B2.2 No restart: the process is healthy. Verify from sj that shadw2 is healthy in `/v1/nodes` and that the journal has 0 UNHEALTHY lines for shadw2 over 15 minutes.

**Both Macs**

B3 Recovery procedure if either goes isolated again before CS-2, CS-3 and CS-5 ship. The signature is all three of:
- `/v1/mesh` shows `isolated:true` for more than 15 minutes;
- the Mac itself gets a TLS-verified 200 from `curl -sS -o /dev/null -w '%{http_code}' --max-time 5 https://fc-virginia.relay.shadw.app:3343/ping`. iOA can fake a TCP connect but not the relay's certificate, so never use `nc` or a bare TCP probe;
- the log has no hive_p2p dial lines after the boot round.

Recover with:
- shadw2: `launchctl kickstart -k gui/501/dev.shadw.shadw2`
- shadw1: `sudo -S launchctl kickstart -k system/dev.shadw.shadw1`

`kickstart -k` is safe here because the environment is unchanged; the gotcha applies only to plist edits. Verify `isolated:false` within 2 minutes.

Do NOT install a hand-made watchdog launchd job as a stopgap. Hand-made jobs are the drift class that caused both episodes.

B4 Operator-only actions:
- Click Cancel on the "Install Command Line Developer Tools" dialog on shadw1 and shadw2. The investigation's `otool` and `python3` calls triggered it.
- Optionally cable the Mac minis to Ethernet. en3/en5 are idle; this removes the Wi-Fi trigger.
- Optionally ask IT for an iOA split-tunnel exclusion for fleet IPs and UDP 11204.

shadw3: no action now; it is covered by CS-7.

---

**(C) Never-again design: independently shippable change sets**

Each set generalizes one failure class at a shared primitive and plugs into the Linux work already underway: the `RestartReason` chokepoint, `leadership::may_act`, the cell-reaper owner+boot model, the bounded gossip rounds and transport liveness from 43445a9, and a `gen-hive-lockdown.sh`-style roster generator.

**CS-1: One process per data dir (every OS, every supervisor)**
- New `crates/hive-cloud/src/instance_lock.rs`. It is called in `main.rs` right before `restart_audit::audit_boot` (line 650). Lines 506–649 are only tracing, argument parsing and diagnostic probes, so `--dht-probe` and `--litebox-probe` are unaffected.
- Mechanism:
  - Open `$HIVE_DATA/hive-cloud.lock` (Rust's default O_CLOEXEC) and take `flock(LOCK_EX|LOCK_NB)`.
  - Poll every 250 ms for up to `HIVE_INSTANCE_LOCK_WAIT_SECS` (default 90, above TimeoutStopSec). A real restart overlap clears within that window; a duplicate never does.
  - On success, write `{pid, started_ms, exe, XPC_SERVICE_NAME, INVOCATION_ID}` into the file and hold the fd for the life of the process. The kernel releases it on SIGKILL or SIGABRT.
  - On failure, log exactly one ERROR naming the holder's pid and start time plus the data dir. On macOS it also shows the results of `launchctl print system/<label>` and `gui/<uid>/<label>`, with the line "two launchd jobs share label X". Then exit with code 75.
  - Nothing may run before the lock: `restart_audit`, the iroh bind, DHT, pkarr, guardian, persist.
- Also:
  - `hive-node.service.j2` gets `RestartPreventExitStatus=75`.
  - `guardian.rs:296-324`: with the lock held, "Database already open" is provably in-process, so the misleading heuristic message is removed.
  - The AGENTS.md cell-reaper caveat about a launchd phantom respawn (~line 553) becomes impossible and is updated.
- Verify live:
  - On the laptop fc-lax2, start a second `hive-cloud` with the same `HIVE_DATA`. Expect one ERROR, exit 75, no "iroh P2P endpoint bound" line from the second pid, and an unchanged `run_marker.json` mtime.
  - After `kill -9` of the holder, the next start acquires the lock immediately.
  - On one Linux node, after a tenant build and a litebox exec, `lsof $HIVE_DATA/hive-cloud.lock` shows only the hive-cloud pid (no inherited fd). `systemctl restart hive-node` logs a lock wait of about 0 ms.

**CS-2: The noq counter can never abort or wedge (debug and release)**
- Add `vendor/noq` (a 1.0.1 copy) with a `CHANGES.md`, and `[patch.crates-io] noq = { path = "vendor/noq" }`, following the `vendor/iroh` discipline.
- Patch:
  - Replace the `active_connections: u64` counter with a per-handle set in `ConnectionSet`: insert at `:779`, clear at `:501`.
  - In `handle_events`, only the FIRST Draining event for a handle removes it and notifies `all_draining` when the set becomes empty. Ignored Draining events (duplicates, or connections never counted) increment a counter exported in `/v1/relay`.
  - `Drop for EndpointDriver` uses `lock().unwrap_or_else(PoisonError::into_inner)`.
  - A `saturating_sub` is not enough: it would steal the count of a live connection.
  - Release builds today wrap the counter to `u64::MAX`, so `wait_all_draining` never returns and eats the 75 s shutdown deadline on Linux. The same patch fixes that.
- Report the second underflow path upstream.
- Verify:
  - `cargo test --workspace --no-run`.
  - On the laptop debug build, cycle `networksetup -setairportpower en0 off; sleep 30; … on` five times. Expect no SIGABRT and a non-zero ignored-drain counter.
  - On one Linux node, `systemctl stop` logs the endpoint close well inside the deadline.

**CS-3: The dialer is live for the whole process, not once per boot**
- Gate first: reproduce boot-into-outage on HEAD. On fc-lax2, load a pf anchor blocking non-LAN egress, start the node with `RUST_LOG=hive_p2p=debug,hive_cloud::gossip=debug`, and lift the anchor after 90 s. This pins the exact await and tells whether HEAD also wedges.
- Changes, in `main.rs` `spawn_gossip_loop`, `hive-p2p/src/lib.rs` `PeerPool`, `gossip.rs` and `hive-p2p/src/dht.rs`:
  - The gossip loop counts dial attempts that actually reach the transport. If targets exist and that count has not advanced for 6 rounds, it logs a rate-limited WARN ("dialer wedged") and calls `PeerPool::reset_dial_state()`, which clears inflight, refused, negative-discovery and warm-backoff state.
  - A netmon link change, or the home relay reconnecting, triggers the same reset plus an immediate seed round.
  - Outer-budget timeouts become a counted `/v1/relay` field plus a WARN, instead of debug-only lines.
  - DHT registration, the resolver rebuild (fall back to the system resolver when SCDynamicStore lacks ServerAddresses) and region detection retry on a backoff of 30 s up to 10 min, instead of running once.
- Verify: the pf repro yields a trunk within 60 s of lifting the block, and the new counters are visible.

**CS-4: The fleet never forgets a member**
- `gossip.rs:2132/2137` demotes a peer instead of calling `peer_iroh.remove`.
- A persisted member book holds every node ever admitted (the static trust list plus hot-joins) with its last good `addr_json`, including the home relay. It is saved to `$HIVE_DATA/member_book.json` and reloaded at boot.
- Stale members are re-dialed by key through their relay on a per-peer backoff of 30 s up to 5 min. They join the gossip loop's dynamic targets, and the health loop drops the `public_ip.is_some()` filter (`main.rs:5643`) for member-book entries.
- Hot-join admissions are persisted across server restarts.
- Verify: `kill -STOP` a laptop dev node for 3 minutes. Server journals must show continued outbound dials to it on the backoff; before this change there were zero, per the 00:06–01:45 evidence. After `kill -CONT`, a server-initiated trunk opens.
- Canary on one server and check `/v1/mesh` before fanning out.

**CS-5: meshwatch heals a never-converged node, bounded and macOS-safe** (`meshwatch.rs`, `main.rs` `RestartReason`, `hive-backend/src/cell_orphans.rs`)
- New arm. It fires when all of these hold:
  - the node has never converged, uptime is over 15 minutes, `direct_reachable == 0` and `audible == 0`;
  - an egress proof passes: the home relay is connected AND a TLS-verified `GET https://<relay>/ping` returns 200 (a TCP connect is never accepted as proof, because of iOA).
- It acts in two steps:
  - first, the in-process mesh reset from CS-3;
  - then, if the node is still isolated 10 minutes later, `ControlledRestart::request(RestartReason::BootIsolation)`. The rate cap is 1 per hour and 4 per 24 hours, counted from the persisted `restart_audit` history (fails closed).
- `orphan_reap_ran()` on macOS becomes true when no running Apple `container` `hive-cell-*` exists, including when the container CLI is absent. Mock cells die with the launchd job's process group; verify that `AbandonProcessGroup` is unset.
- A refused restart surfaces as a fleet incident (CS-6), not only a local WARN.
- Floors derive from the active roster (CS-6), not from `expected_peers`.
- Ship CS-5 before or together with any HEAD build on the Macs. Otherwise HEAD's interlock disarms every mesh restart there.
- Verify on a dev node started with a bogus trust list and a short `HIVE_MESH_BOOT_ISOLATION_MS`: the arm fires once, and the second trigger inside the window is refused with a WARN and an incident.

**CS-6: One topology source, and a leader-owned presence job**
- Inventory: `ansible/inventory/hosts.ini` gains a `[macos]` group and a per-host `lifecycle=active|parked|retired`.
- New `scripts/gen-fleet-roster.sh`, modelled on `gen-hive-lockdown.sh`. It generates:
  - `HIVE_TRUSTED_NODE_IDS` (active + parked; this adds shadw2 and shadw3);
  - `HIVE_EXPECTED_NODE_IDS` (active only);
  - addressed seeds of the form `<id>@ip:port|https://<n>.relay.shadw.app:3343`;
  - relays and discovery hosts (active only), owner chain and voters.
- These feed both `peer-trust.conf` / `hive-node.service.j2` and the Mac plist template.
- Code:
  - `NodeInfo.build {profile, commit, sha_prefix}` (run `cargo test --workspace --no-run` after adding it).
  - A new `leadership::Job::NodePresence` in a new `node_presence.rs`. For each active id absent from the leader's gossip-fresh set for more than 10 minutes, it calls `IncidentStore::open("node <name> missing from the mesh")` (already deduped) and auto-resolves the incident on return.
  - It also opens incidents for a member running a debug build, and for a restart refused by the interlock.
- Verify: stop an active dev node and an incident appears within about 11 minutes; restart it and the incident resolves. `expected_peers` drops to the live count.

**CS-7: macOS single-writer supervision and release-only binaries**
- New ansible role `hive_platform_macos` (password SSH is fine), rendered from the CS-6 variables. It installs exactly one system LaunchDaemon `/Library/LaunchDaemons/dev.shadw.<name>.plist` with:
  - `UserName`, `KeepAlive`, `ThrottleInterval 10`, `ExitTimeOut 90`;
  - `NumberOfFiles 65536`, `HIVE_P2P_DISCOVERY_MS=8000`, log paths plus a newsyslog config;
  - secrets in a 0600 env file sourced by a wrapper, never in the plist, and never templated into logs.
- Before installing, the role enumerates `system`, `gui/<uid>` and `user/<uid>` plus all three plist directories. It boots out and archives every other copy, then asserts that exactly one job is loaded.
- Binary: `cargo build --release --target aarch64-apple-darwin`, sha256-verified, with a `.old` backup.
- Add a `--build-info` flag to hive-cloud. It refuses to join the mesh if it is a debug build and `HIVE_ALLOW_DEBUG_BUILD=1` is not set; the laptop dev plists set that flag explicitly.
- New `scripts/audit-mac-supervision.sh`, which exits 1 when:
  - a label has more than one job;
  - the listener's pid is not the job's pid;
  - `runs` keeps climbing with last exit 1 over a 60 s sample;
  - the binary is a debug build;
  - the plist has drifted from the rendered one.
- Fix `scripts/shadw-watchdog.sh` (lines 20 and 94–107) and `scripts/shadwd.sh:35`: resolve the owning job across the system and gui domains, and never treat PPID 1 as an orphan.
- Rollout: canary on shadw3, check `/v1/mesh isolated:false` within 5 minutes, then shadw2 (one controlled bootout → exit → bootstrap), then shadw1.
- Verify: the audit exits 0 on all three Macs and `--build-info` reports `release`.

**CS-8: Discovery never serves an empty record**
- `discovery.rs` `DiscoveryStore::put` (line 65): a newer packet with zero answer records does not replace a non-empty one. The server returns 409 and counts it in `/v1/mesh/discovery`.
- The `hive_p2p::dht` publisher skips empty publishes.
- This is the discovery-layer form of the rule "never let an address set go empty", and it covers the empty record any booting node publishes before it has a relay.
- Verify: across restarts of a dev node, va's `curl :3350/<z32>` never returns 84 bytes.

**CS-9: Documentation and memory**
- AGENTS.md: add a "macOS nodes" section covering:
  - one system LaunchDaemon per node;
  - PPID 1 is normal;
  - identify the owning job with `launchctl print system/…` AND `gui/<uid>/…`, never `launchctl list`;
  - the duplicate signature (`runs` climbing ~8k/day with last exit 1, "Address already in use", UNCLEAN RESTART every ~10 s);
  - iOA intercepts TCP, so only TLS-verified probes from Macs or the laptop count;
  - the Mac minis are on Wi-Fi.
- Coordinate this edit: another workflow is editing AGENTS.md.
- Memory: `memorize-prune` `mac-node-launchd-reload-gotcha` (wrong domain for shadw1) and `shadw1-orphaned-supervision-2026-09-22` (it records the misdiagnosis as a fix), then `memorize-fire` a corrected entry and update `MEMORY.md`.

**Priority:** B now, then CS-1 and CS-2 (small, highest leverage), CS-5 together with CS-7, then CS-3, CS-4, CS-6, CS-8 and CS-9.

**Open questions:**
- The exact wedged await in the Aug build; the CS-3 repro settles whether HEAD shares it.
- Which noq path emits Draining for an uncounted connection.
- Whether iOA split-tunnelling is allowed; that is an IT decision.

Evidence scratchpad: `/private/tmp/claude-501/-Users-dylanwong-fluid-hive/4f80db69-06dd-4849-a63c-6e2a25b04055/scratchpad/rv/` and `/private/tmp/claude-501/-Users-dylanwong-fluid-hive/4f80db69-06dd-4849-a63c-6e2a25b04055/scratchpad/macside/`.