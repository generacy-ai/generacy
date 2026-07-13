# @generacy-ai/cockpit

Foundation library for the Generacy **Epic Cockpit** — a set of pure,
testable primitives any cockpit consumer (UI, CLI, or service) can import.

## What's inside

- A curated `CockpitState` union (`pending | active | waiting | error |
  terminal | unknown`) and a pure `classify(labels)` function that returns a
  single `{ state, sourceLabel }` summary for any GitHub issue's label set.
- The precedence rule the cockpit renders by — `terminal > error > waiting >
  active > pending` — with documented tie-breaks (pipeline order inside
  `waiting`, `WORKFLOW_LABELS` index everywhere else).
- A Zod-validated `cockpit:` config block read from `.generacy/config.yaml`
  (just an optional `owner` — `gh auth status` login is the fallback).
- The single-source epic resolver: `parseEpicBody()`, `resolveEpic()`,
  `matchPhaseHeading()`. Reads the epic issue body — task-list refs
  (`- [ ]` / `- [x]`) grouped under `### <phase>` headings — and returns
  a deduped ref set. Fails loud when the body has no headings or no refs.
- A thin, testable `gh` CLI wrapper (list issues, get one issue, mutate
  labels, read PR check runs) with an injectable `CommandRunner` so unit
  tests never spawn real processes.

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

const { config, source } = await loadCockpitConfig();
// config.owner — from cockpit.owner in .generacy/config.yaml,
//                or `gh auth status` login when unset.
// source: 'cockpit-block' | 'defaults'
```

### Resolve the children of an epic from the issue body

```ts
import { resolveEpic, GhCliWrapper } from '@generacy-ai/cockpit';

const resolved = await resolveEpic({
  epicRef: 'owner/repo#42',
  gh: new GhCliWrapper(),
});
// resolved.parsed.phases   — every `### <phase>` heading and its refs
// resolved.parsed.allRefs  — deduped union, sorted by (repo, number)
// resolved.repos           — the unique repo set covered by the epic
```

Fails loud (`LoudResolverError`) on an unparseable body — no manifest
file, no label-search fallback, no silent drops.

## Config schema (`.generacy/config.yaml`)

```yaml
cockpit:
  owner: alice   # optional; defaults to `gh auth status` login
```

## References

- Spec: [`specs/806-epic-generacy-ai-tetrad/spec.md`](../../specs/806-epic-generacy-ai-tetrad/spec.md)
- Plan: [`specs/806-epic-generacy-ai-tetrad/plan.md`](../../specs/806-epic-generacy-ai-tetrad/plan.md)
- Resolver contract: [`specs/806-epic-generacy-ai-tetrad/contracts/resolver.md`](../../specs/806-epic-generacy-ai-tetrad/contracts/resolver.md)
- CLI contract: [`specs/806-epic-generacy-ai-tetrad/contracts/cli.md`](../../specs/806-epic-generacy-ai-tetrad/contracts/cli.md)
