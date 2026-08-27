# Quickstart: Route-aware session invalidation + transition logging

## Prerequisite

generacy#1198 must be merged to `develop` (it owns the `resolveRoute` export in
`@generacy-ai/generacy-plugin-claude-code`). Until then this feature is
HARD-BLOCKED — no code lands (Q4→A). After it lands: rebase this branch and verify
the export exists.

## Build & test

```bash
pnpm install
pnpm -r build
pnpm --filter @generacy-ai/orchestrator test
```

New suite: `packages/orchestrator/src/worker/__tests__/phase-loop.route-transition.test.ts`

```bash
pnpm --filter @generacy-ai/orchestrator test phase-loop.route-transition
```

## What changes at runtime

1. **Session invalidation** — the phase loop now drops the tracked CLI session when
   the resolved route changes between phases (subscription ⇄ gateway), even for the
   same provider. Cross-provider drops behave exactly as before.
2. **New log line** — `agent.route.transition` with
   `{phase, prevRoute, nextRoute, prevModel, nextModel}` fires on any route change.
   Not emitted on the first CLI phase of a run.
3. **Route in spawn logs** — the CLI spawn-site log ("Spawning/Resuming Claude CLI
   session for phase") and the four direct launch callers' log lines gain a `route`
   field showing which backend served the phase.

## Verifying from a transcript

- Which backend served a phase → grep the spawn-site line for `route`.
- Why a session didn't resume → look for `agent.route.transition` (route flip) or the
  provider-switch line (provider change) immediately before the spawn.
- Subscription-only run → every spawn log shows `route: 'subscription'` and no
  `agent.route.transition` lines appear (SC-003: behavior otherwise identical to
  pre-change).

## Troubleshooting

| Symptom | Cause | Check |
|---|---|---|
| `--resume` fails after a model switch | route changed but session wasn't dropped | should not happen post-fix; grep for `agent.route.transition` around the failing spawn |
| Spurious first-phase transition line | Q3 regression | `currentRoute === undefined` must skip both the line and the drop |
| Build error: `resolveRoute` not exported | #1198 not merged / branch not rebased | rebase on develop; verify the plugin export |
| Existing phase-loop tests fail | SC-003 regression | default mock must return `'subscription'`; no extra transition lines in subscription-only runs |

## Changeset

Implement phase must add `.changeset/1199-route-aware-session-invalidation.md`:
`@generacy-ai/orchestrator` **patch** (internal wiring + log fields; no new public
exports). The plugin is not modified — no bump there.

## Next step

Run `/speckit:tasks` to generate the task list.
