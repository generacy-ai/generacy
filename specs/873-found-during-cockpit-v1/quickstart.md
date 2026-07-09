# Quickstart — #873 verification

## What changed

`cockpit watch` and `cockpit status` no longer treat closed children as actionable, regardless of what labels they carry. Closed-because-merged renders `✓ merged/closed` (green); closed-because-not-planned renders `✗ closed (not planned)` (dim). Behaviour for OPEN issues is unchanged.

## Live reproducer (pre-fix)

```bash
# Terminal 1: attach to the sniplink epic
cd ~/Generacy/sniplink
npx @generacy-ai/generacy cockpit watch 1
```

Pre-fix output (bug):

```jsonl
{"ts":"…","repo":"christrudelpw/sniplink","kind":"issue","number":2,"from":null,"to":"terminal","sourceLabel":"completed:validate","event":"label-change","labels":["completed:validate","…"],"initial":true,"url":"…"}
{"ts":"…","repo":"christrudelpw/sniplink","kind":"issue","number":3,"from":null,"to":"terminal","sourceLabel":"completed:validate","event":"label-change","labels":["completed:validate","…"],"initial":true,"url":"…"}
```

(Downstream cockpit-watch skill turns each of these into `suggested: /cockpit:merge christrudelpw/sniplink#N`.)

Post-fix: initial-sweep is silent for both closed children — no lines emitted. `/cockpit:merge` suggestions do not surface.

## Local verification

### 1. Rebuild the CLI

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/generacy --filter @generacy-ai/cockpit build
```

### 2. Verify unit tests pass

```bash
pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/
pnpm --filter @generacy-ai/cockpit test packages/cockpit/src/gh/
```

New regression cases:
- `is-done-snapshot.test.ts` — closed + `completed:validate` → `false` actionable.
- `watch.actionable.test.ts` — closed startup sweep silent.
- `watch.diff.test.ts` — live open→closed emits exactly one `issue-closed` event.
- `status.render.test.ts` — closed rows render `✓ merged/closed` / `✗ closed (not planned)`.
- `status.color.test.ts` — closed rows carry green / dim colour respectively.
- `gh-wrapper.test.ts` — `stateReason` flows through `listIssues` and `getIssue`.

### 3. Manual smoke against the live sniplink epic

```bash
cd ~/Generacy/sniplink
npx @generacy-ai/generacy cockpit status 1
```

**Expected**:
```
== P1: specify ==
christrudelpw/sniplink   #    2   ✓ merged     merged/closed              PR    12   success   feat: sniplink schema
christrudelpw/sniplink   #    3   ✓ merged     merged/closed              PR    13   success   feat: sniplink API
```

The `✓ merged` and `merged/closed` columns should be green in a TTY. The rows stay under the `P1: specify` header — they do not migrate to a separate `— Done —` block.

Then:

```bash
npx @generacy-ai/generacy cockpit status 1 --json | jq '.rows[] | select(.issueState == "CLOSED")'
```

**Expected**:
```json
{
  "repo": "christrudelpw/sniplink",
  "number": 2,
  "state": "terminal",
  "sourceLabel": "completed:validate",
  "issueState": "CLOSED",
  "stateReason": "COMPLETED",
  "…": "…"
}
```

Note that `state` and `sourceLabel` are preserved for backwards compatibility — the new `issueState` field is the actionability signal.

### 4. Live open→closed transition

Start a fresh watch, then close a child on the epic:

```bash
npx @generacy-ai/generacy cockpit watch 1 &
gh issue close 4 --repo christrudelpw/sniplink --reason completed
```

**Expected**: exactly one `event: issue-closed` NDJSON line with `to: "terminal"` for #4. No subsequent lines for #4 on the next poll (drops from actionable set).

## Rollback

If the fix misclassifies an edge case, the entire change is bounded:

- Revert `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts` to remove the `isDoneSnapshot` short-circuit — closed issues resume flagging as actionable (the pre-#873 behaviour).
- Revert `packages/generacy/src/cli/commands/cockpit/status/render-table.ts::fmtRow` to remove the `issueState` branch — closed rows resume rendering their label-derived `state` + `sourceLabel`.
- Field additions on `Issue` / `Snapshot` / `StatusRow` can stay; they are additive.

## Available commands (unchanged)

- `cockpit watch <epic-ref>` — emits NDJSON events for the epic. Post-fix: no lines for closed children on startup sweep; one `issue-closed` event on live close.
- `cockpit status <epic-ref>` — snapshot table. Post-fix: closed rows render `✓ merged/closed` or `✗ closed (not planned)`.
- `cockpit status <epic-ref> --json` — envelope with `StatusRow[]`. Post-fix: each row carries `issueState` and `stateReason`.

## Troubleshooting

- **`stateReason` field is `null` on a visibly-closed issue**: check `gh api /repos/OWNER/REPO/issues/N` — GitHub sometimes lags on returning `state_reason` for recently-closed issues (or returns it as `null` for old closures pre-dating the API field). The render defaults to `✓ merged/closed` in this case, which is the correct behaviour for un-attributed closures.
- **Green `✓ merged` on an issue closed with `not_planned`**: `gh` may report `stateReason: null` for closures done via web UI without a reason field. Verify with `gh issue view N --json state,stateReason`.
- **Grep audit fails**: run `rg -n "state === 'CLOSED'" packages/generacy/src/cli/commands/cockpit/watch/` — expect 0 matches. Any hit means a second done-gate was added; consolidate through `isDoneSnapshot`.
