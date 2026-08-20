# Research: Phase-5 closeout docs + rollout + dogfood

## Decision 1 — Page layout: consolidated guide + separate reference + standalone checklist (Q2→A)

**Decision.** Three docs pages plus one runbook:
- `docs/docs/guides/generacy/review-remediate-migration.md` — migration + gate semantics + flags (US1 + US2).
- `docs/docs/reference/review-artifacts.md` — findings-artifact + review-marker contracts (US3).
- `docs/docs/guides/generacy/review-remediate-rollout.md` — rollout checklist (US4).
- `docs/docs/guides/generacy/review-remediate-dogfood.md` — dogfood runbook (US5, FR-006/FR-007).

**Rationale.** US1 (migration) and US2 (gate semantics) are the same operator reading the same page while turning the flow on — coupling them into one narrative avoids cross-page hopping. US3 is a different audience (integrators / downstream tooling), so its contracts belong on a reference page next to the existing `bugfix-profile-config.md`. The rollout checklist is procedural and gets ticked off during a deploy, so it stands alone.

**Alternatives considered.**
- *B — one page per FR.* Fragments the coupled migration/gates story across pages; rejected.
- *C — author owns filenames, just wire the sidebar.* Under-specifies the deliverable; rejected.

## Decision 2 — Contracts documented hybrid (Q4→C)

**Decision.** The reference page inline-summarizes both contract shapes AND links to the canonical shipped files as the authoritative source.

- Findings-artifact sidecar: `ReviewArtifactSchema` in `packages/orchestrator/src/worker/review-artifact.ts` (#1124). Path `.generacy/review-findings-<sanitized-workflowId>.json`; `severity: critical|major|minor`, `status: open|resolved`, `verdict: clean|changes-required`, `round`, `remediationCount`. Engine-internal — GitHub review state is never source of truth.
- Engine review marker: `packages/orchestrator/src/worker/review-poster.ts` (#1125). Body `<!-- generacy-engine-review round=<N> -->` (prefix `generacy-engine-review`); inline `<!-- generacy-finding:<marker> -->`.
- **Contract-name key** the generacy-cloud mirror matches on: `generacy-engine-review` (body) / `generacy-finding:` (inline).

**Rationale.** FR-008 makes shipped code authoritative, so an inline-only copy (A) drifts the moment the schema changes; a link-only summary (B) fails US3's readability goal. Hybrid gives readers the shape at a glance and a stable pointer to the truth.

**Verification (this session).** Confirmed against the branch: `ReviewArtifactSchema` fields and enums exactly as above; `REVIEW_BODY_MARKER_PREFIX = 'generacy-engine-review'` and the inline `<!-- generacy-finding:` marker in `review-poster.ts`.

## Decision 3 — Docusaurus build is the acceptance gate (Q5→A)

**Decision.** Wire every new page and the orphaned `bugfix-profile-config.md` into `docs/sidebars.ts`; treat a clean `npm run build` in `docs/` as the acceptance gate.

**Rationale.** `docs/` is not in `pnpm-workspace.yaml` and there is no per-PR docs CI job, so the only enforcing gate is the Docusaurus build itself. `docusaurus.config` sets `onBrokenLinks: 'throw'`, so a dangling internal link (e.g., a link to `bugfix-profile-config.md` from the new guide) fails the build — which is exactly why the migration guide's cross-links double as reachability tests. `sidebars.ts` is a manually curated list; a page not added there renders but is undiscoverable (the current state of `bugfix-profile-config.md`).

**Alternative.** *B — well-formed Markdown is enough, nav best-effort.* Reproduces the orphaned-page defect the epic's docs premise exists to prevent; rejected.

## Decision 4 — Rollout mechanics: restart, not `generacy update`

**Decision.** The rollout checklist orders: publish `@channel` packages → **restart cluster** → **restart workers** → **fresh Claude session**, and states explicitly that `generacy update` alone is insufficient.

**Rationale (grounded).** Clusters pick up new npm packages via the entrypoint re-pulling `@channel` packages on **boot** — a running cluster does not hot-swap packages. Workers are separate processes and must restart to load new code. A newly rolled-out package only takes effect for a **fresh** Claude session; an in-flight session keeps the old code. This is the single most common rollout footgun and is called out first.

## Decision 5 — Repo-agnostic canary placeholder (Q3→A)

**Decision.** Both the rollout checklist and the dogfood runbook use a clearly-marked `<CANARY-REPO>` placeholder the operator fills in at run time. No repo is hard-coded.

**Rationale.** The spec never names a canary; canary identity is an operator/runtime decision. Hard-coding a repo would make the checklist non-reusable and rests on no grounded fact. Consistent with the Q1→C model where the operator supplies live-run specifics.

## Decision 6 — Dogfood shipped as runbook, live run deferred (Q1→C)

**Decision.** Ship an unchecked in-repo dogfood runbook (checkbox list) now; the live feature + bugfix runs are a post-merge operator step recorded against epic #1120.

**Rationale.** An automated speckit worker running in this repo cannot restart clusters, add the `ready_for_review` CI trigger (needs `Workflows: write`), or drive live stories — so gating the PR on the live run (option B) would deadlock it. Shipping docs only (option A) drops the evidence artifact. C keeps the P1 docs mergeable while preserving FR-006/FR-007 as a committed, tickable runbook.

## Decision 7 — FR-008 doc/code reconciliation is an audit, not a rewrite

**Decision.** During implement, audit existing docs for statements that contradict shipped Phase 1–4 behavior and correct them in place; do not pre-emptively rewrite pages.

**Rationale.** `bugfix-profile-config.md` already matches shipped code (verified). Expected reconciliation scope is none-to-minimal. FR-008 is a standing rule ("docs describe reality"), applied where a concrete contradiction is found, not a mandate to rewrite unrelated pages.

## Sources

- `docs/engine-review-remediate-plan.md` (generacy-ai/tetrad-development) — flow + rollout mechanics.
- Shipped branch code: `packages/orchestrator/src/worker/{review-artifact,review-poster,review-executor,review-charter}.ts`, remediate + CI-merge-gate machinery.
- `docs/docs/reference/bugfix-profile-config.md`, `docs/sidebars.ts`, `docs/docusaurus.config.*` (`onBrokenLinks`).
- Phase 1–4 specs: `specs/1121`, `specs/1124`, `specs/1125`, `specs/1128`, `specs/1133`.
