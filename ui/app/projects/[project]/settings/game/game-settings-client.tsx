"use client";

import { useCallback, useEffect, useState, use } from "react";
import { Button, Input, SettingCard } from "@/components/ui";
import { apiGet, apiSend, type GameServerSettings, type ProjectSettings } from "@/lib/api";

/**
 * Game-server settings for a project running a container game server
 * (Minecraft & co. — raw TCP/UDP containers): pull mod/plugin files from the
 * project's shadw Drive into the persistent volume at deploy time, pin the
 * server version/type (stamped as VERSION/TYPE env for itzg-style images),
 * and snapshot the world save before each deploy for rollback.
 *
 * Saving PUTs `/v1/projects/:project/game`; clearing everything DELETEs it.
 * This is a DASHBOARD-MANAGED override that applies on the project's NEXT
 * deploy/redeploy — it does not touch anything already running (the exact
 * Container settings page contract).
 */
export function GameSettings({ paramsPromise }: { paramsPromise: Promise<{ project: string }> }) {
  const params = use(paramsPromise);
  const project = decodeURIComponent(params.project);
  const [g, setG] = useState<GameServerSettings | null>(null);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const s = await apiGet<ProjectSettings>(`/v1/projects/${encodeURIComponent(project)}/settings`);
    setConfigured(s.game != null);
    setG(s.game ?? {});
  }, [project]);
  useEffect(() => {
    // Fetch-on-mount/project-change: load() sets state only after its
    // internal await resolves, syncing external (server) settings into React.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch effect; state is set only after an internal await, not synchronously
    load();
  }, [load]);

  const isEmpty = (v: GameServerSettings) =>
    !v.mods_drive_path &&
    !v.mods_dest_subdir &&
    !v.game_version &&
    !v.server_type &&
    !v.world_subdir &&
    !v.world_snapshot_on_deploy;

  async function save() {
    if (!g) return;
    setErr("");
    setSaving(true);
    try {
      if (isEmpty(g) && configured) {
        await apiSend("DELETE", `/v1/projects/${encodeURIComponent(project)}/game`);
        setConfigured(false);
      } else if (!isEmpty(g)) {
        await apiSend("PUT", `/v1/projects/${encodeURIComponent(project)}/game`, g);
        setConfigured(true);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }

  if (!g) return <div className="text-sm text-secondary">Loading…</div>;

  return (
    <div className="flex flex-col gap-6">
      <SettingCard
        title="Mods & Plugins from Drive"
        desc="Point at a folder in this project's Drive (upload .jar mod/plugin files there from the Drive page). On every deploy the platform copies its files into the container's persistent volume, so the server starts with your mods without rebuilding an image. Files removed from the Drive folder are pruned from the mods dir on the next deploy — only that one dir is touched, never the world."
        footer="Applies on the next build/redeploy — nothing already running changes until then."
        footerAction={
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : saved ? "Saved" : "Save"}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Drive folder" hint='e.g. "/mods" — the folder in this project&apos;s Drive that holds the mod/plugin files. Blank disables the sync.'>
            <Input
              value={g.mods_drive_path ?? ""}
              onChange={(e) => setG({ ...g, mods_drive_path: e.target.value || null })}
              placeholder="/mods"
              className="max-w-xs font-mono"
            />
          </Field>
          <Field label="Mods directory (in volume)" hint='Where the files land inside the persistent volume — "mods" for Forge/Fabric/Paper-with-mods, "plugins" for Bukkit/Spigot/Paper plugins. Default "mods".'>
            <Input
              value={g.mods_dest_subdir ?? ""}
              onChange={(e) => setG({ ...g, mods_dest_subdir: e.target.value || null })}
              placeholder="mods"
              className="max-w-xs font-mono"
            />
          </Field>
        </div>
      </SettingCard>

      <SettingCard
        title="Version Control"
        desc="Pin the game/server version and flavor. These land as the VERSION and TYPE environment variables on the container — the convention itzg/minecraft-server and most game-server images read — but only where the deployment does not already declare them (an explicit env var in the compose file or Environment Variables page always wins)."
        footer="Applies on the next build/redeploy."
        footerAction={
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : saved ? "Saved" : "Save"}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Game version" hint='e.g. "1.21.4" — blank tracks the image&apos;s default (LATEST for itzg/minecraft-server).'>
            <Input
              value={g.game_version ?? ""}
              onChange={(e) => setG({ ...g, game_version: e.target.value || null })}
              placeholder="1.21.4"
              className="max-w-xs font-mono"
            />
          </Field>
          <Field label="Server type" hint='e.g. "PAPER", "FORGE", "FABRIC" — blank uses the image&apos;s default (VANILLA for itzg/minecraft-server).'>
            <Input
              value={g.server_type ?? ""}
              onChange={(e) => setG({ ...g, server_type: e.target.value || null })}
              placeholder="PAPER"
              className="max-w-xs font-mono"
            />
          </Field>
        </div>
      </SettingCard>

      <SettingCard
        title="World Save Snapshots"
        desc="Before each deploy touches the volume, copy the world directory to .hive-snapshots/<build-id>/ inside the same volume — a rollback point per build. Snapshots are kept until you remove them (deploys never prune saves). Restoring one is a manual volume copy."
        footer="Applies on the next build/redeploy."
        footerAction={
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : saved ? "Saved" : "Save"}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Snapshot world before deploys">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={g.world_snapshot_on_deploy ?? false}
                onChange={(e) => setG({ ...g, world_snapshot_on_deploy: e.target.checked })}
              />
              Snapshot the world save before every deploy
            </label>
          </Field>
          <Field label="World directory (in volume)" hint='The save directory to snapshot — default "world" (Minecraft Java&apos;s overworld).'>
            <Input
              value={g.world_subdir ?? ""}
              onChange={(e) => setG({ ...g, world_subdir: e.target.value || null })}
              placeholder="world"
              className="max-w-xs font-mono"
              disabled={!g.world_snapshot_on_deploy}
            />
          </Field>
        </div>
      </SettingCard>

      {err && <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{err}</div>}

      <p className="text-xs text-muted">
        Resource ceilings and the volume mount path live on the{" "}
        <a href={`/projects/${encodeURIComponent(project)}/settings/container`} className="underline hover:text-fg">
          Container
        </a>{" "}
        settings page; the public port/protocol for reaching the server is on{" "}
        <a href={`/projects/${encodeURIComponent(project)}/settings/network`} className="underline hover:text-fg">
          Network
        </a>
        .
      </p>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-secondary">{hint}</p> : null}
    </div>
  );
}
