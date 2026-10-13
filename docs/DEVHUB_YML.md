# devhub.yml and the DevHub GitHub Action

`devhub.yml` is the standard, declarative DevHub project file. It sits at the
root of an application repository and is read by the **Deploy to Autheo DevHub**
GitHub Action defined in this repository's [`action.yml`](../action.yml).

## Quick start

1. In DevHub, create an API key (DevHub → API keys, `shadw_…`).
2. In the app repository, add it as the secret `DEVHUB_TOKEN`.
3. Add [`devhub.yml`](../examples/devhub.yml) and
   [`.github/workflows/devhub.yml`](../examples/github-workflow-devhub.yml).

```yaml
- uses: actions/checkout@v4
- uses: ThothDivision/L0_devhub_deploy@main
  with:
    token: ${{ secrets.DEVHUB_TOKEN }}
```

The repository must be clonable by DevHub (public, or connected through the
DevHub GitHub integration): the action asks DevHub to build the exact commit,
it does not upload the workspace.

## Format (v1)

| Key | Type | Maps to `POST /v1/git/deploy` |
| --- | --- | --- |
| `version` | `1` (required) | — |
| `project` | DNS label | `project` |
| `root_dir` | relative path | `root_dir` |
| `branch` | string | `branch` (default: triggering branch; when set, the branch tip is built instead of the triggering commit) |
| `target` | `auto` \| `production` \| `preview` | `target` (`auto` omits it; pull requests become `preview`) |
| `build.cache` | bool | `use_cache` |
| `env` | map of scalars | `env` (runtime-only; merged with the action `env` input, input wins) |
| `deploy.wait` | bool | follow `GET /v1/builds/:id` until `ready`/`error` |
| `deploy.timeout_minutes` | 1–120 | wait budget |

Unknown keys are rejected. JSON Schema: [`schemas/devhub.schema.json`](../schemas/devhub.schema.json)
(add `# yaml-language-server: $schema=<raw url>` for editor validation).
Secrets never belong in `devhub.yml`; pass them through the action `env` input
from GitHub secrets — values are masked in logs and the printed request.

## Action inputs / outputs

Inputs: `token` (required), `api-url` (default `https://dev.autheo.com/cloud` —
the hosted DevHub serves its API under `/cloud`), `team`, `config`, `project`,
`target`, `env`, `wait`, `dry-run`. Outputs: `build-id`, `project`, `state`, `url`.

## Making it appear in GitHub

- **Marketplace / "uses:"** — the root `action.yml` (with `branding`) is what
  GitHub recognises as an action. Publishing to the Marketplace is a manual
  step on a GitHub release (tick "Publish this Action to the GitHub Marketplace").
  Tag releases (`v1`) so users can pin `@v1` instead of `@main`.
- **Actions tab "New workflow" suggestion** — GitHub only reads starter
  workflows from an organisation's `.github` repository. Copy
  [`workflow-templates/`](../workflow-templates) into
  `ThothDivision/.github/workflow-templates/` to have "Deploy to Autheo DevHub"
  offered to every repo in the org (suggested when a repo contains
  `devhub.yml`, `package.json` or `vercel.json`).

## Test

```bash
python3 scripts/devhub-action/test_deploy.py -v
DEVHUB_REPO_URL=https://github.com/acme/app DEVHUB_CONFIG=examples/devhub.yml \\
  DEVHUB_DRY_RUN=true python3 scripts/devhub-action/deploy.py
```
