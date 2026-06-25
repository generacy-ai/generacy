# Quickstart: `@generacy-ai/cockpit`

## Install

Inside the monorepo, the package lands at `packages/cockpit/`. Other monorepo packages depend on it via:

```jsonc
// packages/<consumer>/package.json
"dependencies": {
  "@generacy-ai/cockpit": "workspace:*"
}
```

Then:

```bash
pnpm install
pnpm --filter @generacy-ai/cockpit build
```

## Configure

Add a `cockpit:` block to your project's `.generacy/config.yaml`:

```yaml
cockpit:
  owner: generacy-ai                          # optional; falls back to `gh auth status`
  repos:
    - generacy-ai/generacy
    - generacy-ai/tetrad-development
  orchestrator:
    baseUrl: http://127.0.0.1:3100            # optional; defaults shown
    token: ${ORCHESTRATOR_API_TOKEN}          # optional; absence ⇒ degraded mode
```

Or skip the block entirely and set `MONITORED_REPOS=generacy-ai/generacy,generacy-ai/agency` in your environment. With neither set, the cockpit loads in read-only mode and logs a warning.

## Usage

### Classify issue labels

```ts
import { classify } from '@generacy-ai/cockpit';

const issueLabels = new Set(['phase:implement', 'waiting-for:plan-review']);
const result = classify(issueLabels);

// result = { state: 'waiting', sourceLabel: 'waiting-for:plan-review' }
```

### Load config

```ts
import { loadCockpitConfig } from '@generacy-ai/cockpit';

const { config, source, warnings } = await loadCockpitConfig();

console.log(config.repos);   // ['generacy-ai/generacy', ...]
console.log(source);          // 'cockpit-block' | 'monitored-repos-env' | 'defaults'
warnings.forEach(console.warn);
```

### Resolve an epic's child issues

```ts
import { resolveEpicIssues } from '@generacy-ai/cockpit';

const children = await resolveEpicIssues(786, 'generacy-ai', 'generacy');
// children = [787, 788, 789, ...]
```

Resolution order: manifest at `.generacy/epics/<slug>.yaml` first, then `gh` query for `epic-child` / body references.

### Append a child issue to an epic manifest

```ts
import { appendChildIssue } from '@generacy-ai/cockpit';

await appendChildIssue(
  '.generacy/epics/epic-cockpit.yaml',
  'foundation',
  'generacy-ai/generacy#787',
);
```

Idempotent; atomic write via `<path>.tmp` + `rename()`.

### Talk to the orchestrator (or degrade gracefully)

```ts
import { createOrchestratorClient } from '@generacy-ai/cockpit';

const client = createOrchestratorClient({
  baseUrl: 'http://127.0.0.1:3100',
  token: process.env.ORCHESTRATOR_API_TOKEN,   // may be undefined
});

if (client.isAvailable()) {
  const health = await client.health();
  // health = { available: true, status: 'ok', data: {...} }
} else {
  // No token configured; every method resolves to { available: false, reason: 'no-token' }
  const jobs = await client.getJobs();
  console.log(jobs.available);   // false
}
```

### Use the `gh` wrapper

```ts
import { GhCliWrapper } from '@generacy-ai/cockpit';

const gh = new GhCliWrapper();

const issues = await gh.listIssues('repo:generacy-ai/generacy is:issue is:open label:type:epic');
const checkRuns = await gh.getPullRequestCheckRuns('generacy-ai/generacy', 786);
await gh.addLabels('generacy-ai/generacy', 786, ['waiting-for:plan-review']);
```

The wrapper assumes `gh` is installed and authenticated in the calling environment (matches the rest of the monorepo's tooling expectations).

## Available exports

See `data-model.md` § "Public API surface" for the full list. At a glance:

- `classify`, `COCKPIT_STATES`, `TIER_RANK`, `WAITING_PIPELINE_ORDER`
- `loadCockpitConfig`, `CockpitConfigSchema`
- `readManifest`, `writeManifest`, `appendChildIssue`, `resolveEpicIssues`, `EpicManifestSchema`
- `GhCliWrapper`
- `createOrchestratorClient`, `OrchestratorClient`

## Run the tests

```bash
pnpm --filter @generacy-ai/cockpit test
```

Vitest under `src/__tests__/`. No live network, no real `gh` calls — all I/O is behind injected adapters.

## Troubleshooting

| Symptom                                                                 | Likely cause                                                                                | Fix                                                                                       |
|-------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `loadCockpitConfig()` warns "no repos configured" and returns `[]`      | Neither `cockpit.repos` nor `MONITORED_REPOS` is set.                                       | Set one. Read-only consumers can ignore.                                                  |
| Thrown Zod error mentioning `'must be owner/repo'`                       | An entry in `cockpit.repos` or `MONITORED_REPOS` doesn't have the `<owner>/<repo>` form.    | Fix the entry.                                                                            |
| `client.isAvailable() === false` unexpectedly                            | `ORCHESTRATOR_API_TOKEN` not set, or `cockpit.orchestrator.token` is empty.                 | Set the token. Or accept degraded mode if intentional.                                    |
| `resolveEpicIssues()` returns `[]` for an epic that has children         | No manifest at `.generacy/epics/<slug>.yaml` AND `gh` query found nothing.                  | Either commit a manifest or label the children with `epic-child` referencing the epic.    |
| `GhCliWrapper` throws `ENOENT`                                          | `gh` binary not on PATH.                                                                    | Install GitHub CLI (`brew install gh` / equivalent) and `gh auth login`.                  |
| Classifier returns `{ state: 'unknown', sourceLabel: '' }` for an issue | None of the issue's labels appear in `WORKFLOW_LABELS`.                                     | Expected. Render the `unknown` state appropriately, or sync the catalog from upstream.   |

## Next steps

This package is foundation only. Downstream G0.x issues build on it:

- Cockpit CLI subcommands (`generacy cockpit status`, etc.) consume `loadCockpitConfig` + `classify` + `resolveEpicIssues`.
- Cockpit UI (in `generacy-extension` or web) consumes `OrchestratorClient` for live job/worker state.
- The G5.1 orchestrator-status tier expands the `OrchestratorClient` method surface.
