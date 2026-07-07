# Data Model: Cockpit CLI identity resolution

Two new/modified types, one existing type edited. This is a bug-fix PR — no domain-model changes, only interface deltas.

## New: `LoudIdentityError` (helper failure envelope)

```ts
export class LoudIdentityError extends Error {
  readonly code: 'IDENTITY_UNRESOLVED';
  readonly verb: string; // e.g. 'cockpit queue'
  constructor(verb: string, message: string) {
    super(message);
    this.name = 'LoudIdentityError';
    this.code = 'IDENTITY_UNRESOLVED';
    this.verb = verb;
  }
}
```

**Purpose**: Distinguishes the "no source resolved" failure from generic `Error`s so `queue.ts` can wrap it with a `CockpitExit(1, ...)` and pass the shaped message through unmodified. Callers do not need to reconstruct the four-knob string.

**Location**: `packages/generacy/src/cli/commands/cockpit/shared/identity.ts`

## New: `ResolveCockpitIdentityInput`

```ts
export interface ResolveCockpitIdentityInput {
  /** Value of the CLI `--assignee` flag, if provided. Tier 1a. */
  flag?: string;
  /** Value of `cockpit.assignee` from .generacy/config.yaml, if set. Tier 1b. */
  configAssignee?: string;
  /** GhWrapper for the tier-3 `gh api user` fallback. */
  gh: Pick<GhWrapper, 'getCurrentUser'>;
  /** Logger for the optional-mode warning and any diagnostic notes. */
  logger: { warn(msg: string): void; info?(msg: string): void };
  /** Verb name for error prefixing — e.g. `'cockpit queue'`, `'cockpit advance'`. */
  verb: string;
  /**
   * Failure semantics.
   *  - 'required': throws LoudIdentityError when all sources fail.
   *  - 'optional': logs a warning and returns undefined when all sources fail.
   */
  mode: 'required' | 'optional';
  /**
   * Env accessor. Defaults to `process.env`. Test-injected in unit tests.
   */
  env?: NodeJS.ProcessEnv;
}
```

**Purpose**: Explicit input shape; injectable env + gh + logger so unit tests exercise all five precedence tiers without spawning subprocesses.

## New: `ResolveCockpitIdentityResult`

```ts
export type ResolveCockpitIdentityResult =
  | { login: string; source: IdentitySource }
  | { login: undefined; source: 'none' };

export type IdentitySource =
  | 'flag'
  | 'config'
  | 'CLUSTER_GITHUB_USERNAME'
  | 'GH_USERNAME'
  | 'gh-api'
  | 'none';
```

**Purpose**: In `'required'` mode the resolver either throws or returns `{ login, source }` where `source !== 'none'`. In `'optional'` mode, `source === 'none'` is a legal return: caller reads `login === undefined` and degrades. Explicit `source` on the return is what tests assert against (SC-006).

## Modified: `CockpitConfigSchema` (in `@generacy-ai/cockpit`)

```ts
// packages/cockpit/src/config/schema.ts
export const CockpitConfigSchema = z.object({
  owner: z.string().min(1).optional(),
  assignee: z.string().min(1).optional(),  // ← NEW: FR-007, Q2→A
});
```

