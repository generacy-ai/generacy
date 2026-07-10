# Quickstart: verify the resolver behaviour locally

**Feature**: #904 — deterministic issue→PR resolver

The fix is pure library + CLI logic — no build, no server, no state migration. Verifying it means running the unit-test suite and (optionally) the sniplink regression fixture by hand against a real `gh`-authed repo.

---

## 1. Install & build

```bash
pnpm install
pnpm --filter @generacy-ai/cockpit build
pnpm --filter @generacy-ai/generacy build
```

`@generacy-ai/cockpit` is the shared library that owns the resolver. `@generacy-ai/generacy` is the CLI package (`packages/generacy/`) that owns `runMerge` and the failing-check payload.

---

## 2. Run the tests

```bash
# Resolver + gh wrapper tests
pnpm --filter @generacy-ai/cockpit test

# Merge command + context command + fake-gh helper tests
pnpm --filter @generacy-ai/generacy test -- src/cli/commands/cockpit
```

Expected: all tests green. Key new cases (referenced by SC-001..SC-005):

- `gh-wrapper.test.ts` › `resolveIssueToPRRef` › SC-001 sniplink-shape fixture returns `resolved via closing-refs`.
- `gh-wrapper.test.ts` › `resolveIssueToPRRef` › SC-002 draft-only at each tier returns `pr-is-draft`.
- `gh-wrapper.test.ts` › `resolveIssueToPRRef` › SC-003 multi-non-draft at each tier returns `ambiguous`.
- `merge.test.ts` › SC-004 log-line snapshot: `resolved PR #23 via closing-refs`.
- `merge.test.ts` › SC-002 `pr-is-draft` payload: no `gh pr merge` invocation, `reason: 'pr-is-draft'`, `candidates` array populated.
- `merge.test.ts` › SC-003 `ambiguous-resolution` payload: no `gh pr merge` invocation, `reason: 'ambiguous-resolution'`, `linkMethod` names the tier.
- `context.implementation-review.test.ts` › new cases: each of `pr-is-draft`, `ambiguous`, `unresolved` at `waiting-for:implementation-review` → `CockpitExit(3, …)`.

---

## 3. Manually reproduce the sniplink incident (optional)

Requires: `gh auth status` clean and a repo where you can create issues + draft PRs.

### Setup

```bash
# In a scratch repo you own
gh repo create yourname/resolver-repro --private --clone
cd resolver-repro
git checkout -b main
echo "# repro" > README.md
git add . && git commit -m init
git push -u origin main

# Create issue #1
ISSUE=$(gh issue create --title "P3 phase — real work" --body "the real one" | tail -1)
echo "Issue: $ISSUE"

# Create three draft "sibling" branches whose bodies mention #1
for N in 2 3 4; do
  git checkout main
  git checkout -b "0${N}-phase-3-polish"
  echo "phase-$N" > "phase-$N.txt"
  git add . && git commit -m "phase $N"
  git push -u origin "0${N}-phase-3-polish"
  gh pr create --draft --title "phase $N" --body "depends on #1"
done

# Create the real, non-draft PR for issue #1 with a proper closing keyword
git checkout main
git checkout -b "01-the-real-one"
echo "real" > real.txt
git add . && git commit -m real
git push -u origin "01-the-real-one"
REAL_PR=$(gh pr create --title "the real one" --body "Closes #1" | tail -1)
echo "Real PR: $REAL_PR"
```

### Pre-fix behavior (from git HEAD~ if you want to verify the incident)

```bash
generacy cockpit merge 1 --repo yourname/resolver-repro
# → 'gh pr merge failed (exit 1): GraphQL: Pull Request is still a draft'
# → NO PR number in output.
```

### Post-fix behavior (from this branch)

Green (assuming `completed:validate` label present):
```bash
gh issue edit 1 --add-label completed:validate
generacy cockpit merge 1 --repo yourname/resolver-repro
# → log: 'resolved PR #<REAL_PR_NUMBER> via closing-refs'
# → stdout: 'merged and branch deleted' (or 'checks configured…' variant)
```

Red (drop the closing keyword from the real PR body so Tier 1 falls through):
```bash
gh pr edit $REAL_PR_NUMBER --body "not closing anything"
generacy cockpit merge 1 --repo yourname/resolver-repro
# → exit 1
# → stdout JSON with reason: 'ambiguous-resolution' OR 'pr-is-draft', linkMethod names the tier.
# → gh pr merge NEVER invoked.
```

---

## 4. Verify SC-005 (single-resolver assertion)

```bash
# Should show exactly ONE .ts file with the tiered issue→PR logic.
rg -l 'linkMethod.*closing-refs' packages/ --type ts \
  | grep -v __tests__ | grep -v \.spec\.

# Expected: exactly one hit — packages/cockpit/src/gh/wrapper.ts
```

`packages/orchestrator/src/worker/pr-linker.ts` intentionally does NOT match — it's the PR→issue direction resolver, a different query surface (see `plan.md` §"Not touched").

---

## 5. Available diagnostic commands

- `pnpm --filter @generacy-ai/cockpit test:watch` — resolver TDD loop.
- `pnpm --filter @generacy-ai/generacy test:watch -- merge` — merge command TDD loop.
- `pnpm typecheck` — verify the discriminated-union threads correctly through all call sites.

---

## Troubleshooting

**"Tests fail with 'resolveIssueToPRRef fake returned null, expected PullRequestRefResolution'"** — you have a stale test fake somewhere. Grep for `resolveIssueToPRRef: vi.fn(async () => null)` and update each to `resolveIssueToPRRef: vi.fn(async () => ({ kind: 'unresolved' }))`.

**"ajv validator rejects the payload with new reason"** — the schema in `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json` needs the additive edits from `contracts/failing-check-payload.md` §"JSON Schema — additive edits".

**"Real `gh` calls return no `isDraft` field"** — verify the `--json` list in the Tier 2/Tier 3 queries includes `isDraft`. Older gh CLI versions default-drop it. Bump `gh` to ≥2.30.

**"Log line prints after the merge failure, not before"** — the `logger.info` on the resolved branch must sit **above** any state fetch, label check, or `mergePullRequest` call in `runMerge`. Verify by inspecting the switch: the log line should be the first statement inside `case 'resolved':`.

---

## Next Step

Run `/speckit:tasks` to generate the dependency-ordered task list from this plan.
