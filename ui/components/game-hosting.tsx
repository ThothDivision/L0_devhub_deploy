"use client";
import { useState, type ReactNode } from "react";
import { GAME_SERVER_PRESETS, GAME_SETUP_STEPS, gamePresetEnvErrors, gameImageError, gameSummaryEnv, gameReviewRows, gameFieldOptionLabel, isSensitiveGameEnv, type GameField, type GameServerPreset, type GameSetupGroup } from "@/lib/game-server-presets";
import { currentTeam, switchTeam } from "@/lib/api";
import { TeamSelect } from "@/components/team-picker";
import { Card, Button, Input } from "@/components/ui";
export type GameDeployOptions = { image: string; project: string; port: number; protocol: string; memory: string; ports: { container_port: number; protocol: string; label?: string }[]; env: Record<string, string>; volumeMountPath: string };

// Raw keys that must stay at their audited value (transport ports, disabled admin surfaces).
const LOCKED_RAW_KEY = /(PORT|RCON|REST_API|SUPERVISOR|STATUS_HTTP|COMMUNITY|LOG_LEVEL|STEAM_LOGIN)/;
const RESERVED_NEW_KEY = /(PORT|RCON|REST_API|SUPERVISOR|STATUS_HTTP|COMMUNITY|LOG_LEVEL)/;
const mentions = (message: string, key: string) => new RegExp("\\b" + key + "\\b").test(message);
const friendly = (message: string, key: string) => message.startsWith(key + " ") ? "This field " + message.slice(key.length + 1) : message;

/** Game picker only: no game settings, env keys or ports are shown until a game is chosen. */
export function GamesMenu({ onSelect, disabled }: { onSelect: (game: GameServerPreset) => void; disabled: boolean }) {
  return <details className="mb-8 rounded-xl border border-border p-4" open><summary className="cursor-pointer text-lg font-semibold">Games — dedicated hosting</summary><p className="my-3 text-sm text-secondary">Pick a game to start a guided setup. Server name, world, passwords and ports are asked for step by step after you choose.</p><nav aria-label="Games" className="grid gap-2 sm:grid-cols-2">{GAME_SERVER_PRESETS.map(game => <button type="button" key={game.gameId} disabled={disabled} onClick={() => onSelect(game)} className="flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:bg-subtle disabled:opacity-50"><span aria-hidden className="flex h-8 min-w-8 items-center justify-center rounded px-1 text-xs font-bold text-white" style={{ background: game.color }}>{game.tag}</span><span className="min-w-0"><span className="block font-semibold">{game.name.replace(/ Server$/, "")}</span><span className="mt-0.5 line-clamp-2 block text-xs text-secondary">{game.desc}</span></span></button>)}</nav></details>;
}

function Step({ n, title, desc, children }: { n: number; title: string; desc?: string; children: ReactNode }) {
  return <section aria-label={"Step " + n + ": " + title} className="mb-5 rounded-lg border border-border p-4"><h2 className="flex items-center gap-2 font-semibold"><span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-full bg-fg text-xs text-bg">{n}</span>{title}</h2>{desc && <p className="mb-3 mt-1 text-sm text-secondary">{desc}</p>}<div className="grid gap-4 sm:grid-cols-2">{children}</div></section>;
}

