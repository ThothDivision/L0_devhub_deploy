//! Game-server mods from the Drive + world-save version control
//! (bn-game-server-mods).
//!
//! The dashboard-managed [`crate::project_settings::GameServerSettings`] (or a
//! fluid.json `game` block) declares a Drive folder of mod/plugin jars and an
//! optional world-snapshot toggle. At deploy time, before the new build's
//! records are stamped, the build node:
//!
//!  1. `snapshot_world` — when `world_snapshot_on_deploy` is on and the
//!     project's persistent volume already has a world dir (i.e. NOT the first
//!     deploy), copies `world/` to `.hive-snapshots/<build_id>/` INSIDE the
//!     same named volume. A rollback is then one `podman run --rm` copy back.
//!     Snapshots are never pruned by this path: retention is a policy
//!     decision, exactly the `gc_rootfs_images` blast-radius posture — a
//!     deploy must never silently delete a save.
//!  2. `sync_drive_mods` — reads every file directly under the configured
//!     Drive folder via the drive's own owner-routed read path
//!     (`drive_api::resolve_and_fetch_bytes`, which already handles a byte
//!     owner living on a different node), then copies them into the volume at
//!     `mods_dest_subdir` (default `mods`), removing files in that dir that
//!     the Drive folder no longer carries. Sync is scoped to the ONE subdir —
//!     it never touches the world or any other volume content.
//!
//! Both run through a throwaway `podman run --rm -v <vol>:/hivevol …` helper
//! container using the deployment's OWN image (guaranteed to be present —
//! the build just pulled it), so no host path assumptions about podman's
//! volume root are made (`/var/lib/containers/storage/volumes` is
//! distro/storage-driver dependent). The volume is a podman NAMED volume
//! (`hive-vol-{project}-{incarnation}`), so data survives the container and
//! the redeploy — that is the whole point.
//!
//! Failure posture: a Drive folder that does not resolve or a volume that
//! cannot be mounted logs a WARN and the deploy proceeds WITHOUT mods rather
//! than failing the build — a missing mod dir must never take a working
//! server down (the crash-loop lessons); the tenant sees the gap named in
//! the build log, never a silent skip.

use std::path::Path;
use std::sync::Arc;

use crate::project_settings::GameServerSettings;
use crate::state::CloudState;

/// The directory a snapshot is written to, relative to the volume root.
pub(crate) const SNAPSHOT_DIR: &str = ".hive-snapshots";

/// The helper container's mount point for the named volume.
const VOL_MNT: &str = "/hivevol";
/// The helper container's mount point for the staged mods dir.
const STAGE_MNT: &str = "/hivestage";

/// Resolved (never empty) mods subdir inside the volume.
fn mods_subdir(spec: &GameServerSettings) -> String {
    spec.mods_dest_subdir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("mods")
        .trim_matches('/')
        .to_string()
}

/// Resolved world subdir inside the volume.
fn world_subdir(spec: &GameServerSettings) -> String {
    spec.world_subdir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("world")
        .trim_matches('/')
        .to_string()
}

/// Reject any volume-relative subdir that could escape the mount: no absolute
/// paths, no `..`, no backslashes, no empty components, and never the
/// snapshot dir itself (a mods dir of `.hive-snapshots` would make the sync's
/// prune step eat the rollback points).
fn subdir_safe(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('/')
        && !s.contains('\\')
        && !s.contains('\0')
        && s.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
        && s != SNAPSHOT_DIR
        && !s.starts_with(&format!("{SNAPSHOT_DIR}/"))
}

/// Run the deploy-time game-server file work for one container deployment:
/// world snapshot (if enabled) then the Drive mods sync. Called from git.rs
/// once the build's image exists locally and the manifest's volume name is
/// known; `bid` scopes the build log lines. Never fails the build — every
/// fault degrades to a logged gap.
pub(crate) async fn apply_game_settings(
    cloud: &Arc<CloudState>,
    bid: &str,
    project: &str,
    team: &str,
    image: &str,
    volume: &str,
    spec: &GameServerSettings,
) {
    if spec.world_snapshot_on_deploy {
        snapshot_world(cloud, bid, image, volume, spec).await;
    }
    if let Some(drive_path) = spec
        .mods_drive_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sync_drive_mods(cloud, bid, project, team, image, volume, spec, drive_path).await;
    }
}