- **Validation**: `.min(1)` rejects the empty string (matches the pattern already used for `owner`). GitHub login format is intentionally not enforced here — the pattern check is the runtime concern of the resolver / helper, not the config schema. (Cockpit's `LOGIN_REGEX` at `queue.ts:31` covers the flag; helper trusts the config value since the operator committed it.)
- **Backwards compat**: Additive field. Existing `.generacy/config.yaml` files without `cockpit.assignee` continue to parse; `LoadedCockpitConfig.config.assignee` is `undefined` in that case.
- **Loader**: `packages/cockpit/src/config/loader.ts` already parses the whole `cockpit:` block through the schema (line 70) — no loader change.
- **Public export**: `CockpitConfig` type gets `assignee?: string` via `z.infer<>` automatically. No manual re-export edit needed.

## Modified: `ManualAdvanceMarker` (formatter input)

```ts
// packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts
export interface ManualAdvanceMarker {
  gate: string;
  actor?: string;       // ← was `actor: string`, now optional
  ts: string;
}
```

- **Formatter behavior**:
  - `actor` present + valid → same output as today (`by **@<actor>**` sentence + `actor=<actor>` in the HTML comment).
  - `actor` `undefined` or `""` → the HTML comment omits `actor=` entirely, and the human-readable sentence becomes `Manually advanced \`waiting-for:<gate>\` → \`completed:<gate>\`.` (no `by …` clause).
- **Validation**: `ACTOR_REGEX` only runs when `actor` is a non-empty string. When `actor` is `undefined`, no validation error is thrown.
- **Backwards compat**: All existing callers pass `actor: string`; the only mutation is at `advance.ts:144` where the new resolver may return `undefined`. See contract in `contracts/manual-advance-marker.md`.

## Call Graph — Post-Fix

```
cockpit queue (packages/generacy/src/cli/commands/cockpit/queue.ts)
├── loadCockpitConfig(...)                                        (NEW call — reads .generacy/config.yaml cockpit block)
├── resolveIssueContext(...)                                      (unchanged)
├── cockpitGh.fetchIssueState(...)                                (unchanged)
├── resolveCockpitIdentity({                                      (NEW — replaces getCurrentUser at 297–309)
│     flag: opts.assignee,
│     configAssignee: config.assignee,
│     gh: cockpitGh,
│     logger: getLogger(),
│     verb: 'cockpit queue',
│     mode: 'required',
│   })
│   → login: string | throw LoudIdentityError
├── (uses login as assignee for renderPreview / applyMutations)
│
cockpit advance (packages/generacy/src/cli/commands/cockpit/advance.ts)
├── loadCockpitConfig(...)                                        (already called for other fields)
├── resolveCockpitIdentity({                                      (NEW — replaces getCurrentUser at 135–141)
│     flag: undefined,
│     configAssignee: config.assignee,
│     gh,
│     logger: getLogger(),
│     verb: 'cockpit advance',
│     mode: 'optional',
│   })
│   → { login: string | undefined }
├── formatManualAdvanceComment({ gate, actor: login, ts })        (actor now optional per marker delta)
├── gh.postIssueComment(...)                                      (unchanged; always runs)
├── gh.addLabel(...)                                              (unchanged; always runs — FR-003)
└── gh.removeLabel(...)                                           (unchanged; always runs)

resolveCockpitIdentity (packages/generacy/src/cli/commands/cockpit/shared/identity.ts)
├── if input.flag != null → return { login: flag, source: 'flag' }
├── if input.configAssignee != null → return { login: configAssignee, source: 'config' }
├── if env.CLUSTER_GITHUB_USERNAME != null → return { login: ..., source: 'CLUSTER_GITHUB_USERNAME' }
├── if env.GH_USERNAME != null → return { login: ..., source: 'GH_USERNAME' }
├── try input.gh.getCurrentUser() → return { login: ..., source: 'gh-api' }
│   catch → fall through
└── if mode === 'required' → throw LoudIdentityError(verb, FOUR_KNOB_MESSAGE)
    if mode === 'optional' → logger.warn(FOUR_KNOB_MESSAGE); return { login: undefined, source: 'none' }
```

## Relationships

- `CockpitConfigSchema.assignee` (new field) ⇄ `resolveCockpitIdentity({ configAssignee })`: field-and-reader ship together per Q2→A.
- `ManualAdvanceMarker.actor` (now optional) ⇄ `resolveCockpitIdentity` in `'optional'` mode: the marker's optionality is downstream of the resolver's ability to return `undefined`.
- `LoudIdentityError` ⇄ `CockpitExit(1, ...)` in `queue.ts`: the CLI wrapper catches the LoudIdentityError and re-throws as a `CockpitExit(1, err.message)`. Advance never throws (mode is optional).
- Behavioral source of truth: `packages/orchestrator/src/services/identity.ts` — the resolver's precedence table is a mechanical copy per SC-006.

## Validation Rules Summary

| Field / Input | Rule | Enforced Where |
|---|---|---|
| `CockpitConfigSchema.assignee` | `z.string().min(1).optional()` | Zod schema at parse time |
| `ResolveCockpitIdentityInput.flag` | Regex-checked upstream in `queue.ts:212` (LOGIN_REGEX) | Command action (not helper) |
| `ResolveCockpitIdentityInput.mode` | `'required' \| 'optional'` (TS type) | Compile time |
| `ManualAdvanceMarker.actor` | If present, must match `ACTOR_REGEX`; if `undefined`, allowed | `validate()` in `manual-advance-marker.ts` |
| `ManualAdvanceMarker.gate` | Must match `GATE_REGEX` | `validate()` (unchanged) |
| `ManualAdvanceMarker.ts` | Non-empty ISO-8601 that round-trips | `validate()` (unchanged) |
