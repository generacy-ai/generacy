# Feature Specification: `cockpit resume <issue-ref>` — re-arm a failed phase so auto-mode Requeue works and failed issues are recoverable

**Branch**: `891-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft
**Source**: [generacy-ai/generacy#891](https://github.com/generacy-ai/generacy/issues/891) (found via cockpit v1.5 auto-mode integration smoke test, generacy-ai/tetrad-development#92 finding #42; S8 scope addition from agency#392 Q3 that did not land in #885)

## Summary

`generacy cockpit resume <issue-ref>` does not exist. This is the missing engine-owned re-arm operation for a failed phase — the mechanical primitive that both (a) the auto-mode escalation gate's "Requeue" action and (b) the future re-validate-on-base-advance flow depend on. Without it, the auto-mode escalation for `failed:*` renders **"Requeue (cockpit resume) — unavailable, degrades to Skip"** with a ledger note, which means every `agent:error` / `failed:*` escalation collapses to Skip (mute) or Stop. A run with any failed issue can therefore **never reach `epic-complete`**. This exact degradation stranded the T-S4 smoke-test run with three issues at `failed:validate`, and the operation was performed as by-hand label surgery ~5 times during T-S2.

The verb is engine-owned label surgery per the label protocol: clear `agent:error` and `failed:<phase>`, restore the failed phase's `waiting-for:<gate>` / `completed:<gate>` resume pair (matching poll-path resume semantics — see `advance.ts`'s label-pair invariant note and #845) so the label monitor's next poll enqueues the issue and the worker's phase resolver picks `<phase>` as the start phase. It MUST be idempotent (no-op with clear message when the issue isn't failed) and MUST exit non-zero with evidence when the issue's state can't be re-armed (e.g. failed label present but no phase suffix, or conflicting labels).

This spec covers (a) adding the `resume` subcommand to `packages/generacy/src/cli/commands/cockpit/`, (b) wiring it through the same `resolveIssueContext` grammar every other cockpit verb uses (per #822/#850 unified issue-ref grammar), (c) documenting it in the package README as the contract source auto.md points at, and (d) proving the poll-path handoff end-to-end so a `failed:validate` issue actually re-runs validate — the by-hand recovery becomes a one-liner.

## User Stories

### US1: Recover a failed issue without restarting from specify

**As a** developer whose auto run stopped with `failed:validate` on an issue,
**I want** `generacy cockpit resume <issue-ref>` to re-arm the validate phase in place,
**So that** the issue re-runs validate on the next monitor poll without losing prior phase artifacts (which `process:*` re-queue would discard by restarting from specify).

**Acceptance Criteria**:
- [ ] `generacy cockpit resume generacy-ai/generacy#N` on an issue whose labels include `{agent:error, failed:validate}` clears `agent:error` and `failed:validate` and applies the `waiting-for:validate` + `completed:validate` pair required by poll-path resume detection.
- [ ] After the command exits 0, the next label-monitor poll enqueues the issue and the worker resolves `startPhase = validate`.
- [ ] The command works for every phase suffix present in the label protocol (`failed:<phase>` → re-arm `<phase>`), not just `validate`.
- [ ] Bare number and full URL forms are accepted per the unified grammar (`resolveIssueContext`).

### US2: Auto-mode Requeue actually requeues

**As a** cockpit auto run,
**I want** the D.7/D.8 escalation gate's Requeue action to invoke `cockpit resume` on the failed issue,
**So that** an `agent:error` / `failed:*` state has a real recovery path and the run can still reach `epic-complete` even when some issues fail once.

**Acceptance Criteria**:
- [ ] `cockpit resume` exists as a callable CLI verb (per FR-001) — the sole prerequisite for auto.md D.7/D.8 to stop degrading to Skip.
- [ ] The ledger note "Requeue unavailable, degrades to Skip" no longer fires for `failed:*` states once the verb is present. (Note: the auto-mode gate that consumes it lives in a sibling change — this spec ships the primitive; the consumer wiring is verified end-to-end but the auto.md text update lands where the gate does.)

### US3: Idempotent and safe on non-failed issues

**As a** developer running `cockpit resume` from a script or by mistake,
**I want** the command to be a no-op with a clear explanation when the target issue is not in a failed state,
**So that** re-running it accidentally cannot corrupt an in-progress issue's labels.

**Acceptance Criteria**:
- [ ] `cockpit resume <ref>` on an issue with no `failed:<phase>` label prints a single explanatory line (e.g. `issue N is not in a failed state (no failed:<phase> label); nothing to re-arm`) and exits 0.
- [ ] `cockpit resume <ref>` on an issue with `failed:<phase>` but conflicting labels that make the re-arm ambiguous (e.g. two different `failed:*` suffixes, or `failed:<phase>` with `waiting-for:<other-gate>` already present) exits non-zero with an evidence line naming the conflicting labels — no partial mutation.
- [ ] Running `resume` twice on the same issue is safe: the second run is either a no-op (labels already restored → the poll-path already consumed the resume) or produces the same terminal state as the first.

