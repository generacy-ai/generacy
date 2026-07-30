# Contract: `.changeset/1067-runid-on-gate-query.md`

**Issue**: [#1067](https://github.com/generacy-ai/generacy/issues/1067)

## Required shape

```markdown
---
'@generacy-ai/generacy': patch
'@generacy-ai/orchestrator': patch
---

Phase B of the #1053 fix: widen `cockpit_gate_status` / `cockpit_gate_list`
MCP schemas to accept an optional `runId` field, and thread it through the
query client + orchestrator route + cloud gate-query client so a caller that
supplied `runId` on `cockpit_gate_open` can then re-issue `cockpit_gate_status`
in the same run and observe `open` (not `absent`).

- `cockpit_gate_status`: schema widened, `runId` forwarded to the cloud as a
  `runId=<value>` query-string parameter (camelCase); post-call log line emits
  `runIdSource: 'explicit' | 'unset'` on success + failure paths (value never
  logged).
- `cockpit_gate_list`: schema widened for surface parity; handler drops
  `runId` before calling the client (cloud route 400s any list carrying `runId`).
  No `runIdSource` log line on list.

Byte-compat: with `runId` omitted, every derived key, id, and outbound URL is
byte-identical to today (pinned by snapshot + structural tests).

Requires cloud Phase A (generacy-cloud#892, merge `192fca7c`, deployed
`2026-07-29T04:07:07Z`). On-call MUST verify Phase A is in prod at merge time.
```

## Bump rationale

**Both `patch`**, per CLAUDE.md § Changesets rules:

- No new public capability — `runId` is an optional field on tools that already exist. The tools' public contract widens permissibly (accepts more inputs; existing inputs behave identically).
- No new label vocabulary in `workflow-engine` (not touched).
- No new re-exports from any package's public `index.ts` — internal MCP surface only.
- Bug-fix character: this PR closes the read-side of the #1053 gate-re-open bug. Bug fixes → `patch` by the CLAUDE.md convention.

## Location

The file MUST be a **newly added** file in the PR diff (CLAUDE.md § Changesets
"It must be a **newly added** file in the PR diff"). Do not edit an existing
changeset.

## Verification

Local:
```bash
pnpm changeset status
```
Should list both packages as bumped.

CI gate (`.github/workflows/changeset-bot.yml`):
- Diff touches `packages/generacy/src/` (non-test) → changeset required — satisfied.
- Diff touches `packages/orchestrator/src/` (non-test) → changeset required — satisfied.

Note: `pnpm changeset status --since=origin/develop` will not see the new
file until it is committed (reads git, not the working tree). Use plain
`pnpm changeset status` from the working tree during development.
