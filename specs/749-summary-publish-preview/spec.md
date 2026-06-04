# Feature Specification: Detect & prevent stale `preview` npm publishes

**Branch**: `749-summary-publish-preview` | **Date**: 2026-06-04 | **Status**: Draft | **Issue**: #749

## Summary

The `publish-preview` workflow (`.github/workflows/publish-preview.yml`) currently triggers on both `push: develop` (auto, added in #538) and `workflow_dispatch` (manual). When triggered manually around the time a PR merges, the job snapshots whatever `develop` points to **at trigger time** and publishes a `preview` tag. If `develop` advances during the run, the published tag is stale — its version timestamp looks current, but the tarball is missing the just-merged commit.

This bit us with #744/#746: `0.0.0-preview-20260603190235` was timestamped ~1 min after #744 merged but did not contain #744's `deriveTunnelName`, so the deployed cloud cluster reported a projectId-derived tunnel name. A manual republish (`…233608`) fixed it.

Cloud clusters install `@generacy-ai/*@preview` at every boot, so a stale `preview` tag silently ships old code to all new staging clusters until someone notices and republishes. The version timestamp makes the staleness invisible — "the cluster has the latest preview" appears true while the code is actually behind.

## User Stories

### US1: Staging operator can trust `preview` reflects merged `develop`

**As a** Generacy engineer who has just merged a PR to `develop`,
**I want** the `@preview` npm tag to reliably contain my merged commit within the workflow's normal run time,
**So that** newly booted staging clusters pick up the change without me having to manually republish or audit version metadata.

**Acceptance Criteria**:
- [ ] A merge to `develop` always results in a `preview` tag whose tarball contains the merge commit, OR the publish fails loudly (and re-runs automatically on the new HEAD).
- [ ] No manual "republish after merge" step is required.
- [ ] A workflow_dispatch run that becomes stale during its build does not silently publish a stale tarball over a newer one.

### US2: On-call engineer can verify which commit a `preview` tarball was built from

**As an** engineer debugging a staging cluster that "should have feature X",
**I want** to inspect a published `preview` tarball (or its npm metadata) and see the exact `develop` SHA it was built from,
**So that** I can answer "does this preview contain commit X?" in one command without re-deriving build times or trusting the timestamp.

**Acceptance Criteria**:
- [ ] Each published `preview` tarball exposes the source git SHA (in version string, `package.json` field, or npm provenance metadata).
- [ ] A single command (`npm view @generacy-ai/<pkg>@preview <field>` or equivalent) returns that SHA.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Published `preview` tarballs MUST expose the git SHA they were built from in a programmatically queryable location (e.g., `package.json#gitHead`, version suffix, or provenance attestation). | P1 | Staleness must be detectable post-publish without external state. |
| FR-002 | The workflow MUST NOT silently publish a tarball whose source SHA is older than the current `@preview` tag's source SHA. | P1 | Prevents stale overwrite of newer preview by a slow workflow_dispatch run. |
| FR-003 | When a stale publish is detected (FR-002), the workflow MUST fail loudly with a clear log message, and the auto-trigger on the new `develop` HEAD MUST still produce a valid `preview` tag. | P1 | Fail closed; do not block forward progress. |
| FR-004 | The auto-trigger (`push: develop`) MUST remain the primary publish path so that merges always produce a fresh preview without manual action. | P1 | Already in place from #538; do not regress. |
| FR-005 | `workflow_dispatch` SHOULD remain available for ad-hoc republishes, but the staleness guard (FR-002) MUST apply to it. | P2 | Manual dispatch is useful for failure recovery; just not for accidental stale overwrites. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Time between PR merge to `develop` and `@preview` tag containing that commit | < workflow runtime + 5 min | Compare merge timestamp vs. `npm view @preview` `gitHead` for the next 10 merges. |
| SC-002 | Detectability of staleness | One-line command answers "does preview contain SHA X?" | Run `npm view @generacy-ai/credhelper@preview gitHead` (or equivalent) and grep. |
| SC-003 | Number of manual "republish after merge" actions required | 0 over a 30-day window | Audit `gh run list --workflow=publish-preview.yml --event=workflow_dispatch`. |

## Assumptions

- npm's published `package.json` retains a `gitHead` field (or we add one explicitly during the changeset version step).
- The `concurrency` group (`${{ github.workflow }}`, `cancel-in-progress: false`) is sufficient to serialize runs — the bug is about staleness within a serialized run, not parallel races.
- `actions/checkout@v6` is deterministic about which SHA it resolves on `push` events (the pushed SHA, not `HEAD` at job start).
- Cloud clusters consume `@preview` via plain `npm install` — they do not pin SHAs.

## Out of Scope

- Replacing the `preview` tag scheme with per-commit immutable tags (e.g., `preview-<sha>`) — interesting but larger surface area; revisit if FR-002 proves insufficient.
- Auditing whether `develop` itself can land broken commits (separate concern: CI gating on PRs).
- Changing how cloud clusters install/upgrade preview packages.
- Provenance attestation policy beyond what `--provenance` already provides.

## Relates

- #744 (`deriveTunnelName`) — the change that was silently dropped.
- #746 — the cloud-side symptom (projectId-derived tunnel name).
- #538 — added the `push: develop` auto-trigger.

---

*Generated by speckit*
