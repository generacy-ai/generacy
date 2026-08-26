# Contract: `GhCliGitHubClient.getCiRunsForSha`

**Interface**: `packages/workflow-engine/src/actions/github/client/interface.ts`
**Impl**: `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (sole implementer)

## Signature

```ts
getCiRunsForSha(
  owner: string,
  repo: string,
  headSha: string,
  branch: string,
): Promise<{ runs: CiRun[]; source: 'check-runs' | 'actions-runs' }>;
```

## Primary path — check-runs

```
gh api repos/{owner}/{repo}/commits/{headSha}/check-runs \
  --jq '.check_runs[] | {status, conclusion}'
```
- On exit 0: normalize each `{ status, conclusion }` to `CiRun`, return `{ runs, source: 'check-runs' }`.

## Fallback path — actions/runs (FR-002)

Triggered when the primary path exits non-zero (the observed symptom of a token lacking `checks:read`).

```
gh api "repos/{owner}/{repo}/actions/runs?branch={branch}&per_page=100" \
  --jq '.workflow_runs[] | {head_sha, status, conclusion}'
```
- Filter to `head_sha === headSha`.
- Normalize to `CiRun`, return `{ runs, source: 'actions-runs' }`.

## Contract rules
- Both paths return `CiRun[]` consumable by `aggregateCiVerdict` **unchanged** — the verdict for a given real CI state MUST be identical across paths (SC-004).
- `conclusion` values outside the known `CiConclusion` union are passed through as-is (aggregation treats unknown terminal conclusions conservatively — not `success`, so not green).
- Empty result (no check-runs AND no matching actions/runs) → `{ runs: [], source }` → aggregation yields `pending` (Q3-A).
- Non-zero exit on **both** paths → throw with stderr (visibility), same style as `getRefHeadSha`. The caller's readiness wait treats a thrown readout as a transient and continues backoff until `ciWaitTimeoutMs`.
