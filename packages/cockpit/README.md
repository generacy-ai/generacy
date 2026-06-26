# @generacy-ai/cockpit

Foundation library for the Generacy **Epic Cockpit** — a set of pure,
testable primitives any cockpit consumer (UI, CLI, or service) can import
without depending on the orchestrator runtime.

This package is the foundation issue (#786) for the Epic Cockpit work; UI and
CLI surfaces ship in later G0.x issues.

## What's inside

- A curated `CockpitState` union (`pending | active | waiting | error |
  terminal | unknown`) and a pure `classify(labels)` function that returns a
  single `{ state, sourceLabel }` summary for any GitHub issue's label set.
- The precedence rule the cockpit renders by — `terminal > error > waiting >
  active > pending` — with documented tie-breaks (pipeline order inside
  `waiting`, `WORKFLOW_LABELS` index everywhere else).
- A Zod-validated `cockpit:` config block read from `.generacy/config.yaml`,
  with a `MONITORED_REPOS` env-var fallback and warn-on-empty (not throw)
  behaviour.
- Epic-manifest read / append / atomic-write helpers + a
  `resolveEpicIssues(epic, owner, repo)` resolver that scans
  `.generacy/epics/*.yaml` first and falls back to the `epic-child` label
  graph via `gh search`.
- A thin, testable `gh` CLI wrapper (list issues, mutate labels, read PR
  check runs) with an injectable `CommandRunner` so unit tests never spawn
  real processes.
- A two-mode orchestrator client built on `node:http` / `node:https`. With
  a token, it issues `GET /health`, `GET /queue`, `GET
  /dispatch/queue/workers`. Without a token, it returns a stub whose every
  method resolves to `{ available: false, reason: 'no-token' }`. The live
  client never throws — HTTP errors map to `{ reason: 'http-error',
  statusCode }`, network errors to `{ reason: 'cloud-unreachable' }`.

## Install

```bash
pnpm add @generacy-ai/cockpit
```

ESM only, Node ≥ 22.

## Usage

### Classify a GitHub issue's labels

```ts
import { classify } from '@generacy-ai/cockpit';

const { state, sourceLabel } = classify([
  'phase:plan',
  'waiting-for:plan-review',
]);
// → { state: 'waiting', sourceLabel: 'waiting-for:plan-review' }
```

### Load the cockpit config block

```ts
import { loadCockpitConfig } from '@generacy-ai/cockpit';

const { config, source, warnings } = await loadCockpitConfig();
// config.owner, config.repos, config.orchestrator.{baseUrl, token}
// source: 'cockpit-block' | 'monitored-repos-env' | 'defaults'
```

The loader is non-throwing on the *absent-config* path — it logs a warning
and returns an empty `repos: []`. It throws on **malformed** YAML or
schema-invalid input.

### Resolve the children of an epic

```ts
import { resolveEpicIssues } from '@generacy-ai/cockpit';

const childIssueNumbers = await resolveEpicIssues(
  786,
  'generacy-ai',
  'generacy',
);
```

Reads `.generacy/epics/*.yaml` first; falls back to two `gh search` queries
(label + body reference) and merges the results.

### Talk to a running orchestrator

```ts
import { createOrchestratorClient } from '@generacy-ai/cockpit';

const client = createOrchestratorClient({
  baseUrl: 'http://127.0.0.1:3100',
  token: process.env.ORCHESTRATOR_API_TOKEN, // when undefined → stub
});

if (client.isAvailable()) {
  const jobs = await client.getJobs();
  if (jobs.available) {
    for (const job of jobs.jobs) console.log(job.id, job.status);
  }
}
```

## Config schema (`.generacy/config.yaml`)

```yaml
cockpit:
  owner: alice                                 # optional; defaults to `gh auth status` login
  repos:                                       # optional; falls back to MONITORED_REPOS env
    - generacy-ai/generacy
    - generacy-ai/generacy-extension
  orchestrator:                                # optional
    baseUrl: http://127.0.0.1:3100             # optional; falls back to ORCHESTRATOR_URL env
    token: ********                            # optional; falls back to ORCHESTRATOR_API_TOKEN env
```

### Environment variables

| Variable                  | Effect                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| `MONITORED_REPOS`         | Comma-separated `owner/repo` list used when `cockpit.repos` empty |
| `ORCHESTRATOR_URL`        | Used when `cockpit.orchestrator.baseUrl` not set                  |
| `ORCHESTRATOR_API_TOKEN`  | Used when `cockpit.orchestrator.token` not set                    |

## Degraded mode

The orchestrator client is designed to degrade silently:

- No token (config or env)? `createOrchestratorClient` returns a stub. Every
  method resolves to `{ available: false, reason: 'no-token' }`. No HTTP
  calls are made.
- Token present but the orchestrator is unreachable? The live client returns
  `{ available: false, reason: 'cloud-unreachable' }`.
- Token present but the orchestrator returns 5xx / 4xx? The live client
  returns `{ available: false, reason: 'http-error', statusCode }`.

The live client never throws — all error paths surface as result envelopes
so callers can render a degraded UI without try/catch noise.

## References

- Spec: [`specs/786-epic-generacy-ai-tetrad/spec.md`](../../specs/786-epic-generacy-ai-tetrad/spec.md)
- Plan: [`specs/786-epic-generacy-ai-tetrad/plan.md`](../../specs/786-epic-generacy-ai-tetrad/plan.md)
- Data model: [`specs/786-epic-generacy-ai-tetrad/data-model.md`](../../specs/786-epic-generacy-ai-tetrad/data-model.md)
- Contracts: [`specs/786-epic-generacy-ai-tetrad/contracts/`](../../specs/786-epic-generacy-ai-tetrad/contracts/)
