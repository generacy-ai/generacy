# Research: Cockpit CLI identity resolution

## Decision 1 — Mirror `orchestrator/services/identity.ts` precedence exactly

**Chosen**: (1a) `--assignee` flag → (1b) `cockpit.assignee` config → (2a) `CLUSTER_GITHUB_USERNAME` → (2b) `GH_USERNAME` → (3) `gh api user`.

**Rationale**: Clarification Q1→A. Two identity resolvers with subtly different precedence is a guaranteed future drift bug — the whole point of this fix is that the cockpit CLI diverged from a chain the orchestrator already got right. Behavioral identity is verifiable via SC-006 (table copied from `identity.ts`); duplication is a temporary state until the shared-package extraction (documented Out of Scope) lands as a follow-up.

**Alternatives considered**:
- **Only `CLUSTER_GITHUB_USERNAME` (drop `GH_USERNAME` from cockpit).** Rejected — creates the exact drift Q1 called out. An operator who sets `GH_USERNAME` (documented on the orchestrator side) reasonably expects it to work in cockpit too.
- **Extract to shared package now.** Out of Scope per spec. Behavioral identity is sufficient for this PR; the extraction is a follow-up.

**Reference**: `packages/orchestrator/src/services/identity.ts` lines 39–63 (config, GH_USERNAME, gh-api-fallback tiers).

## Decision 2 — Add `cockpit.assignee` to `CockpitConfigSchema` in this PR

**Chosen**: Field + reader land together. `assignee: z.string().min(1).optional()` on `CockpitConfigSchema`; helper reads `LoadedCockpitConfig.config.assignee` in tier 1b.

**Rationale**: Clarification Q2→A. The key was documented in the rev 3 cockpit plan (`docs/epic-cockpit-plan.md` in tetrad-development) as one of the three optional cockpit keys — it was simply never implemented. Adding the reader without the field, or the field without the reader, is dead surface. Loader already round-trips the whole `cockpit:` block through the schema (`config/loader.ts` line 70), so extending it is a single-line change to `schema.ts`.

**Alternatives considered**:
- **Drop config from tier 1 entirely.** Rejected — leaves an unwired option that the docs already reference, and forces operators to shell-export `CLUSTER_GITHUB_USERNAME` when a per-repo pin would be cleaner.
- **Add an unused `configAssignee` parameter to the helper.** Rejected — dead surface (Q2→A rationale).

**Reference**: `packages/cockpit/src/config/schema.ts` (existing `owner` field is the pattern to mirror).

## Decision 3 — Flag beats config within tier 1

**Chosen**: When both `--assignee <login>` and `cockpit.assignee` are set, the flag wins. Order within tier 1: (1a) flag → (1b) config.

**Rationale**: Clarification Q3→A. Standard CLI convention — explicit invocation overrides persistent config — and it keeps the whole chain monotonic in explicitness: flag → config → CLUSTER_GITHUB_USERNAME → GH_USERNAME → gh api user. A flag's entire purpose is to override defaults for one invocation; erroring on "conflict" punishes the normal use case.

**Alternatives considered**:
- **Config wins.** Rejected — makes `--assignee` a lie: an operator's explicit override doesn't override.
- **Error on conflict.** Rejected — punishes the normal use case (temporary one-shot override).

## Decision 4 — Two helper modes: `'required'` and `'optional'`

**Chosen**: Single helper, `mode` parameter selects the failure semantics. `'required'` throws `LoudIdentityError` naming all four knobs; `'optional'` logs a warning (naming the same four knobs) and returns `undefined`.

**Rationale**: Queue depends on the assignee for triage output (FR-002) — degrading silently would hide misconfiguration. Advance's actor is cosmetic (FR-003) — blocking a gate transition on cosmetic attribution punishes the operator for a wizard-flow misconfiguration they may not own. Single helper with two modes keeps precedence in exactly one place (SC-003 grep guard); two helpers would risk drift.

**Alternatives considered**:
- **Two separate helpers (`resolveRequired` / `resolveOptional`).** Rejected — precedence duplication across two functions defeats the "one source of truth" goal (US3).
- **Helper always throws; callers catch.** Rejected — makes the caller responsible for reconstructing the "same four knobs" error message, which is exactly the anti-pattern SC-004 targets.

## Decision 5 — Optional `actor` field in `formatManualAdvanceComment`

**Chosen**: `formatManualAdvanceComment({ gate, actor?: string, ts })`: when `actor` is `undefined` or empty, omit the `actor:` line entirely (no `actor: unknown` or `actor:` empty-string placeholder).

**Rationale**: FR-003 explicit — "omit the 'actor:' line rather than throwing". An `unknown` placeholder is worse than absence because it commits a claim that's obviously false. Absence signals the environment couldn't attribute; a placeholder signals the tool did something wrong.

