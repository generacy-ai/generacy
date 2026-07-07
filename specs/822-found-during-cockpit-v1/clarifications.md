# Clarifications

## Batch 1 — 2026-07-07

### Q1: Parser architecture
**Context**: The spec says "extend `parseEpicRef` (`packages/cockpit/src/resolver/resolve.ts:10-20`) … same inference `context` uses". Two parsers already exist and they don't live where the spec says. (a) `packages/cockpit/src/resolver/resolve.ts:12` has a **private, sync** `parseEpicRef` called by `resolveEpic`. (b) `packages/generacy/src/cli/commands/cockpit/resolver.ts` exports **sync** `parseIssueRef` (which explicitly rejects bare numbers) plus **async** `resolveIssueContext` (which already infers `owner/repo` from `git remote get-url origin` — this is what `context` verb uses). `queue`/`status`/`watch` currently all call `resolveEpic({ epicRef, gh })`, not `resolveIssueContext`. Deciding where the fix lives determines whether `@generacy-ai/cockpit` gains a filesystem/git dependency or stays pure.
**Question**: Which mechanism should carry the bare-number inference for `queue`/`status`/`watch`?
**Options**:
- A: Lift resolution up — each verb calls `resolveIssueContext(...)` FIRST (reusing the code `context` already uses), then passes the expanded `owner/repo#N` string to the existing `resolveEpic()`. `@generacy-ai/cockpit`'s `parseEpicRef` stays sync and unchanged. **Preferred by "same inference `context` uses" phrasing.**
- B: Push resolution down — change `@generacy-ai/cockpit`'s `resolveEpic` to accept a bare number and do git-origin inference internally (async subprocess spawn inside the shared library). Introduces `git` shell-out to the cockpit package.
- C: Duplicate — inline a fresh copy of the inference logic in each verb.

**Answer**: A — lift resolution up; each verb calls `resolveIssueContext(...)` first and hands the expanded `owner/repo#N` to the existing `resolveEpic()`. That's the literal meaning of "same inference `context` uses," it keeps `@generacy-ai/cockpit` pure (no git subprocess in the shared library — option B smuggles a filesystem dependency into a package that's clean today), and C is the duplication the S-chain just spent three issues deleting.

### Q2: Which parser module do file-path FRs refer to?
**Context**: FR-001/002 point at `packages/cockpit/src/cli/status.ts:140` and `packages/cockpit/src/cli/watch.ts:173`, and FR-004 points at `packages/cockpit/src/resolver/resolve.ts:10-20`. Neither `packages/cockpit/src/cli/*.ts` exists. The real CLI verbs live at `packages/generacy/src/cli/commands/cockpit/{status,watch,queue}.ts`; the referenced `parseEpicRef` is a **private** function inside `packages/cockpit/src/resolver/resolve.ts` (not exported, not directly reachable from the verbs).
**Question**: Are the spec's file paths just wrong (implementer should retarget to `packages/generacy/src/cli/commands/cockpit/*` and — if Q1=A — leave `packages/cockpit/src/resolver/resolve.ts` alone), or is there an unmerged/planned move of the CLI code into `packages/cockpit/src/cli/`?
**Options**:
- A: Paths are wrong — retarget to actual locations, no code moves.
- B: A move to `packages/cockpit/src/cli/*` is planned and this fix should land there.

**Answer**: A — the spec's paths are wrong; retarget to `packages/generacy/src/cli/commands/cockpit/{status,watch,queue}.ts` and (given Q1=A) leave `packages/cockpit/src/resolver/resolve.ts` untouched. No move to `packages/cockpit/src/cli/*` is planned.

