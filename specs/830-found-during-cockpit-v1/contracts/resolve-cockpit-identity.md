# Contract: `resolveCockpitIdentity`

**Module**: `packages/generacy/src/cli/commands/cockpit/shared/identity.ts`
**Callers**: `packages/generacy/src/cli/commands/cockpit/queue.ts`, `packages/generacy/src/cli/commands/cockpit/advance.ts`
**Behavioral parity target**: `packages/orchestrator/src/services/identity.ts` (SC-006)

## Signature

```ts
export async function resolveCockpitIdentity(
  input: ResolveCockpitIdentityInput,
): Promise<ResolveCockpitIdentityResult>;

export interface ResolveCockpitIdentityInput {
  flag?: string;
  configAssignee?: string;
  gh: Pick<GhWrapper, 'getCurrentUser'>;
  logger: { warn(msg: string): void; info?(msg: string): void };
  verb: string;                        // 'cockpit queue' | 'cockpit advance'
  mode: 'required' | 'optional';
  env?: NodeJS.ProcessEnv;             // default: process.env
}

export type ResolveCockpitIdentityResult =
  | { login: string; source: 'flag' | 'config' | 'CLUSTER_GITHUB_USERNAME' | 'GH_USERNAME' | 'gh-api' }
  | { login: undefined; source: 'none' };

export class LoudIdentityError extends Error {
  readonly code: 'IDENTITY_UNRESOLVED';
  readonly verb: string;
  constructor(verb: string, message: string);
}
```

## Precedence (canonical — matches `orchestrator/services/identity.ts`)

Evaluated in order; first non-null / non-empty / non-throwing tier wins.

| Tier | Source | Reads from |
|---:|---|---|
| 1a | `flag` | `--assignee <login>` CLI flag (already validated by `LOGIN_REGEX` in `queue.ts:212`) |
| 1b | `configAssignee` | `cockpit.assignee` in `.generacy/config.yaml` (via `loadCockpitConfig`) |
| 2a | `env.CLUSTER_GITHUB_USERNAME` | `process.env.CLUSTER_GITHUB_USERNAME` |
| 2b | `env.GH_USERNAME` | `process.env.GH_USERNAME` |
| 3 | `gh.getCurrentUser()` | `gh api user` via `GhWrapper` |

Tier semantics **must** mirror `services/identity.ts` exactly. SC-006 asserts this via a table copied from that file.

## Failure Modes

### `mode: 'required'` — all tiers miss / fail

Throws `LoudIdentityError(verb, MESSAGE)` where MESSAGE is:

```
cockpit <verb>: unable to resolve GitHub identity.
Set one of the following:
  --assignee <login>                        (flag, per-invocation)
  cockpit.assignee in .generacy/config.yaml (per-repo)
  CLUSTER_GITHUB_USERNAME                   (env, cluster-wide)
  GH_USERNAME                               (env, cluster-wide)
Or authenticate `gh` for a user-token (gh auth login) so `gh api user` can resolve.
```

- MUST name **all four** knobs: `--assignee`, `cockpit.assignee`, `CLUSTER_GITHUB_USERNAME`, `GH_USERNAME` (SC-004, Q1→A).
- MUST include the verb name so the wrapper in `queue.ts` doesn't have to reconstruct context.
- MUST NOT include the underlying `gh api user` HTTP-status detail (403 / 401 / other) as a primary hint — the four knobs are the actionable fix.

### `mode: 'optional'` — all tiers miss / fail

- Calls `logger.warn(MESSAGE)` with the same MESSAGE prefixed by `warning: `.
- Returns `{ login: undefined, source: 'none' }`.
- MUST NOT throw.

## Success Behavior

- Returns `{ login: <resolved>, source: <tier-name> }`.
- MAY call `logger.info?.(...)` on tiers 1a/1b/2a/2b/3 to record which source resolved (parity with `services/identity.ts` line 41–44). Not required for correctness.
- Tier 3 (`gh api user`) MUST swallow `gh` errors up to the point of falling through to the failure branch — the individual error string is not surfaced. On `mode: 'optional'`, tier-3 failure emits an info-level log with the underlying error text so debugging isn't lost; the warn call at the end names the four knobs.

## Idempotency & Side Effects

- Pure function on tiers 1a, 1b, 2a, 2b (only env / arg reads).
- Tier 3 spawns a `gh` subprocess via `GhWrapper.getCurrentUser()` at most once per call. No caching.
- Tier 3 has a 10s timeout (inherited from `GhWrapper.getCurrentUser()`'s existing behavior — not extended here).

## Non-Requirements

- No retry on tier 3 failure.
- No async env re-read (env is snapshotted at helper entry).
- No cache across invocations. Each command invocation runs the resolver fresh — cheap and predictable.

## Test Requirements (FR-005, SC-006)

### Table-driven precedence cases (SC-006 — copied from `services/identity.ts`)

| Case | flag | configAssignee | CLUSTER_GITHUB_USERNAME | GH_USERNAME | gh api | Expected source | Expected login |
|---|---|---|---|---|---|---|---|
| flag beats all | `alice` | `bob` | `charlie` | `dave` | `eve` | `flag` | `alice` |
| config beats env | — | `bob` | `charlie` | `dave` | `eve` | `config` | `bob` |
| CLUSTER_GITHUB_USERNAME beats GH_USERNAME | — | — | `charlie` | `dave` | `eve` | `CLUSTER_GITHUB_USERNAME` | `charlie` |
| GH_USERNAME beats gh-api | — | — | — | `dave` | `eve` | `GH_USERNAME` | `dave` |
| gh-api resolves | — | — | — | — | `eve` | `gh-api` | `eve` |
| all miss, mode required | — | — | — | — | `throw` | `<throws LoudIdentityError>` | — |
| all miss, mode optional | — | — | — | — | `throw` | `none` | `undefined` |

### Failure-message cases (SC-004)

- Required-mode message contains substrings: `--assignee`, `cockpit.assignee`, `CLUSTER_GITHUB_USERNAME`, `GH_USERNAME`.
- Optional-mode warn call receives a message containing the same four substrings.

## Non-Cockpit Callers

None. This helper is cockpit-scoped. Non-cockpit CLI subcommands that call `gh api user` are Out of Scope for this fix.
