# Quickstart: verify the fix and understand the new layout

**Feature Branch**: `899-found-during-cockpit-v1`
**Issue**: [generacy-ai/generacy#899](https://github.com/generacy-ai/generacy/issues/899)

## What changed at a glance

- `/plan` no longer appends to `<repoRoot>/CLAUDE.md` on every feature branch.
- Per-feature technology notes now live in `specs/<feature>/stack.md` (branch-owned, no cross-branch conflict class).
- `CLAUDE.md` gains a static pointer to `specs/<feature>/stack.md`. Otherwise it is repo-owned, human-managed.
- Legacy `## <Feature Name> (#NNN)` sections already in `CLAUDE.md` are left alone; they drain out ambiently as branches merge.

## Where to look after the fix lands

| Question | Where to look |
|----------|---------------|
| What technologies does my current feature branch use? | `specs/<my-feature>/stack.md` |
| What's the project overview and setup? | `CLAUDE.md` (repo root, static) |
| What's the plan for this feature? | `specs/<my-feature>/plan.md` |
| What questions were answered during clarification? | `specs/<my-feature>/clarifications.md` |
| What does `/plan` produce? | `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, and `stack.md` — all under `specs/<my-feature>/` |

## Verify SC-002 (in-repo merge-tree invariant)

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/workflow-engine test managed-file-disjointness
```

Expected: two test cases pass —
1. `plan.ts prompt does not mention CLAUDE.md or update_agent (drift guard)`.
2. `two sibling branches writing per-feature stack.md do not conflict on CLAUDE.md`.

Failure diagnosis: see [contracts/merge-tree-invariant.md](./contracts/merge-tree-invariant.md).

## Verify SC-003 (no local shim)

```bash
grep -in "CLAUDE\\.md\\|update_agent" \
  packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts \
  | grep -v "^ *\\*"
```

Expected: zero hits (excluding docstring comments if any).

## Verify SC-004 (pointer discoverability)

```bash
head -50 CLAUDE.md | grep -A 3 "Per-feature technology notes"
```

Expected: the pointer block is present near the top of `CLAUDE.md`, mentioning `specs/<feature>/stack.md`.

## SC-001 end-to-end proof (after upstream lands)

Once the companion PR in `generacy-ai/agency` merges and clusters have rolled the new plugin:

```bash
# On a preview-channel cluster, run cockpit-v1.5 T-S4 scenario
# (two sibling branches, each through /plan, then base-merge each into a shared main)

# Reproduction sketch (paraphrasing T-S4):
generacy cockpit queue <epic> plan   # queues two P2 siblings
# ... wait for both /plan phases to complete ...
# manually attempt: git checkout <sibling-B> && git merge <sibling-A>
# → expected: clean merge, no CLAUDE.md conflict
```

If it conflicts: upstream companion PR didn't fully retarget `update_agent`. File a bug against `generacy-ai/agency` with the merge-tree output.

## Installation / prerequisites

- Node.js ≥22, pnpm (repo standard).
- No new package dependencies.
- Regression test uses `git merge-tree` (requires git ≥ 2.38, standard on all supported dev envs and CI images).

## Available commands

No new CLI commands. The behavior change is inside the `/plan` skill invocation flow.

## Migration notes for in-flight branches

**If your branch is already open and its `/plan` has already run**:
- Your branch's `CLAUDE.md` already has a `## <Your Feature Name> (#NNN)` section from that /plan run. It stays. Q2→A leave-alone.
- When your branch merges into base, that section merges in normally (or conflicts, if a sibling landed first — but the *class* of conflict is retiring: after your branch merges, no *new* branches will manufacture more of them).
- Your next `/plan` run (if you re-run it) — assuming the companion PR is live in your cluster — will produce `specs/<your-feature>/stack.md` and will not touch `CLAUDE.md`.

**If you open a new branch after upstream lands**:
- `/plan` produces `stack.md`; `CLAUDE.md` is untouched.
- Merges are clean by construction on the CLAUDE.md conflict class.

## Troubleshooting

**"I ran `/plan` and stack.md wasn't created."**

Check the plugin version in your cluster:

```bash
npm ls -g @generacy-ai/agency-plugin-spec-kit
```

If the version predates the companion PR, the cluster needs a plugin refresh:

```bash
npm install -g @generacy-ai/agency-plugin-spec-kit@${GENERACY_CHANNEL:-stable}
```

Or restart the cluster (setup-speckit.sh runs on boot).

**"I ran `/plan` and it still appended to CLAUDE.md."**

Same diagnosis — old plugin version. Refresh as above.

**"My branch merged into base with a CLAUDE.md conflict — I thought this fix eliminated that!"**

Two possibilities:
1. The conflicting `## <Feature Name>` section on your branch pre-dates the fix (Q2→A leave-alone). Resolve manually as before; the conflict class retires as in-flight branches drain out.
2. The plugin still has the old behavior on your cluster — see plugin-version diagnosis above.

**"The regression test fails on my machine."**

Check `git --version`. Requires ≥ 2.38. On older git, the `git merge-tree --write-tree` syntax is unavailable; the test may need a fallback branch for the older 3-arg form. Update git or run on CI.

## Related work

- Issue #899 (this feature): the /plan → CLAUDE.md conflict class.
- Cockpit merge-conflict handler #44: the general-purpose backstop for merge conflicts. Still in place; still handles other classes. This PR removes the *specific* class that was drowning the handler in agent-invocation cost.
- Cockpit v1.5 T-S4 smoke test: reproduces the class end-to-end. Reference for SC-001.
- Sibling epic #40 / #46: findings that traced #44's manufactured load back to the CLAUDE.md write.

---

*Generated by /plan for issue #899.*