/// Snapshot the volume's world dir to `.hive-snapshots/<bid>/` inside the
/// same volume. A no-op (logged, not an error) when the world dir does not
/// exist yet — the first deploy of a fresh server has nothing to roll back.
async fn snapshot_world(
    cloud: &Arc<CloudState>,
    bid: &str,
    image: &str,
    volume: &str,
    spec: &GameServerSettings,
) {
    let world = world_subdir(spec);
    if !subdir_safe(&world) {
        cloud.builds.log(
            bid,
            format!("Game: refusing to snapshot unsafe world dir {world:?} — skipping."),
        );
        return;
    }
    // `cp -a` inside a throwaway container: hardlink-free recursive copy
    // preserving mtimes/permissions. `--` guards, quoted by construction
    // (every component passed the subdir_safe / volume-name gates above).
    let script = format!(
        "if [ -d '{VOL_MNT}/{world}' ]; then \
           mkdir -p '{VOL_MNT}/{SNAPSHOT_DIR}/{bid}' && \
           cp -a '{VOL_MNT}/{world}' '{VOL_MNT}/{SNAPSHOT_DIR}/{bid}/world' && \
           echo SNAPSHOT_OK; \
         else \
           echo SNAPSHOT_SKIP_EMPTY; \
         fi"
    );
    match helper_run(image, volume, &script, None).await {
        Ok(out) if out.contains("SNAPSHOT_OK") => cloud.builds.log(
            bid,
            format!("Game: world snapshot saved to {SNAPSHOT_DIR}/{bid}/ (volume {volume})."),
        ),
        Ok(_) => cloud.builds.log(
            bid,
            "Game: no existing world dir in the volume — first deploy, snapshot skipped."
                .to_string(),
        ),
        Err(e) => cloud.builds.log(
            bid,
            format!("WARN: Game: world snapshot failed ({e}) — deploy continues."),
        ),
    }
}

