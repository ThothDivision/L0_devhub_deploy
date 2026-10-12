# Game server presets

These are catalog/configuration presets, not a claim of playable, capacity-approved
or paid deployments. The Games menu unifies Minecraft, Terraria, Factorio, Palworld,
Valheim, Arma 3, ARK: Survival Evolved, GoldenEye: Source, Romestead, Don't Starve Together and Team Fortress 2. Existing image, port, memory and
environment defaults are preserved; Minecraft now explicitly names /data. No upstream source code, game binaries or passwords are copied.

## Audited upstream revisions (2026-10-08)

The README, Compose, Dockerfile/build pipeline and license at these revisions are
our source of truth; image tags below remain mutable and are NOT digest pins.

- Palworld: [Thijs van Loef / palworld-server-docker](https://github.com/thijsvanloef/palworld-server-docker/tree/5d5893cdfeb8b278ef05cce4fac7ea26d7ff95cc).
  README, compose.yaml, Dockerfile, .env.example and .github/workflows/release.yml.
  MIT, copyright 2024 Thijs van Loef.
- Valheim: [community-valheim-tools / valheim-server-docker](https://github.com/community-valheim-tools/valheim-server-docker/tree/4665ba7fe205cb4f1869abbd38d82b6807f71a19).
  README, docker-compose.yaml, Dockerfile and .github/workflows/docker-build.yml.
  Apache-2.0; Valheim/game branding remains Iron Gate Studio's property.
- Arma 3: [BrettMayson / Arma3Server](https://github.com/BrettMayson/Arma3Server/tree/7fa59aeba2a9425b7aa64a6a4f853e895060ef4d).
  README, docker-compose.yml, Dockerfile, .env.example, launch.py and api.py.
  No explicit LICENSE file found at this revision; only the published image is
  referenced. This does not grant rights to redistribute upstream code or games.
- Terraria: [PassiveLemon / terraria-docker](https://github.com/PassiveLemon/terraria-docker/tree/6b5e2cb002625ed7b34678b71a9e6f101c7fd258).
  README and terraria image build definitions. GPL-3.0; upstream notices remain
  with upstream. Existing AUTOCREATE=2 and WORLDNAME=World are retained.
- Factorio: [factoriotools / factorio-docker](https://github.com/factoriotools/factorio-docker/tree/cffe0730048aaeacc059a9b7c1de56c4d4efe682).
  README and image build definitions. MIT; game-server distribution remains
  subject to Wube's game terms, not the wrapper's MIT license.

- Minecraft: [itzg / docker-minecraft-server](https://github.com/itzg/docker-minecraft-server/tree/70b3f73ebc6110aea1bfb6c918e0afc2c55055e7).
  Dockerfile, scripts/start*, docs/versions/minecraft.md,
  docs/types-and-platforms (Vanilla/Paper), docs/configuration/server-properties.md,
  LICENSE (Apache-2.0). TYPE/VERSION/LEVEL/MAX_PLAYERS/MODE/DIFFICULTY are upstream controls.
- ARK: [Hermsi1337 / docker-ark-server](https://github.com/Hermsi1337/docker-ark-server/tree/984d901311a0ec842203ef0d6c7a0905a3604b02).
  README.md, Dockerfile, bin/docker-entrypoint.sh, bin/steam-entrypoint.sh,
  conf.d/arkmanager-user.cfg, conf.d/arkmanager-sub.cfg.template and LICENSE.
  MIT, copyright 2018 Dennis Hermsmeier. Only image references/derived metadata,
  not upstream scripts. **Survival Evolved, not Survival Ascended.**

- GoldenEye: Source: [LacledesLAN / gamesvr-gesource](https://github.com/LacledesLAN/gamesvr-gesource/tree/a75d5fbef7c23438b2cbd7d69155df2764d92006)
  README, linux.Dockerfile, dist/linux/ll-tests and LICENSE (Unlicense). Base image
  ghcr.io/lacledeslan/gamesvr-gesource:latest (linux/amd64, created 2023-04-06, CMD /bin/bash,
  no ENTRYPOINT); Docker Hub lacledeslan/gamesvr-gesource no longer resolves.
  The preset uses the derived image **ghcr.io/solutionsasservice/gamesvr-gesource:latest**
  built from [SolutionsAsService / gamesvr-gesource @ e32998a](https://github.com/SolutionsAsService/gamesvr-gesource/tree/e32998abf43ff5d09f05e2ef93db4be1ae976d72)
  (devhub.Dockerfile, dist/linux/devhub-entrypoint.sh, .github/workflows/devhub-image.yml).
  Published 2026-10-12 by GitHub Actions as linux/amd64, digest
  sha256:bef77cd2b34ec65d1d766955b8ab58f92a117ab11e1505032fd50945cf93e5af (also tag
  sha-e32998abf43ff5d09f05e2ef93db4be1ae976d72); the GHCR package is public and the manifest
  resolves anonymously. ENTRYPOINT /usr/local/bin/devhub-entrypoint.sh, user GESource.
- Romestead: [indifferentbroccoli / romestead-server-docker](https://github.com/SolutionsAsService/romestead-server-docker/tree/e6cc37b8b3d8e642c613d3a4296433844a724ad1)
  (SolutionsAsService fork). README, Dockerfile, docker-compose.yml, .env.example,
  scripts/init.sh, scripts/functions.sh, scripts/start.sh and LICENSE (GPL-3.0).
  Image indifferentbroccoli/romestead-server-docker:latest (also v1/v1.0/v1.0.1), linux/amd64.
  The fork also publishes ghcr.io/solutionsasservice/romestead-server-docker:main; not used
  by default because upstream has semver tags.
- Don't Starve Together: [Jamesits / docker-dst-server](https://github.com/Jamesits/docker-dst-server/tree/503f0fee89ea076241cfa044de28caad75c33b6c)
  (HEAD, 2022-05-21). README, Dockerfile, docker-compose.yml, azure-pipelines.yaml,
  scripts_system/entrypoint.sh, supervisor/supervisor.conf, dst_default_config/ and
  LICENSE (GPL-2.0-or-later). Docker Hub jamesits/dst-server: latest = vanilla
  (2022-05-21, sha256:fa61065f8d2d…), nightly (2025-07-12), steamcmd-rebase and -slim
  variants; all linux/amd64 only. ENTRYPOINT entrypoint.sh, CMD supervisord; VOLUME /data;
  EXPOSE 10999-11000/udp 12346-12347/udp.
- Team Fortress 2: [melkortf / tf2-servers](https://github.com/melkortf/tf2-servers/tree/2bcf13e498503514213deb52bfcfd2783371baf5)
  (release 4.0.8). README, packages/tf2-base/{amd64,i386}.Dockerfile, entrypoint.sh,
  server.cfg.template, healthcheck.sh, .github/workflows/build.yml and LICENSE (MIT,
  copyright 2021 melkor.tf). Preset uses the 64-bit **ghcr.io/melkortf/tf2-base/amd64:latest**
  (index sha256:959278f5b886…, created 2026-10-09, version label 4.0.8, ~2.1 GB compressed);
  tags latest, 4, 4.0, 4.0.8, nightly and sha-*. ENTRYPOINT ./entrypoint.sh, CMD
  `+sv_pure 1 +map cp_badlands +maxplayers 24`, user tf2, EXPOSE 27015/tcp, 27015/udp, 27020/udp.
  The un-suffixed ghcr.io/melkortf/tf2-base is the 32-bit variant and is not used.

## Audited configure controls and profiles

The same metadata drives Games navigation, labeled forms, validation, summary and
image payload in both repositories. Profiles are small supported env overlays,
not claims of game edition compatibility or preinstalled mods.

| Game | Supported controls / profiles | Version semantics |
| --- | --- | --- |
| Minecraft Java | Vanilla/Paper survival; EULA, world, players, mode, difficulty | VERSION runtime LATEST/vanilla SNAPSHOT/exact release syntax; OCI latest or user tag/digest |
| Terraria vanilla | Existing medium/default, new small/large; world, seed, difficulty, players, optional password | terraria-latest OCI channel controls binary; no fake runtime selector |
| Factorio | Load existing or generate save; SAVE_NAME, GENERATE_NEW_SAVE, LOAD_LATEST_SAVE | stable/latest OCI channels; exact custom OCI tag/digest syntax only |
| Palworld | Private direct connect; name, players, join password | latest OCI; Steam runtime independent |
| Valheim | Private Steam/crossplay; name, world, password, listing | latest OCI; downloaded runtime independent |
| Arma 3 | Prepared config volume; profile/startup world, headless count, local Launcher HTML mod preset, dedicated Steam login | v2 OCI; refreshed Steam depots independent |
| GoldenEye: Source | Standard 16 / small 8 / N64-style 4 players; hostname, start map, max players (1-32), optional join password, optional RCON password | Game files baked into OCI image; tag/digest is the only version |
| Romestead | Auto-created or named world; players, optional password, world size/seed, cheats, update-on-start | latest/v1 OCI; Steam depot downloaded on start, independent of tag |
| Don't Starve Together | Master + Caves cluster, 64-bit or legacy 32-bit binary; required masked cluster token. Name/password/players/PvP are cluster.ini file settings | latest/vanilla/nightly OCI; steamcmd updates game + mods on every start |
| Team Fortress 2 | Direct-connect or Steam Datagram Relay; hostname, optional join password, required RCON password, optional GSLT, optional SourceTV password | latest/4/nightly OCI; TF2 baked in plus srcds -autoupdate |
| ARK ASE | Private TheIsland or custom map/mods; session/map/players, join/admin passwords, numeric Workshop IDs, update/validation/backup switches | latest OCI; ASE runtime download/update independent |

Field ranges are conservative **form bounds**, not certified upstream capacity.
Custom image tags/digests are limited to each audited repository and syntax
validated. They are not fabricated supported releases or verified registry
availability. Real releases/mods/maps must be checked by the operator; TheIsland
is the only seeded ARK map. No Ascended image/variant is offered.

Factorio player limits/passwords/mod portal authentication belong to prepared
server-settings.json, not invented env controls. Arma mission/player/game/admin
settings belong to prepared configs; MODS_PRESET is a Launcher HTML preset path,
not fabricated Workshop ID support. Terraria remains vanilla, no tModLoader.
Advanced env editing remains available for existing non-transport settings and
additional upstream keys; public ports/admin exposure are fixed to safe metadata.
Port changes require a separate audited custom-image flow; game-specific
port/env coupling cannot drift through these screens.

Configure → review → create is explicit, with back navigation and readiness
checkboxes for image/platform/resources/volume/backup/backend policy; multiport
profiles additionally require verified direct serving-node ingress. The entire
summary hides env VALUES, even under unrecognized keys, to prevent cross-key
credential leaks. Secrets are masked in inputs; errors name fields only, never
reflect submitted credentials or raw backend error strings. No config export.

**Local runtime limitation:** the running native backend has not received the
last secret-policy changes. Do not submit real credentials there. Publication
of this UI/backend source does not upgrade running binaries. The form warns
and requires operator confirmation; this task never logs in to Steam, pulls
images/game binaries or restarts mesh/DB/backend services.

## ARK-specific operations

ASE exposes 7777/UDP (game), 7778/UDP (game+1), 27015/UDP (query), persists /app.
Upstream enables internal 27020/TCP RCON; it is deliberately NOT in public ports.
ADMIN_PASSWORD and SERVER_PASSWORD default empty, overriding unsafe sample defaults.
The image is linux/amd64 only; first start is a very large server download. 8g
is only a requested memory budget, not an upstream minimum or verified capacity.
Keep WSL volumes on Linux filesystem, not Windows-mounted storage. Backup/update
switches follow Dockerfile/entrypoint support; VALIDATE_ON_START only matters
with UPDATE_ON_START=true. UPDATE_CRON/RESTART_CRON are explicitly unsupported
upstream and not offered. No arbitrary map/version list or default credential.

## GoldenEye: Source operations

The stock LacledesLAN image's CMD is `/bin/bash` with no ENTRYPOINT, and
`/v1/deploy/image` cannot pass a run command, so the preset uses a thin derived
image from the SolutionsAsService fork (fix option 2). Its entrypoint runs
`/app/srcds_run -game gesource -norestart -port 27015 +maxplayers $GES_MAXPLAYERS +map $GES_MAP`
(exec'd, so SIGTERM reaches srcds_run).

| Env | Default | Validation (UI and entrypoint) |
| --- | --- | --- |
| GES_MAP | ge_archives | `[A-Za-z0-9_]{1,64}`; entrypoint also requires gesource/maps/<map>.bsp |
| GES_MAXPLAYERS | 16 | integer 1-32 |
| GES_HOSTNAME | GoldenEye: Source | 1-63 chars; no quotes, `;`, `\`, `$`, backticks, newlines |
| GES_PASSWORD | empty (public) | optional secret; 1-64 chars, no spaces/quotes/`;`/`\`/`$`/backticks |
| GES_RCON_PASSWORD | empty (RCON off) | optional secret; same charset |

srcds splits console input on `;` and newlines, so these allow-lists are what
prevent command injection; the entrypoint additionally never evaluates values in a
shell. Hostname and passwords go to `gesource/cfg/devhub_env.cfg` (mode 0600),
which is `exec`'d at the end of server.cfg so it overrides the stock hostname on
every map load. Invalid values stop the container with exit 64 and messages name
keys only. Passwords are masked and sensitive in both `isSensitiveGameEnv` and the
backend `game_secret` list. srcds RCON shares 27015/TCP and is never published.
`MALLOC_CHECK_=0` is inherited. Only logs are persisted so a named volume never
shadows baked game files. Entrypoint behaviour was unit-tested with a stubbed
srcds_run; the image itself was not run and no client join was tested.

## Romestead operations

Single 8050/UDP port; PORT is locked to 8050 because upstream writes it into
config.json. PUID/PGID default 1000 and must stay set (init.sh exits otherwise);
init runs as root to chown then drops to `steam` via su, which works under
no-new-privileges with default capabilities. UPDATE_ON_START=true is mandatory for
the first boot (anonymous DepotDownloader install of app 4763510). Upstream
writes PASSWORD/world name/seed into config.json through an unquoted heredoc, so
the form rejects quotes, backslashes, `$` and backticks and restricts seeds.
Graceful stop sends `stop` over a FIFO and waits 30s. Upstream asks for 4–8 GB
RAM, 2–4 cores and 10–20 GB disk; 8g is a request, not verified capacity.

## Don't Starve Together operations

**Multiport / no-NAT limit (read first).** The image runs two shards (Master
10999/UDP, Caves 11000/UDP) plus Steam ports 12346/12347/UDP, and upstream says
not to NAT them to different port numbers. mesh_raw forwards only the primary
port and public allocations may differ, so this is not playable on mesh-only
hosting. It needs direct serving-node ingress with identical public port numbers
for all four; the form's ingress checkbox gates review. The two extra high UDP
ports DST opens for Steam are ephemeral/outbound and 10998/UDP is shard-to-shard on
127.0.0.1; neither is published.

DST_CLUSTER_TOKEN is required, masked, empty by default and marked sensitive in
`isSensitiveGameEnv` and the backend `game_secret` list. The UI rejects whitespace and
control characters; upstream writes it with printf to Cluster_1/cluster_token.txt on
each start. DST_SERVER_ARCH selects bin64 (amd64, README example) or the image's
legacy 32-bit default (x86). Cluster name, description, password, max players (64),
PvP (on), game mode and whitelist are **cluster.ini file settings** in the /data
volume, generated on first start with a public, password-less name; there are no
env controls upstream, and the catalog does not invent any. The generated [SHARD]
cluster_key is a fixed upstream value (shards bind 127.0.0.1); change it.
Disabling Caves or using one shard requires changing supervisor.conf in a derived
image. The entrypoint starts as root to chown /data, then supervisord runs both
shards as `dst`. Every start runs `steamcmd app_update 343050` (anonymous) and a
server-mods update, so first start and restarts need network and the OCI tag never
pins the game. Saving on stop can take ~5 minutes (compose stop_grace_period 6m,
supervisor stopwaitsecs 720); short stop timeouts can lose progress. latest was
built 2022-05 (Debian buster); nightly 2025-07. GPL-2.0 applies to the image's
scripts; we reference the published image only.

## Team Fortress 2 operations

Vanilla `tf2-base` (no SourceMod), 64-bit image. Only 27015/UDP is published;
27015/TCP RCON and SourceTV 27020/UDP are never published (SourceTV stays enabled
inside but is unreachable; STV_PASSWORD is offered masked). CLIENT_PORT and
STEAM_PORT are internal. PORT is locked to 27015 because upstream binds with
`-strictportbind`.

**RCON_PASSWORD is required** (8-64 chars, masked, empty default): the image's
built-in default is the public value `123456`, and its healthcheck and SIGTERM
handler (`rcon ... quit`) use RCON on 127.0.0.1, so leaving it empty would break
graceful stop/health and leaving the default would be unsafe. Upstream envsubsts
RCON/join/SourceTV passwords and hostname into quoted server.cfg lines and passes
RCON_PASSWORD unquoted on a bash command line, so whitespace, quotes, `;`, `\`, `$`,
backticks (and `*` for RCON) are rejected. SERVER_TOKEN is an optional Steam Game
Server Login Token (App ID 440; 32 hex chars); without it srcds logs in anonymously
and may not be listed. ENABLE_FAKE_IP=1 enables Steam Datagram Relay. TICKRATE is
not offered.

The CMD is fixed at `+sv_pure 1 +map cp_badlands +maxplayers 24` and image deploy
cannot change it; cp_badlands is the only map shipped. **Persistence decision:**
a vanilla TF2 server has no world state, and mounting over tf/maps would hide
cp_badlands, and over tf/cfg would hide the templates. The platform always attaches
a volume, so it is mounted at the inert `/home/tf2/devhub-data` (unused by the
image). Logs and any runtime `-autoupdate` downloads live in the container layer
and are lost on redeploy. Custom maps/rotation need a derived image. Upstream
does not publish a memory requirement; 2g is a request, not verified capacity.

## Transport and persistence

All use the prebuilt-image /v1/deploy/image engine, not Git builds or HTTP ingress.
A nonempty ports list REPLACES defaults, so the primary port is included alongside
all seeded extra ports. Container ports below are not promises of public ports.
**Existing engine limitation:** fluid-core documents that mesh_raw only forwards
the PRIMARY port (spec_idx != 0 is unsupported). Secondary raw ports receive
allocations but are not cross-node forwardable. Valheim, Arma, ARK and Don't Starve Together therefore need
verified serving-node raw ingress for all secondary ports; a mesh-only deployment
is NOT a ready-to-play multiport server. This preset task does not change routing.

| Preset | Image | Container ports | Persistent mount |
| --- | --- | --- | --- |
| Minecraft (unchanged) | itzg/minecraft-server:latest | 25565/TCP | /data (existing default) |
| Terraria | passivelemon/terraria-docker:terraria-latest | 7777/TCP | /opt/terraria/config |
| Factorio | factoriotools/factorio:stable | 34197/UDP | /factorio |
| Palworld | thijsvanloef/palworld-server-docker:latest | 8211/UDP | /palworld |
| Valheim | ghcr.io/community-valheim-tools/valheim-server:latest | 2456–2458/UDP | /config |
| Arma 3 | ghcr.io/brettmayson/arma3server/arma3server:v2 | 2302–2306/UDP | /arma3/server |
| ARK: Survival Evolved | hermsi/ark-server:latest | 7777,7778,27015/UDP; no public RCON | /app |
| GoldenEye: Source | ghcr.io/solutionsasservice/gamesvr-gesource:latest (derived) | 27015/UDP; no public RCON | /app/gesource/logs |
| Romestead | indifferentbroccoli/romestead-server-docker:latest | 8050/UDP | /home/steam/server-files |
| Don't Starve Together | jamesits/dst-server:latest | 10999,11000,12346,12347/UDP; same public numbers required | /data |
| Team Fortress 2 | ghcr.io/melkortf/tf2-base/amd64:latest | 27015/UDP; no public RCON or SourceTV | /home/tf2/devhub-data (inert; stateless) |

Palworld upstream publishes amd64/arm64 images; Valheim's build and Arma's Compose
specify linux/amd64. Terraria/Factorio retain existing image architecture behavior;
this catalog does not implement architecture-aware placement. Verify the selected
node and registry image before deploying; no platform emulation is promised.

World persistence uses the engine's existing project volume path. Valheim's
optional /opt/valheim cache is not persisted: the engine accepts a single mount,
and /config is the essential world/backup directory. Image defaults without a
volume_mount_path still use existing /data behavior. Shadow includes the minimal
request/fanout/settings/mount plumbing needed to honor non-/data game paths.

## Safe configuration and operational gates

- Palworld requires a user-supplied SERVER_PASSWORD here. COMMUNITY=false;
  no 27015/query port is exposed unless an operator adds it for community listing
  and configures PUBLIC_PORT/IP to match the real allocation. RCON and REST are
  disabled. Never publish 8212 REST or enable DEBUG with credentials. Upstream
  minimum is 16 GB RAM, 4 cores and 8 GB disk (larger recommended); the platform
  can clamp resource limits. The preset requests 16g, not verified capacity.
- Valheim requires SERVER_PASS of at least five characters. SERVER_PUBLIC=false
  and CROSSPLAY=false. Supervisor HTTP (9001) and status HTTP are disabled and
  unpublished. The third UDP port follows upstream Compose/EXPOSE, although the
  basic vanilla README example uses only 2456–2457. CAP_SYS_NICE is optional and
  not requested. Upstream recommends 120 seconds for graceful shutdown; this
  preset does not add lifecycle policy. Back up worlds before upgrades.
- Arma requires private STEAM_USER and STEAM_PASSWORD. Upstream says the account
  need not own Arma 3 but Steam Guard must be disabled. Do not disable Steam Guard
  on a primary account: use an operator-approved dedicated account or do not
  deploy this image. No credentials are invented, stored in preset metadata or
  included in errors. Upstream itself logs the Steam account display name; do
  not share raw upstream logs without review.
- **Arma is not ready on an empty volume.** Operators must prepare
  /arma3/server/configs/main.cfg, missions and needed mods before starting. The
  published Dockerfile does not copy the repository configs into the image.
  The catalog does not bootstrap those files or configure admin/game passwords.
  Keep config credentials private, not in public template definitions.
- Container port fields are editable; keep image PORT/SERVER_PORT and every
  dependent port consistent. Confirm firewall and actual public allocation for
  multiport/adjacent-port games. HTTP exposure does not provide UDP support.
  The mesh's reliable ordered UDP framing can add head-of-line latency; packet
  reachability, game discovery and acceptable latency need real client tests.
- All new secret values default empty. The configure screen masks credential
  inputs and prevents creation with missing required env. Server settings force
  game credential keys into existing encrypted-at-rest/masked env storage even
  when an image request cannot supply a sensitive flag. This change must reach
  the backend to protect arbitrary Steam/password values; updating UI alone is
  insufficient. Runtime operators and upstream game processes still receive
  credentials by design. No secrets/provider config are changed by this task.
- Pin an audited image digest/version before production. v2/stable/latest are
  moving tags; Arma also refreshes game depots on startup, independent of OCI pin.
  Actual first-start downloads, game launches, Steam login and client join tests
  are intentionally not part of this catalog change.

## Verification

Run from ui: node scripts/check-game-presets.mjs (Node 24's TypeScript stripping).
This is an offline catalog/schema regression validator, not a mock game server.
It checks all eleven identities, transport/persistence, multiports, typed fields,
profiles, OCI/runtime version validation, missing/short credentials, masked
summary values, backend policy and accessibility/navigation source guards.
These source guards are NOT DOM/browser interaction proof.

Also run the repository frontend type/build checks and applicable Rust compilation
before deployment. Browser interaction and game-runtime verification are separate
claims; a green catalog script/build cannot establish either. No browser policy
restriction should be bypassed to perform this work.