### Q3: Error shape and exit code for `INVALID_EPIC_REF`
**Context**: Two error mechanisms exist. `packages/cockpit/src/resolver/errors.ts` defines `LoudResolverError` with code `INVALID_EPIC_REF` but **no message body** — the CLI prints only the code. `packages/generacy/src/cli/commands/cockpit/resolver.ts` throws `Error('parse issue: <detailed reason>')`. Existing `status.ts:54` returns exit code 2 on `INVALID_EPIC_REF`. `context.ts` returns exit 2 for `parse issue: …` too. FR-007 says "loud `INVALID_EPIC_REF` error listing all three accepted forms (bare number, `owner/repo#N`, full URL)" — but doesn't say which mechanism.
**Question**: How should the new fail-loud error be shaped?
**Options**:
- A: Extend `LoudResolverError` to carry a message; error line: `cockpit <verb>: INVALID_EPIC_REF: accepts <n>, <owner>/<repo>#<n>, https://github.com/<owner>/<repo>/issues/<n>`. Exit 2.
- B: Reuse the existing `parse issue: <reason>` shape emitted by `parseIssueRef`/`resolveIssueContext` (which already lists the accepted forms); wrapped as `Error: cockpit <verb>: parse issue: …`. Exit 2. (Naturally falls out of Q1=A.)
- C: New format — specify.

**Answer**: B — reuse the existing `parse issue: <detailed reason>` shape from `resolveIssueContext`, wrapped with the verb name, exit 2. It already lists the accepted forms, it's what `context` emits today, and Q1=A produces it for free — one ref-parsing error mechanism across all four verbs. FR-007's "INVALID_EPIC_REF" named the requirement (loud + enumerate accepted forms), not a mandatory error-code string; B satisfies the requirement. Ensure the listed forms in that message include the bare number now that it's legal.

### Q4: Does `queue` migrate to the shared resolver too?
**Context**: FR-009 says `queue` continues to accept `<epic-ref> <phase>` "unchanged" and is a regression-guard. Today `queue.ts:223` calls `resolveEpic({ epicRef, gh })` directly and — like `status`/`watch` — does **not** support bare numbers. If Q1=A, keeping `queue` on the old code path means `queue owner/repo#1` works but `queue 1 implement` does not, so US2's "same inference works for `queue`, `status`, and `watch`" would fail. The FR wording ("unchanged") conflicts with US2 ("single grammar across all three").
**Question**: Should `queue` also route through the new resolution helper so bare numbers work there?
**Options**:
- A: Yes — `queue` also routes through the new helper (aligns with US2 "single grammar"). "Unchanged" in FR-009 refers only to the argument surface (positional `<epic-ref> <phase>`), not the internal parser call.
- B: No — `queue` stays literally unchanged. US2 tightens to "single grammar for status/watch only".

**Answer**: A — `queue` routes through the new helper too. US2's "single grammar across all three" is the requirement; FR-009's "unchanged" refers to the argument surface (positional `<epic-ref> <phase>`), which stays byte-identical. A smoke tester who just ran `status 1` will type `queue 1 P1` next — having that fail on the third verb would be this same bug, refiled.

### Q5: `--repo` override flag on the verbs?
**Context**: `resolveIssueContext` already accepts a programmatic `repo?: string` override (falls back to `git origin` inference only when unset). Per `resolver.ts` comment, the `context` verb intentionally does NOT expose `--repo` as a CLI flag (per #807 Q5→A). `queue.ts` already declares a `--repo` option (line 37) with a different meaning (target repo for enqueue, not ref-resolution override). Spec's Out-of-Scope excludes `--repos` (plural) reintroduction but doesn't explicitly address singular `--repo` override for ref inference.
**Question**: Should the new bare-number-capable positional forms of `status`/`watch` expose any `--repo <owner/repo>` flag to override the cwd-origin inference?
**Options**:
- A: No `--repo` on `status`/`watch` — match `context`'s "session cwd is the single source of truth" contract (spec's Out-of-Scope also says cwd is the single source).
- B: Yes — expose `--repo <owner/repo>` on `status`/`watch` for the bare-number case (useful when running against a repo other than cwd).

**Answer**: A — no `--repo` on `status`/`watch`. Session cwd is the single source of truth for bare-number inference, matching the #807 Q5 precedent on `context`; a repo override is spelled `owner/repo#N` in the ref itself, which is strictly more explicit than a flag. (`queue`'s existing `--repo` means something else — enqueue target — and is untouched here; if its naming proves confusing that's a separate, later cleanup.)
