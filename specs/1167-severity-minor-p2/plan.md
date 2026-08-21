# Implementation Plan: Reconcile review/remediate docs with shipped behavior

**Feature**: Correct four documentation inaccuracies, one residual stale code comment, and four cosmetic enumeration omissions so published docs, in-repo comments, and gate/type enumerations match the shipped review/remediate behavior. No runtime behavior change.
**Branch**: `1167-severity-minor-p2`
**Status**: Complete

## Summary

Severity **minor (P2)** — documentation + cosmetic sync only. The #1136 closeout
docs for the engine-native review/remediate epic (generacy-ai/generacy#1120)
describe *planned* behavior where the epic shipped something narrower. This is the
pure-reconciliation remainder of the post-merge doc audit; the functional gaps it
surfaced are tracked in #1160 (config keys) and #1161 (blockingSeverity default)
and are **out of scope here**.

The branch was cut from `ea0b2437` (= #1161), newer than the spec's originally
cited `155b3464`. Per Q1 the audit is **re-anchored to current branch HEAD**:
FRs whose cited inaccuracy is already gone are verify-and-skip no-ops
(FR-005, FR-007, FR-011), FR-006 is verify-and-fix (residual wording only), and
only what remains inaccurate is changed. The source of truth is the cited
*symbol*, not the line number.

## Technical Context

- **Language/stack**: TypeScript (pnpm monorepo). Docs are Docusaurus Markdown under `docs/`.
- **No new dependencies.** No new files. All edits are in-place to existing docs, comments, and two enumeration constants + one type union.
- **Verification substrate**: existing test suite (must pass unchanged — SC-004) plus targeted grep assertions against the cited source symbols.
- **Constitution**: no `.specify/memory/constitution.md` in the repo → constitution check skipped.

### Grounded source-of-truth verification (done at plan time, HEAD = `4b6f8576`/`ea0b2437` base)

| Claim | Cited symbol | Verified value at HEAD |
|-------|--------------|------------------------|
| Auto-narrowing is bugfix-only | `phase-loop.ts:698` | `if (context.item.workflowName === 'speckit-bugfix')` — feature never narrows |
| Precedence tiers | `config.ts:73-77` | repo tier **only** for `validateCommand`/`preValidateCommand`; `maxRemediations`/`ciWaitTimeoutMs`/`review.*` are workflow → built-in default (no repo tier) |
| Default validate command | `config.ts:38` | `DEFAULT_VALIDATE_COMMAND = 'pnpm test && pnpm build'` |
| `blocked:stuck-feedback-loop` live | `pr-feedback-handler.ts:45,617-624,1239-1261` | re-applied on the flag-OFF PR-feedback path — not retired |
| FR-005 comment gone | `claude-cli-worker.ts` | grep for "will supply the reader" → 0 hits (resolved by #1156) |
| FR-006 residual wording | `phase-loop.ts:135`, `phase-loop.ts:1753` | "dead in production; concrete triggers land in later epic issues" / "dead in production (FR-007/D-5)" — stale, concrete trigger landed at `claude-cli-worker.ts:969` |
| FR-007 comment accurate | `config.ts:76` | already documents per-workflow override precedence (#1160) |
| FR-011 single round source | `seed-aware-review-executor.ts:73,90,102` | `round = (prior?.round ?? 0) + 1` stamped into both finding.round and artifact.round; no `round: 0` literal |
| `WAITING_PIPELINE_ORDER` | `precedence.ts:26-57` | ends `waiting-for:implementation-review`, `waiting-for:manual-validation`; no new gates |
| `STAGE_COMPLETE_PIPELINE_ORDER` | `precedence.ts:71-85` | starts `completed:implementation-review`; no `completed:validate`/`review`/`remediate` |
| `ReviewGate` union | `github.ts:256-265` | lacks `remediation-limit` and `ci` |

## Scope of edits

### Documentation (FR-001 – FR-004)

**`docs/docs/guides/generacy/review-remediate-migration.md`**
- **FR-001**: `### Guardrails when the default command is auto-narrowed` (§2, lines ~50-71). Scope the whole diff-classification/auto-narrowing description to `speckit-bugfix` only. Feature workflow reaches the plain default unchanged — make that explicit so an operator does not expect narrowing on a feature run.
- **FR-003**: line ~52-53 — change the quoted built-in default from `pnpm build && pnpm test` to `pnpm test && pnpm build` (matches `DEFAULT_VALIDATE_COMMAND`).
- **FR-002**: §3 lines ~76-78 — correct the blanket "falls through to the repo-level `orchestrator.*` value, then the cluster default." The repo tier exists **only** for `validateCommand`/`preValidateCommand`; `maxRemediations`, `ciWaitTimeoutMs`, and `review.*` resolve workflow → built-in default (no repo tier).
- **FR-004**: §5 lines ~140-142 — remove the "retired"/"replaces" framing per Q5→A. Reword `blocked:stuck-feedback-loop` as the legacy pre-epic (flag-OFF) bounded stop still active when the review phase is disabled, and frame `waiting-for:remediation-limit` as the resumable flag-ON equivalent. Preserve the flag-OFF/flag-ON contrast.

**`docs/docs/reference/bugfix-profile-config.md`**
- **FR-002**: §Precedence lines ~69-73 — same correction. "Per-workflow settings resolve workflow → repo → cluster default" is only true for the two `*Command` keys; `maxRemediations` and the `review.*` sub-fields resolve workflow → built-in review baseline with no repo tier.

### Code comments (FR-005 – FR-007)

**`packages/orchestrator/src/worker/phase-loop.ts`** (FR-006, verify-and-fix)
- Comment block at ~line 132-139 (`remediateTrigger?` doc): drop "Defaults undefined → dead in production; concrete triggers land in later epic issues." Reword so it scopes deadness to the *undefined default* only — a concrete `remediateTrigger` did land (`claude-cli-worker.ts:969`); the seam is live in production when wired.
- Inline comment at ~line 1753 (`Defaults undefined → dead in production (FR-007/D-5).`): same — scope to the undefined default, not "dead in production" unconditionally.

- **FR-005** (verify-and-skip): confirmed the "#1124 will supply the reader" comment no longer exists in `claude-cli-worker.ts` (grep 0 hits). Note resolved in the PR; no edit.
- **FR-007** (verify-and-skip): confirmed `config.ts:76` already documents the `ciWaitTimeoutMs` per-workflow override precedence. Note resolved in the PR; no edit.

### Enumerations (FR-008 – FR-011)

**`packages/cockpit/src/state/precedence.ts`**
- **FR-008** (`WAITING_PIPELINE_ORDER`, earlier-index-wins, Q2→A): insert `'waiting-for:remediation-limit'` immediately after `'waiting-for:implementation-review'`; append `'waiting-for:ci'` at the very end (after `'waiting-for:manual-validation'`).
- **FR-009** (`STAGE_COMPLETE_PIPELINE_ORDER`, latest-phase-wins, Q3→A): insert `'completed:validate'` at index 0, then `'completed:implementation-review'`, `'completed:remediate'`, `'completed:review'`, `'completed:implement'`, … (validate at top; remediate before review, both between implementation-review and implement).

**`packages/workflow-engine/src/types/github.ts`**
- **FR-010** (`ReviewGate` union, line ~256): add `| 'remediation-limit'` and `| 'ci'`.

- **FR-011** (verify-and-skip): confirmed `seed-aware-review-executor.ts` uses a single `round` source; no `round: 0` literal. Note resolved in the PR; no edit.

## Constitution Check

No `.specify/memory/constitution.md` present → skipped. The change is docs/comments/enumeration-ordering only, introduces no new runtime paths, and adds no dependencies, so it carries no architectural risk to gate against.

## Risk & non-goals

- **SC-004 (zero behavior change)** is the binding constraint. Enumeration edits change only *tie-break ordering* when multiple labels coexist (making it deterministic instead of falling back to the `WORKFLOW_LABELS` index); the `ReviewGate` union widening is type-surface-only. No gate *semantics*, config resolution, or phase-loop control flow changes.
- The `precedence.ts` label strings must exactly match the emitted labels (`waiting-for:remediation-limit`, `waiting-for:ci`, `completed:validate`, `completed:review`, `completed:remediate`) — a typo would silently keep the default-fallback ordering. Cross-checked against the shipped label vocabulary.
- Out of scope: #1160 config wiring, #1161 blockingSeverity default, any review/remediate runtime behavior, and any doc rewrite beyond the four cited inaccuracies.

## Changeset

Docs and code comments are non-behavioral. The enumeration edits touch
`packages/cockpit/src/state/precedence.ts` and
`packages/workflow-engine/src/types/github.ts` — non-test files under
`packages/*/src/`, so the changeset gate applies. Add a single
`.changeset/1167-reconcile-review-remediate-docs.md`:
- `@generacy-ai/cockpit` **patch** — deterministic ordering additions, no new public export.
- `@generacy-ai/workflow-engine` **patch** — `ReviewGate` union widened with two existing gate labels; internal type completeness, no new capability (new label *vocabulary* is not introduced here — the labels already ship from #1124/#1133; this only lists them in the union).

Single file, both bumps. Docs-only edits do not themselves trigger the gate;
the two `src/` enumeration edits do.

## Next step

`/speckit:tasks` to generate the dependency-ordered task list.