/// Sync the configured Drive folder into the volume's mods subdir. Files that
/// exist in the volume dir but no longer in the Drive folder are removed
/// (scoped strictly to the mods subdir).
async fn sync_drive_mods(
    cloud: &Arc<CloudState>,
    bid: &str,
    project: &str,
    team: &str,
    image: &str,
    volume: &str,
    spec: &GameServerSettings,
    drive_path: &str,
) {
    let log = |s: String| cloud.builds.log(bid, s);
    let dest = mods_subdir(spec);
    if !subdir_safe(&dest) {
        log(format!(
            "Game: refusing to sync mods to unsafe dir {dest:?} — skipping."
        ));
        return;
    }
    // Resolve the Drive folder and enumerate its direct file children.
    let Some(dir_node) = crate::drive_api::resolve_full(project, drive_path)
        .await
        .filter(|n| n.kind == "dir")
    else {
        log(format!(
            "WARN: Game: Drive folder {drive_path:?} not found in project drive — upload mods there (dashboard → Drive) or fix Settings → Game; deploying without mods."
        ));
        return;
    };
    let children = crate::relational::drive_list_children(project, &dir_node.id).await;
    let files: Vec<_> = children.into_iter().filter(|n| n.kind == "file").collect();
    if files.is_empty() {
        log(format!(
            "Game: Drive folder {drive_path:?} is empty — no mods to sync (dir {dest}/ left as-is)."
        ));
        return;
    }
    // Stage the files into a temp dir on the host, through the drive's own
    // owner-routed read path (bytes may live on another node).
    let stage = std::env::temp_dir().join(format!("hive-mods-{bid}"));
    if let Err(e) = tokio::fs::create_dir_all(&stage).await {
        log(format!(
            "WARN: Game: could not create mods staging dir ({e}) — deploying without mods."
        ));
        return;
    }
    let mut staged = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for f in &files {
        // A drive file name becomes a filesystem entry here: keep it to a
        // bare basename with no separators (drive names can't contain '/'
        // already — resolve() splits on it — this is belt-and-braces against
        // a crafted relational row).
        let name = Path::new(&f.name)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty() && s != "." && s != "..");
        let Some(name) = name else {
            failed.push(f.name.clone());
            continue;
        };
        let path = format!("{}/{}", drive_path.trim_end_matches('/'), f.name);
        match crate::drive_api::resolve_and_fetch_bytes(cloud, project, &path, team).await {
            Some((node, bytes)) => {
                if let Err(e) = tokio::fs::write(stage.join(&name), &bytes).await {
                    log(format!(
                        "WARN: Game: failed to stage mod {name} ({e}) — file skipped."
                    ));
                    failed.push(name);
                } else {
                    staged += 1;
                    let _ = node;
                }
            }
            None => {
                log(format!(
                    "WARN: Game: mod {name} is in the drive index but its bytes are unavailable on every owning node — file skipped."
                ));
                failed.push(name);
            }
        }
    }
    if staged == 0 {
        log(format!(
            "WARN: Game: no mod files could be staged ({} failed) — deploying with the volume's existing mods unchanged.",
            failed.len()
        ));
        let _ = tokio::fs::remove_dir_all(&stage).await;
        return;
    }
    // Copy staged files into the volume's mods dir, then prune entries the
    // Drive folder no longer carries. The prune list is built INSIDE the
    // helper from the staged set — never from tenant strings.
    let script = format!(
        "mkdir -p '{VOL_MNT}/{dest}' && \
         cp -a '{STAGE_MNT}/.' '{VOL_MNT}/{dest}/' && \
         for existing in \"{VOL_MNT}/{dest}\"/*; do \
           [ -e \"$existing\" ] || continue; \
           base=${{existing##*/}}; \
           [ -e \"{STAGE_MNT}/$base\" ] || rm -rf -- \"$existing\"; \
         done; \
         echo MODS_OK"
    );
    let result = helper_run(image, volume, &script, Some(&stage)).await;
    let _ = tokio::fs::remove_dir_all(&stage).await;
    match result {
        Ok(out) if out.contains("MODS_OK") => {
            let skipped = if failed.is_empty() {
                String::new()
            } else {
                format!(" ({} skipped: {})", failed.len(), failed.join(", "))
            };
            log(format!(
                "Game: synced {staged} mod file(s) from Drive {drive_path:?} into volume {volume} at {dest}/{skipped}."
            ));
        }
        Ok(out) => log(format!(
            "WARN: Game: mods copy helper returned an unexpected result — volume may be stale: {}",
            out.chars().take(200).collect::<String>()
        )),
        Err(e) => log(format!(
            "WARN: Game: mods copy into volume failed ({e}) — deploying with the volume's existing mods unchanged."
        )),
    }
}

/// Run a short shell script in a throwaway container with the named volume
/// mounted at `VOL_MNT` (and optionally a host staging dir read-only at
/// `STAGE_MNT`), using the deployment's own image. The script runs as the
/// image's default user — if the image's entrypoint would interfere it is
/// neutralised with `--entrypoint`. Output is captured for the sentinel
/// markers; the container is always removed (`--rm`), and its anonymous
/// volume-less shape keeps the podman lock pool untouched (the
/// `container_cli::rm_args` rule — no `-v` needed because no anonymous
/// volume is created).
async fn helper_run(
    image: &str,
    volume: &str,
    script: &str,
    stage: Option<&Path>,
) -> anyhow::Result<String> {
    let path = crate::git::podman_path_env();
    let mut cmd = tokio::process::Command::new("podman");
    cmd.env("PATH", &path);
    cmd.args([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "/bin/sh",
        "-v",
        &format!("{volume}:{VOL_MNT}"),
    ]);
    if let Some(stage) = stage {
        cmd.args(["-v", &format!("{}:{STAGE_MNT}:ro", stage.display())]);
    }
    cmd.arg(image);
    cmd.args(["-c", script]);
    let out = tokio::time::timeout(std::time::Duration::from_secs(180), cmd.output())
        .await
        .map_err(|_| anyhow::anyhow!("helper container timed out after 180s"))??;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!(
            "helper container exited {}: {}",
            out.status,
            stderr
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("no stderr")
                .chars()
                .take(200)
                .collect::<String>()
        );
    }
    Ok(stdout)
}