export function ConfigureGame({ game, onBack, onCreate, deploying, error }: { game: GameServerPreset; onBack: () => void; onCreate: (opts: GameDeployOptions) => void; deploying: boolean; error: string }) {
  const [env, setEnv] = useState<Record<string, string>>({ ...game.env });
  const [image, setImage] = useState(game.image);
  const [name, setName] = useState(game.gameId ?? "game-server");
  const [memory, setMemory] = useState(game.memory);
  const [team, setTeam] = useState(currentTeam());
  const [profile, setProfile] = useState("");
  const [stage, setStage] = useState<"configure" | "review">("configure");
  const [ready, setReady] = useState(false);
  const [ingress, setIngress] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [newKey, setNewKey] = useState("");
  const ports = [{ container_port: game.port, protocol: game.protocol }, ...(game.extraPorts ?? []).map(p => ({ container_port: p.port, protocol: p.protocol, label: p.label }))];
  const portList = ports.map(p => p.container_port + "/" + p.protocol.toUpperCase()).join(", ");
  const envErrors = gamePresetEnvErrors(game, env);
  const imageError = gameImageError(game, image);
  const nameError = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ? "" : "Use 1–63 lowercase letters, numbers or hyphens, starting with a letter or number.";
  const memoryError = !/^\d+(\.\d+)?[mg]$/i.test(memory) || parseFloat(memory) <= 0 ? "Enter a positive amount like 4g or 512m." : "";
  const errors = [...envErrors, ...(imageError ? [imageError] : []), ...(nameError ? ["Project name: " + nameError] : []), ...(memoryError ? ["Memory: " + memoryError] : [])];
  const canReview = !errors.length && ready && (!game.extraPorts?.length || ingress);
  const update = (key: string, value: string) => setEnv(old => ({ ...old, [key]: value }));
  const touch = (key: string) => setTouched(old => ({ ...old, [key]: true }));
  const show = (key: string) => attempted || !!touched[key];
  const fieldKeys = new Set((game.fields ?? []).map(f => f.key));
  const fieldsIn = (group: GameSetupGroup) => (game.fields ?? []).filter(f => (f.group ?? "advanced") === group);
  const rawEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !fieldKeys.has(key)));
  const requiredLabels = game.requiredEnv.map(r => game.fields?.find(f => f.key === r.key)?.label ?? r.key);
  const checklist = [
    "A " + game.platform + " host with about " + game.memory + " of memory and enough disk for the game files.",
    "Network access to " + portList + (game.extraPorts?.length ? ", with every port reaching the host directly (the mesh only forwards the main port)." : ".") + " Public port numbers may differ.",
    ...(requiredLabels.length ? ["Ready to enter: " + requiredLabels.join(", ") + "."] : []),
    "Saved data lives in " + game.volumeMountPath + "; plan backups before you invite players.",
  ];
  const unmatched = envErrors.filter(e => !(game.fields ?? []).some(f => mentions(e, f.key)));
  async function submit() {
    if (!canReview || deploying || stage !== "review") return;
    try { await switchTeam(team === "personal" ? "__personal__" : team); onCreate({ image, project: name, port: game.port, protocol: game.protocol, memory, ports, env, volumeMountPath: game.volumeMountPath }); } catch { setSubmitError("Could not select team. No deployment submitted."); }
  }
  const renderField = (f: GameField) => {
    const fieldErrors = show(f.key) ? envErrors.filter(e => mentions(e, f.key)).map(e => friendly(e, f.key)) : [];
    const required = game.requiredEnv.some(r => r.key === f.key);
    const hint = [f.help, f.kind === "integer" ? "Whole number from " + (f.min ?? 0) + " to " + (f.max ?? 1000) + "." : ""].filter(Boolean).join(" ");
    const common = { id: "game-" + f.key, "aria-invalid": fieldErrors.length > 0, "aria-describedby": "game-" + f.key + "-help", onBlur: () => touch(f.key) };
    return <label key={f.key} htmlFor={"game-" + f.key} className="text-sm"><span className="font-medium">{f.label}</span>{required && <span className="ml-1 text-xs text-red-600">(required)</span>}{f.kind === "select" ? <select {...common} className="mt-1 block w-full rounded border border-border bg-card p-2" value={env[f.key] ?? ""} onChange={e => { update(f.key, e.target.value); touch(f.key); }}><option value="">Game default</option>{f.options?.map(v => <option key={v} value={v}>{gameFieldOptionLabel(f, v)}</option>)}</select> : <Input {...common} className="mt-1" autoComplete="off" placeholder={f.placeholder ?? (required ? "" : "Leave blank for the game default")} type={f.kind === "secret" ? "password" : f.kind === "integer" ? "number" : "text"} min={f.min} max={f.max} value={env[f.key] ?? ""} onChange={e => update(f.key, e.target.value)} />}<span id={"game-" + f.key + "-help"} className="mt-1 block text-xs text-secondary">{hint}</span>{fieldErrors.map(e => <span key={e} role="alert" className="mt-1 block text-xs text-red-600">{e}</span>)}</label>;
  };
  const visibleSteps = GAME_SETUP_STEPS.filter(step => step.id === "basics" || step.id === "advanced" || fieldsIn(step.id).length > 0);
  const stepNo = (id: GameSetupGroup) => visibleSteps.findIndex(step => step.id === id) + 1;
  return <div className="mx-auto max-w-3xl"><button type="button" disabled={deploying} onClick={onBack} className="mb-4 text-sm underline">← Back to Games</button><Card className="p-6"><h1 className="text-2xl font-semibold">Set up your {game.name}</h1><p className="my-3 text-sm text-secondary">{game.desc}</p>
  {stage === "configure" ? <>
    <section aria-label="Before you start" className="mb-5 rounded-lg border border-border bg-subtle/40 p-4"><h2 className="font-semibold">What you need before you start</h2><ul className="mt-2 space-y-1 text-sm">{checklist.map(item => <li key={item} className="flex gap-2"><span aria-hidden>☐</span><span>{item}</span></li>)}</ul><details className="mt-3 text-sm"><summary className="cursor-pointer font-medium">Game-specific notes ({game.setupNotes.length})</summary><ul className="mt-2 space-y-2 text-xs text-secondary">{game.setupNotes.map(note => <li key={note} className="flex gap-2"><span aria-hidden>☐</span><span>{note}</span></li>)}</ul></details><p role="note" className="mt-3 text-xs text-amber-600">Passwords and tokens need the updated backend secret protection. This local backend has not been upgraded yet, so do not enter real credentials or deploy them here.</p></section>
    <Step n={stepNo("basics")} title={GAME_SETUP_STEPS[0].title} desc={GAME_SETUP_STEPS[0].desc}>
      <label className="text-sm"><span className="font-medium">Project name</span><Input aria-label="Project name" className="mt-1" aria-invalid={!!nameError && show("name")} value={name} onBlur={() => touch("name")} onChange={e => setName(e.target.value)} /><span className="mt-1 block text-xs text-secondary">Used for the project and its address in DevHub.</span>{nameError && show("name") && <span role="alert" className="mt-1 block text-xs text-red-600">{nameError}</span>}</label>
      <div className="text-sm"><span className="block font-medium">Team</span><TeamSelect value={team} onChange={setTeam} /></div>
      {!!game.profiles?.length && <label className="text-sm sm:col-span-2"><span className="font-medium">Starting point</span><select aria-label="Starting point" className="mt-1 block w-full rounded border border-border bg-card p-2" value={profile} onChange={e => { const p = game.profiles?.find(p => p.id === e.target.value); setProfile(e.target.value); if (p) setEnv(old => ({ ...old, ...p.env })); }}><option value="">Recommended defaults</option>{game.profiles?.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select><span className="mt-1 block text-xs text-secondary">Fills in the settings below with a tested combination. You can still change any of them.</span></label>}
      {fieldsIn("basics").map(renderField)}
      {!game.fields?.length ? <p className="text-sm text-secondary sm:col-span-2">{game.name} has no settings DevHub can fill in; configure it through the image&apos;s config files as described in the notes above.</p> : null}
    </Step>
    {GAME_SETUP_STEPS.slice(1, 3).map(step => fieldsIn(step.id).length ? <Step key={step.id} n={stepNo(step.id)} title={step.title} desc={step.desc}>{fieldsIn(step.id).map(renderField)}</Step> : null)}
    <Step n={stepNo("advanced")} title={GAME_SETUP_STEPS[3].title} desc={GAME_SETUP_STEPS[3].desc}>
      {fieldsIn("advanced").map(renderField)}
      <label className="text-sm"><span className="font-medium">Memory to reserve</span><Input aria-label="Requested memory" className="mt-1" aria-invalid={!!memoryError} value={memory} onChange={e => setMemory(e.target.value)} /><span className="mt-1 block text-xs text-secondary">Recommended {game.memory}. A request, not a guarantee; check the host has it free.</span>{memoryError && <span role="alert" className="mt-1 block text-xs text-red-600">{memoryError}</span>}</label>
      <label className="text-sm"><span className="font-medium">Image channel</span><select aria-label="Documented image channel" className="mt-1 block w-full rounded border border-border bg-card p-2" value={game.imageTags?.includes(image.split(":").pop() ?? "") ? image.split(":").pop() : "custom"} onChange={e => { if (e.target.value !== "custom") setImage(game.image.replace(/:[^/:]+$/, ":" + e.target.value)); }}><option value="custom">Custom tag / digest</option>{game.imageTags?.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select><span className="mt-1 block text-xs text-secondary">The container image version, not the game version.</span></label>
      <label className="text-sm sm:col-span-2"><span className="font-medium">Container image</span><Input aria-label="Audited repository image reference" className="mt-1 font-mono text-xs" aria-invalid={!!imageError} value={image} onChange={e => setImage(e.target.value)} /><span className="mt-1 block text-xs text-secondary">{game.runtimeVersionNote} Custom tags/digests are syntax-checked only; registry availability is not verified.</span>{imageError && <span role="alert" className="mt-1 block text-xs text-red-600">{imageError}</span>}</label>
    </Step>
    <details className="my-5 rounded-lg border border-border p-4"><summary className="cursor-pointer font-medium">Advanced (raw environment variables)</summary><p className="mt-2 text-xs text-secondary">Most people never need this. These are the exact variables sent to the container; the steps above already set the important ones. Port and admin keys are locked to their safe values. Credentials are masked.</p>{Object.entries(rawEnv).filter(([key]) => Object.hasOwn(game.env, key)).map(([key, value]) => <label className="mt-2 block text-sm" key={key}><span className="font-mono text-xs">{key}</span><Input aria-label={key} autoComplete="off" type={isSensitiveGameEnv(key) ? "password" : "text"} value={value} disabled={LOCKED_RAW_KEY.test(key)} onChange={e => update(key, e.target.value)} /></label>)}{Object.entries(rawEnv).filter(([key]) => !Object.hasOwn(game.env, key)).map(([key, value]) => <label className="mt-2 block text-sm" key={key}><span className="font-mono text-xs">{key}</span><Input aria-label={"Advanced " + key} autoComplete="off" type={isSensitiveGameEnv(key) ? "password" : "text"} value={value} onChange={e => update(key, e.target.value)} /></label>)}<div className="mt-3 flex items-end gap-2"><label className="flex-1 text-sm">Add a variable<Input aria-label="Additional environment key" placeholder="CUSTOM_KEY" value={newKey} onChange={e => setNewKey(e.target.value.toUpperCase())} /></label><Button variant="outline" onClick={() => { const key = newKey.trim(); if (/^[A-Z][A-Z0-9_]*$/.test(key) && !Object.hasOwn(env, key) && !fieldKeys.has(key) && !RESERVED_NEW_KEY.test(key)) { update(key, ""); setNewKey(""); } }}>Add</Button></div></details>
    <section aria-label="Confirm hosting readiness" className="my-5 space-y-3 rounded-lg border border-border p-4"><h2 className="font-semibold">Confirm and continue</h2><label className="flex gap-2 text-sm"><input type="checkbox" checked={ready} onChange={e => setReady(e.target.checked)} />I checked that the host supports {game.platform}, has enough memory and disk, that saved data in {game.volumeMountPath} is backed up, and that this DevHub backend has the updated password protection.</label>
    {!!game.extraPorts?.length && <label className="flex gap-2 text-sm"><input type="checkbox" checked={ingress} onChange={e => setIngress(e.target.checked)} />I confirmed every game port ({portList}) reaches the host directly. The built-in mesh only forwards the main port, so this game will not work through the mesh alone.</label>}</section>
    {attempted && !!errors.length && <div role="alert" className="my-3 text-sm text-red-600"><p className="font-medium">Fix these before reviewing:</p><ul className="list-disc pl-5">{[...errors.filter(e => !envErrors.includes(e)), ...unmatched, ...envErrors.filter(e => !unmatched.includes(e))].map(e => <li key={e}>{e}</li>)}</ul></div>}
    {attempted && !errors.length && (!ready || (!!game.extraPorts?.length && !ingress)) && <p role="alert" className="my-3 text-sm text-red-600">Tick the confirmation box{game.extraPorts?.length ? "es" : ""} above to continue.</p>}
    <Button disabled={deploying} onClick={() => { setAttempted(true); if (canReview) setStage("review"); }}>Review configuration</Button>
  </> : <section aria-label="Deployment summary"><h2 className="text-lg font-semibold">Review before creating</h2><dl className="my-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm"><dt className="text-secondary">Project</dt><dd>{name}</dd><dt className="text-secondary">Team</dt><dd>{team}</dd><dt className="text-secondary">Memory</dt><dd>{memory}</dd><dt className="text-secondary">Ports</dt><dd>{portList}</dd><dt className="text-secondary">Saved data</dt><dd className="font-mono text-xs">{game.volumeMountPath}</dd><dt className="text-secondary">Image</dt><dd className="break-all font-mono text-xs">{image}</dd></dl>
    {GAME_SETUP_STEPS.map(step => { const rows = gameReviewRows(game, env).filter(r => r.group === step.id); return rows.length ? <div key={step.id} className="my-3"><h3 className="text-sm font-semibold">{step.title}</h3><dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">{rows.map(row => <div key={row.key} className="contents"><dt className="text-secondary">{row.label}</dt><dd className="break-all">{row.value}</dd></div>)}</dl></div> : null; })}
    {!!Object.keys(rawEnv).length && <details className="my-3 text-xs"><summary className="cursor-pointer">Raw environment variables ({Object.keys(rawEnv).length})</summary><dl className="mt-2">{gameSummaryEnv(rawEnv).map(row => <div key={row.key} className="flex gap-3"><dt className="font-mono">{row.key}</dt><dd className="break-all">{row.value}</dd></div>)}</dl></details>}
    <p className="my-3 text-sm">This review does not prove the game launches, the image pulls, the ports are reachable or the host has capacity.</p><div className="flex gap-2"><Button variant="outline" disabled={deploying} onClick={() => setStage("configure")}>Back to configuration</Button><Button disabled={!canReview || deploying} onClick={submit}>{deploying ? "Creating…" : "Create game server"}</Button></div></section>}
  {(error || submitError) && <p role="alert" className="mt-3 text-sm text-red-600">Deployment failed. Check private operator logs; raw server errors are not shown here.{submitError}</p>}
  </Card></div>;
}
