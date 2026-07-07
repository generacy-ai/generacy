# Research: Cockpit CLI status/watch argument-contract drift

**Feature**: `822-found-during-cockpit-v1` | **Date**: 2026-07-07

## Decision 1 — Where does ref-resolution live?

**Decision**: Lift resolution up into the CLI verb layer. Each verb (`status`, `watch`, `queue`, plus the existing `context`) calls `resolveIssueContext(...)` first, then passes the expanded `owner/repo#N` string to the existing `resolveEpic()` in `@generacy-ai/cockpit`.

**Rationale**:
- Matches the spec's phrasing "same inference `context` uses" (spec §Fix, clarification Q1).
- Keeps `@generacy-ai/cockpit` pure — no filesystem/git-subprocess dependency in a shared library that today has none.
- Single ref-parsing entrypoint across all four verbs: `resolveIssueContext` in `packages/generacy/src/cli/commands/cockpit/resolver.ts`. Matches SC-003.
- The helper already exists (used by `cockpit context` since #807). No new code path — just add three call-sites.

**Alternatives considered**:
- **Push resolution down** into `resolveEpic()` (Q1→B). Rejected: introduces `git remote get-url origin` async subprocess into `@generacy-ai/cockpit`, converts a sync helper to async, and forces every downstream caller of `@generacy-ai/cockpit` (some of which don't have a meaningful cwd) to reason about that dependency.
- **Duplicate the inference in each verb** (Q1→C). Rejected: the S-chain (#803, #806, #807) just spent three issues deleting duplicated ref-parsing logic. Reintroducing a per-verb copy would be a regression.

**References**: clarification Q1 → A; spec §Fix; `packages/generacy/src/cli/commands/cockpit/resolver.ts:142` (`resolveIssueContext` signature).

---

## Decision 2 — Error surface for invalid refs

**Decision**: Reuse the existing `parse issue: <detailed reason>` shape emitted by `parseIssueRef` / `resolveIssueContext`. Verbs wrap it as `Error: cockpit <verb>: parse issue: <reason>` and exit 2. FR-007's "INVALID_EPIC_REF" names the *requirement* (loud + enumerate accepted forms), not a mandatory error-code string. Extend the message's listed forms to include the bare number.

**Rationale**:
- Falls out naturally from Decision 1 — `resolveIssueContext` already emits this shape.
- Single error mechanism across all four verbs (`status`, `watch`, `queue`, `context`) — matches SC-003.
- Exit 2 preserves the current behavior for `INVALID_EPIC_REF`-class failures on `status`/`context` today.
- Extending the enumerated forms list (`resolver.ts:106-108`) to include the bare number is one-line surgery.

**Alternatives considered**:
- **Extend `LoudResolverError` to carry a message body** and emit `INVALID_EPIC_REF` as the error code (Q3→A). Rejected: adds a second error-carrier for the same class of failure; splits which mechanism fires depending on where in the resolver chain the failure happens; more code surface for the same user-visible outcome.
- **New format** (Q3→C). Rejected: no rationale to invent one — B satisfies FR-007.

**References**: clarification Q3 → B; `packages/generacy/src/cli/commands/cockpit/resolver.ts:54-56` (`fail()`), `resolver.ts:99-104` (bare-number rejection message).

---

## Decision 3 — Does `queue` also migrate to `resolveIssueContext`?

**Decision**: Yes. `queue` also routes through `resolveIssueContext` internally. Its CLI argument surface (positional `<epic-ref> <phase>`) stays byte-identical.

**Rationale**:
- US2 requires "single grammar across all three" — `queue 1 <phase>` must resolve the same way `status 1` does.
- A smoke tester who ran `status 1` will type `queue 1 <phase>` next; having the third verb reject the bare number would be this same bug refiled.
- FR-009's "unchanged" refers to the *argument surface*, not the internal parser call (Q4→A).
- The migration is trivial — one extra `resolveIssueContext` call before the existing `resolveEpic({ epicRef, gh })` at `queue.ts:222-229`.

**Alternatives considered**:
- **Keep `queue` on the old code path** (Q4→B). Rejected: US2 would degrade to "single grammar for `status`/`watch` only", and the smoke test regression is trivially predictable.

**References**: clarification Q4 → A; spec US3, FR-009.

---

## Decision 4 — `--repo` override flag on `status` / `watch`?

**Decision**: No. Session cwd is the single source of truth for bare-number `owner/repo` inference. A repo override is spelled `owner/repo#N` in the ref itself.

**Rationale**:
- Matches the `context` verb's contract (per #807 Q5) — `resolveIssueContext` accepts a programmatic `repo?: string` override, but `context` intentionally does not expose it as a CLI flag.
- `owner/repo#N` in the ref is strictly more explicit than a flag: the ref documents itself.
- Fewer CLI surface elements — matches the "one mechanism" pre-1.0 principle.
- `queue`'s existing `--repo` flag means *enqueue target*, not ref-resolution override, and is untouched.

**Alternatives considered**:
- **Expose `--repo <owner/repo>` on `status`/`watch`** for the bare-number case (Q5→B). Rejected: introduces a naming collision with `queue`'s `--repo` (different meaning), and `owner/repo#N` in the ref already covers the use case unambiguously.

**References**: clarification Q5 → A; spec §Out-of-Scope (bullet on `--repo` singular); `#807` Q5 precedent on `context`.

---

## Decision 5 — Which files does the spec actually point at?

**Decision**: The spec's `packages/cockpit/src/cli/status.ts`, `watch.ts`, `queue.ts` paths are wrong. The real CLI verbs live at `packages/generacy/src/cli/commands/cockpit/{status,watch,queue}.ts`. Retarget all FR notes. Given Decision 1, `packages/cockpit/src/resolver/resolve.ts` stays untouched.

**Rationale**:
- `packages/cockpit/src/cli/*` does not exist. `packages/cockpit/` is the shared library (`@generacy-ai/cockpit`) that exports `resolveEpic`, `matchPhaseHeading`, `GhCliWrapper`, etc.
- The `generacy` CLI package (`packages/generacy/`) is where every user-facing verb lives — including `context`, `status`, `watch`, `queue`, `merge`, `advance`, etc.

**Alternatives considered**:
- **Move CLI code into `packages/cockpit/src/cli/`** (Q2→B). Rejected: no such move is planned. Adding one under the banner of a bug fix would balloon the change into a package-boundary refactor.

**References**: clarification Q2 → A.

---

## Implementation patterns to follow

- **Commander `.argument()` vs `.requiredOption()`**: `queue.ts` already models the target shape — `.argument('<epic-ref>', 'Epic ref (owner/repo#N).')` + `.action(async (epicRef: string, opts) => …)`. Copy that pattern into `status.ts` and `watch.ts`; drop the `options.epic == null` guard.
- **`resolveIssueContext` call**: match `context.ts`'s call site — pass `{ issue, gh, cwd }` to the helper, catch the thrown `Error`, wrap as `Error: cockpit <verb>: <message>`, exit 2.
- **Passing to `resolveEpic`**: the helper returns `{ ref, repo, gh }`. Pass `` `${ref.nwo}#${ref.number}` `` (or `resolved.ref.nwo + '#' + resolved.ref.number`) as the `epicRef` string — that's the format `resolveEpic` already parses.
- **Test fixture migration**: `runStatus({ epic: 'owner/repo#42' }, deps)` → `runStatus('owner/repo#42', deps)` with signature change. Existing test fixtures should stay the same shape otherwise; `runStatus` and `runWatch` keep the same return types.

## Key references

- Rev-3 catalog: `docs/epic-cockpit-plan.md` in `tetrad-development` — authoritative on the positional `<epic-ref>` verb surface.
- `#806`: source of the drift ("scope by `--epic` only" was misread as "keep `--epic` flag").
- `#807` Q5: precedent for "session cwd is the single source of truth" on `context`.
- `#803`: prior ref-parsing dedup that this fix continues.
- `claude-plugin-cockpit`: `status.md`, `watch.md` — already pass `$ARGUMENTS` positionally. Untouched by this fix.