### US4: Documented as the contract source

**As a** cockpit user or agent reading auto.md's escalation table,
**I want** the package README to describe `cockpit resume` with its arguments, exit codes, and side effects,
**So that** auto.md's D.7/D.8 rows can link to a single source of truth for the verb's contract.

**Acceptance Criteria**:
- [ ] The `@generacy-ai/generacy` package README (or the appropriate cockpit README under `packages/generacy/src/cli/commands/cockpit/`) documents `cockpit resume` alongside `advance`, `context`, `queue`, `merge`, `status`, `watch`.
- [ ] The docs enumerate: accepted ref forms, exit codes, the exact labels added/removed, and the idempotency + refusal semantics.

## Functional Requirements

| ID    | Requirement | Priority | Notes |
|-------|-------------|----------|-------|
| FR-001 | Add a new `resume` subcommand under `generacy cockpit` (`packages/generacy/src/cli/commands/cockpit/resume.ts`, registered in `index.ts`). It MUST take a single `[issue]` argument and route it through `resolveIssueContext` for issue-ref parsing (bare number, `owner/repo#N`, full URL). | P1 | Follow the shape of `advance.ts` — Commander subcommand, `CockpitExit` for controlled exits, injectable `runner`/`gh`/`stdout`/`stderr` for tests. |
| FR-002 | On an issue with labels including `agent:error` and exactly one `failed:<phase>`, the verb MUST perform: remove `agent:error`, remove `failed:<phase>`, add `waiting-for:<gate>`, add `completed:<gate>` — where `<gate>` is the resume-pair suffix corresponding to `<phase>` per the label protocol. The four label mutations MUST be applied so the terminal on-issue state matches the poll-path resume detector's requirement (both `waiting-for:<gate>` AND `completed:<gate>` present — see `advance.ts` header comment and #845). | P1 | The `<phase> → <gate>` mapping table is the same one the label monitor already uses for resume detection. Planning phase owns whether to import the existing map or duplicate + share it. |
| FR-003 | The verb MUST be idempotent on non-failed issues: if no `failed:<phase>` label is present, print a single explanatory line, apply no label mutations, and exit 0. | P1 | Aligns with `advance.ts`'s AD-6 idempotency pattern. |
| FR-004 | The verb MUST refuse (no partial mutation, non-zero exit with evidence) when the issue's state is ambiguous or non-re-armable: multiple `failed:<phase>` labels, `failed:<phase>` where `<phase>` doesn't map to a known gate, or an existing `waiting-for:<other-gate>` that would conflict with the re-armed pair. Exit code parity with `advance.ts` (e.g. `CockpitExit` code 3 for the refusal path). | P1 | Fail-closed: never leave a half-mutated set of labels behind. |
| FR-005 | The `resume` verb MUST resolve its issue-ref argument via `resolveIssueContext` (not `parseIssueRef` alone), matching `status`/`watch`/`queue`/`context`/`advance` per #850. It MUST NOT be added to any ESLint `no-restricted-imports` allowlist that would let it call `parseIssueRef` directly. | P1 | Prevents a fresh regression of the #850 grammar-skew bug in a brand-new verb. |
| FR-006 | The `cockpit` command group in `packages/generacy/src/cli/commands/cockpit/index.ts` MUST register `resumeCommand()` alongside the six existing subcommands. The group's file header comment listing the verbs MUST be updated to include `resume`. | P1 | Registration parity — otherwise the verb ships but isn't reachable. |
| FR-007 | The package README (or the nearest README under the cockpit command tree) MUST document `cockpit resume`: purpose, ref forms accepted, exit codes, labels added/removed, idempotency semantics, refusal semantics. auto.md's D.7/D.8 rows link at this document as the contract source. | P1 | Per issue body: "Documented in the package README (auto.md's contract source)." |
| FR-008 | Unit tests MUST cover (a) the failed-issue happy path per phase suffix, (b) the non-failed no-op path, (c) each refusal branch under FR-004, and (d) the issue-ref grammar wiring (bare number, owner/repo#N, URL). The refusal branches MUST assert both the exit code and the evidence line — no silent failure. | P1 | Mirrors the `advance.test.ts` layout. |
| FR-009 | An end-to-end regression test MUST prove the poll-path handoff: given a `failed:validate` issue, invoking `resume` results in the label-monitor's next poll emitting a resume event and the worker resolving `startPhase = validate`. The test may stub the poll boundary but MUST assert on the labels the monitor sees and the phase the worker's startPhase resolver picks. | P1 | This is the "prove the by-hand surgery is now automated" test — the primary success signal of the change. |
| FR-010 | Log output for successful resume MUST name the phase re-armed and the four labels mutated (added/removed), on a single line, so a scripted caller (auto-mode Requeue) can capture and record it in the ledger. | P2 | Aligns with the ledger-note pattern in auto.md D.7/D.8. |

## Success Criteria

| ID     | Metric | Target | Measurement |
|--------|--------|--------|-------------|
| SC-001 | `generacy cockpit resume <ref>` is a reachable subcommand under `generacy cockpit`. | Exit 0 for `generacy cockpit resume --help`; the verb appears in `generacy cockpit --help` output. | Manual + integration test. |
| SC-002 | `cockpit resume` invoked on a `failed:validate` issue results in the issue being enqueued by the next label-monitor poll and the worker resolving `startPhase = validate`. | End-to-end regression test passes (FR-009). | `pnpm test` on the affected package. |
| SC-003 | `cockpit resume` invoked on a non-failed issue exits 0 with the no-op message and applies zero label mutations. | Assert on captured `gh` calls (zero mutating calls) and stdout. | Unit test (FR-008 b). |
| SC-004 | `cockpit resume` invoked on an ambiguous / non-re-armable issue exits non-zero with an evidence line and applies zero label mutations. | Assert on exit code and stderr; assert zero mutating `gh` calls. | Unit test (FR-008 c). |
| SC-005 | The package README documents `cockpit resume` with all fields listed in FR-007. | Doc block present; auto.md's D.7/D.8 rows have a target to link to. | Manual doc review. |
| SC-006 | Every issue-ref form accepted by sibling verbs (`bare number`, `owner/repo#N`, full URL) is accepted by `cockpit resume`. | 3 assertions in the resolver-wiring unit test (FR-008 d). | `pnpm test`. |
| SC-007 | Zero occurrences of `parseIssueRef` imported by `resume.ts` outside a `resolveIssueContext` call chain. | 0. | grep + ESLint rule from #850 already covers this — verify the new file inherits the rule scope. |

## Assumptions

- The `<phase> → <gate>` mapping used by the label monitor for resume detection already exists (or is trivially derivable from the label protocol) and can be imported or shared rather than re-derived. Planning phase owns whether to import the existing map or extract it into a shared module. If the mapping isn't a 1:1 identity (`failed:validate` → `waiting-for:validate` + `completed:validate` is the naive form), the exact table lives in the label monitor's resume-detection code and is authoritative.
- `resolveIssueContext` from #822 is the correct shared resolver — no new helper is needed for issue-ref parsing. The `resume` verb is a call-site change on top of the existing grammar.
- The auto-mode escalation gate (D.7/D.8 in auto.md) that consumes `cockpit resume` lives in a sibling change (agency#392 already specs its degradation-to-Skip when the verb is absent). This spec ships the primitive; the D.7/D.8 wiring update lands where the gate does. FR-009 proves the primitive end-to-end so the sibling wiring is a small connect-and-verify.
- The refusal path (FR-004) prefers explicit evidence over guessing. A single `failed:<phase>` with a matching gate is the well-defined re-arm case; anything else surfaces the labels present and refuses. This matches the "exit non-zero with evidence when the issue's state can't be re-armed" language in the issue body.
- The four label mutations in FR-002 do NOT need to be atomic across GitHub API boundaries. `gh` doesn't offer a multi-label transaction; ordering + best-effort with clear log lines is acceptable so long as a failure mid-sequence is surfaced (non-zero exit) and does not silently claim success.
- The package README under `packages/generacy/` or `packages/generacy/src/cli/commands/cockpit/` is the "package README (auto.md's contract source)" the issue body refers to — planning phase confirms the exact file and links auto.md's D.7/D.8 to it.

## Out of Scope

- Any change to auto-mode escalation semantics beyond enabling the Requeue action (the D.7/D.8 wording flip and Skip-degradation removal land where the auto-mode gate does).
- The re-validate-on-base-advance flow (filed separately in the issue body). Both consume the `resume` primitive, but this spec only ships the primitive.
- Changes to the label protocol itself (the `waiting-for:<gate>` / `completed:<gate>` resume-pair semantics, or the `failed:<phase>` label convention).
- Changes to the label-monitor's poll-path resume detection algorithm — the `resume` verb writes labels that satisfy the existing detector; no monitor changes.
- A `--force` flag for the refusal path (parity with `advance.ts` — no `--force` in v1).
- Any GitHub API "transaction" wrapper for the four-label mutation (see Assumptions).
- Cross-repo or multi-issue resume (`resume <ref1> <ref2>` batch mode). Single-issue only, matching `advance`.

---

*Generated by speckit — reviewed and enhanced 2026-07-09*
