# Quickstart: Phase-5 closeout docs

This issue ships documentation only. "Building" it means building the Docusaurus site and confirming the new pages are wired and reachable.

## Prerequisites

- Node ≥ 22 (repo baseline).
- The `docs/` site (outside the pnpm workspace — install and build it on its own).

## Build & preview the docs

```bash
cd docs
npm ci
npm run build      # acceptance gate: must pass clean (onBrokenLinks: 'throw')
npm run start      # optional: local preview at http://localhost:3000
```

A clean `npm run build` is the acceptance gate (Q5→A / SC-007): `onBrokenLinks: 'throw'` fails the build on any dangling internal link, so it proves every new page is reachable and every cross-link resolves.

## Files this feature adds/edits

New pages:
- `docs/docs/guides/generacy/review-remediate-migration.md` — migration + gates + flags (US1/US2).
- `docs/docs/reference/review-artifacts.md` — findings-artifact + review-marker contracts (US3).
- `docs/docs/guides/generacy/review-remediate-rollout.md` — rollout checklist (US4).
- `docs/docs/guides/generacy/review-remediate-dogfood.md` — dogfood runbook (US5).

Edited:
- `docs/sidebars.ts` — wire the four new pages + the orphaned `reference/bugfix-profile-config`.

## Verify

1. **Build passes.** `npm run build` in `docs/` exits 0.
2. **Sidebar reachability.** In `npm run start`, confirm all four new pages and `bugfix-profile-config` appear in the sidebar under Guides → Generacy / Reference.
3. **Grounding audit.** Each documented flag/label/shape/marker matches its cited shipped file:
   - flags: `WORKER_REVIEW_PHASE_ENABLED`, `WORKER_CI_MERGE_GATE_ENABLED` (default OFF)
   - sidecar: `ReviewArtifactSchema` in `packages/orchestrator/src/worker/review-artifact.ts`
   - markers: `generacy-engine-review` / `generacy-finding:` in `packages/orchestrator/src/worker/review-poster.ts`
4. **Checklist completeness.** Rollout checklist orders publish → cluster restart → worker restart → fresh session, says `generacy update` is insufficient, uses a `<CANARY-REPO>` placeholder, and includes a flag-based rollback note. Dogfood runbook has unchecked feature + bugfix items linking to epic #1120.

## Rollout mechanics reference (for the docs prose)

Clusters pick up new `@channel` packages on **boot** (entrypoint re-pull), not via `generacy update`. So a real rollout is: publish → restart cluster → restart workers → **fresh** Claude session (a newly rolled-out package does not affect an in-flight session).

## Note: no changeset

The diff touches only `docs/` and `specs/`. No file under `packages/*/src/` changes, so the changeset gate does not apply and no `.changeset/*.md` is added.
