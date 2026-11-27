# Quickstart: Zero-question clarify gate fix (#1246)

## Build & test

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator build   # deps build first via workspace graph
pnpm --filter @generacy-ai/orchestrator test -- has-pending-clarifications
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.resume-gates
```

(Reminder from CLAUDE.md: cross-package imports resolve to built `dist/` — rebuild
`workflow-engine` before typechecking the orchestrator if it was touched upstream.)

## Verifying the behaviour change

Unit level — the decision table in `data-model.md`:

```bash
pnpm --filter @generacy-ai/orchestrator test -- has-pending-clarifications
```

Expected: ENOENT-coded read error → `false`; EACCES/plain-Error → `true`; all #958
fail-closed assertions still green.

End-to-end (SC-001, on a cluster): run a speckit issue whose spec is unambiguous. After the
clarify phase:

- worker log shows `no clarifications.md — clarify produced no questions; gate will skip`
- issue never receives `waiting-for:clarification` / `agent:paused`
- workflow proceeds to the `plan` phase with no `completed:clarification` override

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Issue still pauses with no questions posted | spec dir itself missing/misnamed (`specs/<issue>-*` — FR-003 fail-closed), or read error is not ENOENT (check permissions, worker log) |
| Issue advances but questions existed | file was non-empty and parsed — inspect `clarifications.md` answers vs `isPendingAnswerValue` |
| Unit tests pass but gate still pauses in cluster | stale orchestrator build — rebuild/redeploy the orchestrator image |