**Alternatives considered**:
- **`actor: unknown` fallback string.** Rejected — commits a false claim.
- **`actor: system` or `actor: cluster`.** Rejected — misleading; the acting principal is the operator, whose identity is genuinely unknown at that moment.

## Decision 6 — FR-006 investigation posted as a comment on issue #830

**Chosen**: The FR-006 (P2) finding — whether the smee-receiver's no-assignee skip path aligns with `webhooks.ts`'s guard — is posted as a comment on GitHub issue #830, tagged `"FR-006 investigation"`. Both branches ("no divergence" and "divergence + follow-up filed") land as a comment.

**Rationale**: Clarification Q4→B. That's where the bug's audience looks, it survives branch deletion, and it's greppable from the issue that motivated the check. Feature-branch `specs/` files are an information-placement anti-pattern this epic has been deleting.

**Alternatives considered**:
- **A dedicated `fr-006-notes.md` under the spec dir.** Rejected — authoritative findings in feature-branch spec files is the exact anti-pattern being retired.
- **Append to spec Assumptions.** Rejected — spec.md is read-only during plan phase and post-merge; assumption-shift belongs on the ticket, not in the spec.
- **A follow-up issue in every case, even "no divergence".** Rejected — issue whose content is "verified, no action needed" is process noise.

## Decision 7 — Where the helper lives: `packages/generacy/src/cli/commands/cockpit/shared/identity.ts`

**Chosen**: New file under the existing `cockpit/shared/` directory (alongside `classify-issue.ts`, `pagination.ts`, `pr-link.ts`, `required-checks.ts`, `review-context-json.ts`, `failing-check-json.ts`).

**Rationale**: `shared/` is already the co-located home for cockpit-scoped helpers. Keeping the helper in the generacy CLI package (not the shared `@generacy-ai/cockpit` library) avoids adding a `node:child_process` execFile dependency to the pure library — the tier-3 fallback goes through `GhWrapper.getCurrentUser()`, which is injectable and testable without a subprocess.

**Alternatives considered**:
- **`@generacy-ai/cockpit` (shared library).** Rejected — Out of Scope per spec. Also: the shared library today has no `services/` or `identity/` folder; adding one for a helper only cockpit CLI uses is premature.
- **`packages/generacy/src/cli/utils/`.** Rejected — the helper is cockpit-scoped (reads `CockpitConfig`); belongs with other cockpit-only helpers, not generic CLI utils.

## Implementation Patterns

### Precedence table shape (for tests, per SC-006)

```ts
type Case = {
  name: string;
  flag?: string;
  configAssignee?: string;
  env: { CLUSTER_GITHUB_USERNAME?: string; GH_USERNAME?: string };
  ghApiUserResult: string | Error;
  expected: { value: string | undefined; source: 'flag' | 'config' | 'CLUSTER_GITHUB_USERNAME' | 'GH_USERNAME' | 'gh-api' | 'none' };
};
```

The `'none'` source case exercises the required/optional divergence: in required mode expected is a thrown `LoudIdentityError`; in optional mode expected is `undefined` and a warn log.

### Error message shape (SC-004)

```
cockpit <verb>: unable to resolve GitHub identity.
Set one of the following:
  --assignee <login>                        (flag, per-invocation)
  cockpit.assignee in .generacy/config.yaml (per-repo)
  CLUSTER_GITHUB_USERNAME                   (env, cluster-wide)
  GH_USERNAME                               (env, cluster-wide)
Or authenticate `gh` for a user-token (gh auth login) so `gh api user` can resolve.
```

Warning shape (optional mode) is the same body prefixed with `warning: ` and demoted from thrown to logged.

### Logger injection

`resolveCockpitIdentity` takes a minimal `{ warn(msg: string): void }` logger. Callers pass `getLogger()` from `packages/generacy/src/cli/utils/logger.ts`. Tests pass a capture logger to assert on the warn call.

## References

- **Spec**: `specs/830-found-during-cockpit-v1/spec.md`
- **Clarifications**: `specs/830-found-during-cockpit-v1/clarifications.md`
- **Behavioral source of truth**: `packages/orchestrator/src/services/identity.ts` (lines 39–63)
- **Current failure sites**: `packages/generacy/src/cli/commands/cockpit/queue.ts:297–309`, `packages/generacy/src/cli/commands/cockpit/advance.ts:135–141`
- **Config schema**: `packages/cockpit/src/config/schema.ts`
- **Marker formatter**: `packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts`
- **Upstream issue**: [generacy-ai/generacy#830](https://github.com/generacy-ai/generacy/issues/830)
