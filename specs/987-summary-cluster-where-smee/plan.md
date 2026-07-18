# Implementation Plan: Flip monitors to webhook mode after smee receiver connects

**Feature**: On the auto-provisioned / persisted smee-channel path, the label / PR-feedback / merge-conflict / clarification-answer monitors currently stay stuck at fast adaptive poll cadence with `reason=webhooks-not-configured` because `webhooksConfigured` is frozen at construction time from the **static** `config.smee.channelUrl`. This plan adds a one-way runtime setter that `startSmeePipeline` calls **once the smee receiver reports `Connected`** — on **all** channel sources (static, persisted, provisioned).
**Branch**: `987-summary-cluster-where-smee`
**Status**: Complete

## Summary

Four surgical, spec-driven changes wire the runtime channel-resolution path (#952) through to the adaptive-poll controller (#953) so the four monitors flip out of "webhooks not configured" once the smee leg is live:

1. **Runtime setter on all four monitor services** (FR-001). Each of `LabelMonitorService`, `PrFeedbackMonitorService`, `MergeConflictMonitorService`, `ClarificationAnswerMonitorService` gains a one-way method `setWebhooksConfigured(true, opts?: { basePollIntervalMs?: number }): void` that (a) flips `state.webhooksConfigured = true`, (b) sets `state.basePollIntervalMs` and `state.currentPollIntervalMs` to `opts.basePollIntervalMs ?? state.basePollIntervalMs`, and (c) leaves `options.adaptivePolling` alone. There is **no `false` overload** (Q1=A).

2. **`startSmeePipeline` calls the setter after receiver connect** (FR-002). `SmeeWebhookReceiver` grows an `onConnected` callback in its options; it fires exactly once, after the `'Connected to smee.io channel'` log line. `startSmeePipeline` supplies a callback that calls `setWebhooksConfigured(true, { basePollIntervalMs: config.smee.fallbackPollIntervalMs })` on all four monitor references it now holds. Flip is on receiver-connect only — not gated on webhook-registration success (Q5=B).

3. **`ClarificationAnswerMonitorService` constructor symmetry** (FR-003). The hardcoded `webhooksConfigured: false` at `clarification-answer-monitor-service.ts:135` is replaced with an optional constructor arg `webhooksConfigured?: boolean = false` (matches `label-monitor-service.ts:99`); its inline `updateAdaptivePolling()` / `recordWebhookEvent()` bodies are replaced with delegations to the shared `decideAdaptivePoll` helper (matches the other three; makes FR-005's stale/recovered branches reachable). `server.ts:649-659` is updated to pass `config.smee.channelUrl != null` as the 10th positional arg, mirroring `server.ts:493` (Q4=C).

4. **Inbound-webhook wiring for all four monitors** (FR-004). `SmeeWebhookReceiver`'s constructor is widened to accept optional references to the other three monitors. On every successfully parsed inbound event whose repository is in `watchedRepos` (regardless of `x-github-event` type), the receiver calls `recordWebhookEvent()` on **all four** monitors. Per-event **processing** dispatch (label events → label monitor; `pull_request_review*` → PR-feedback; `issue_comment` → clarification-answer) is preserved / added only for the paths where the monitor exposes a processing entry point. The merge-conflict monitor stays poll-processed but its `recordWebhookEvent()` fires on every relevant inbound event so the Q2 staleness safety net is reachable.

The controller matrix (`adaptive-poll-controller.ts`) is **untouched** — this fix works by feeding it different inputs, not by changing its decision logic. All four monitors keep the `webhook-stale → to-fast` / `webhook-recovered → to-base` safety net (Q2=A rationale: once `webhooksConfigured=true`, the staleness/recovery branches govern regardless of `adaptivePolling`).

## Technical Context

- **Language / runtime**: TypeScript, Node ≥22, ESM
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator/`)
- **Test framework**: Vitest (existing suites: `packages/orchestrator/src/services/__tests__/`, `packages/orchestrator/src/routes/__tests__/`, `packages/orchestrator/src/__tests__/`)
- **New dependencies**: none. Reuses:
  - `decideAdaptivePoll` from `packages/orchestrator/src/services/adaptive-poll-controller.ts` (pure, extracted by #953)
  - `SmeeWebhookReceiver` from `packages/orchestrator/src/services/smee-receiver.ts`
  - `SmeeChannelResolver` from `packages/orchestrator/src/services/smee-channel-resolver.ts` (#952)
  - `config.smee.fallbackPollIntervalMs` on the existing `SmeeConfig` (verified — `packages/orchestrator/src/config/schema.ts`)
- **Type extensions**:
  - `SmeeReceiverOptions` gains `onConnected?: () => void` (fires once after the SSE connect log line).
  - `SmeeReceiverOptions` gains `prFeedbackMonitor?: PrFeedbackMonitorService`, `mergeConflictMonitor?: MergeConflictMonitorService`, `clarificationAnswerMonitor?: ClarificationAnswerMonitorService`.
  - Each monitor service exports a public `setWebhooksConfigured(configured: true, opts?: { basePollIntervalMs?: number }): void`.
- **Changeset**: `.changeset/987-monitors-webhook-flip-on-connect.md`, `patch` bump for `@generacy-ai/orchestrator` (defect fix; no new public export surface). Aligns with CLAUDE.md changeset rules (bug fix → `patch`; new internal setter is not re-exported from `index.ts`).

## Project Structure

Files to modify:

```
packages/orchestrator/src/
├── server.ts                                              # startSmeePipeline wiring + clarification arg (FR-002, FR-003)
├── services/
│   ├── smee-receiver.ts                                   # onConnected callback + multi-monitor refs + broad recordWebhookEvent dispatch (FR-002, FR-004)
│   ├── label-monitor-service.ts                           # setWebhooksConfigured(true, opts?) (FR-001)
│   ├── pr-feedback-monitor-service.ts                     # setWebhooksConfigured(true, opts?) (FR-001)
│   ├── merge-conflict-monitor-service.ts                  # setWebhooksConfigured(true, opts?) (FR-001)
│   └── clarification-answer-monitor-service.ts            # setWebhooksConfigured(true, opts?) + constructor arg + delegate to decideAdaptivePoll (FR-001, FR-003, FR-005)
└── __tests__/ or services/__tests__/                      # test additions/updates (below)

packages/orchestrator/src/services/__tests__/
├── smee-receiver.test.ts                                  # extend: onConnected fires once; recordWebhookEvent called on all four monitor refs; label/pr-review/issue_comment dispatch
├── label-monitor-service.test.ts                          # setWebhooksConfigured(true) flips state + adjusts interval, no adaptivePolling mutation
├── pr-feedback-monitor-service.test.ts                    # setWebhooksConfigured(true) semantics; webhook-stale still reachable post-flip
├── merge-conflict-monitor-service.test.ts                 # setWebhooksConfigured(true) semantics + recordWebhookEvent path
└── clarification-answer-monitor-service.test.ts           # setWebhooksConfigured(true) semantics + decideAdaptivePoll delegation regression

packages/orchestrator/src/routes/__tests__/
└── webhooks.test.ts / pr-webhooks.test.ts                 # (unchanged; assert existing calls still stand)

.changeset/
└── 987-monitors-webhook-flip-on-connect.md                # patch bump (defect fix)
```

New spec artifacts:

- `specs/987-summary-cluster-where-smee/plan.md` (this file)
- `specs/987-summary-cluster-where-smee/research.md`
- `specs/987-summary-cluster-where-smee/data-model.md`
- `specs/987-summary-cluster-where-smee/contracts/setter-contract.md`
- `specs/987-summary-cluster-where-smee/contracts/smee-receiver-contract.md`
- `specs/987-summary-cluster-where-smee/quickstart.md`

Out of scope (per spec §"Out of Scope"):

- Bidirectional `setWebhooksConfigured(false, …)` — the controller's `webhook-stale → to-fast` branch already covers receiver-death (Q1=A, Q2=A).
- Refactoring monitor construction to defer until after channel resolution — runtime setter is the surgical fix.
- Any change to `adaptive-poll-controller.ts` decision logic.
- Companion operator-doorbell reuse of the same channel (generacy-ai/generacy#988).
- Cloud-side or webhook-registration path changes (#952, #972).

## Constitution Check

No `.specify/memory/constitution.md` in the tree — check skipped. Adhered to project CLAUDE.md conventions:

- **Changeset gate**: `.changeset/987-monitors-webhook-flip-on-connect.md` added (`patch` — bug fix, `workflow:speckit-bugfix` semantics). Non-test-only diff under `packages/orchestrator/src/` requires a changeset per CLAUDE.md.
- **No new comments unless load-bearing**: Q1=A / Q2=A rationale ("setter is one-way; `adaptivePolling` stays on so the staleness safety net is reachable") *is* load-bearing — future readers will be tempted to also set `adaptivePolling=false` inside the setter and revert the fix. Keep a one-line comment on the setter body pointing to the clarifications file. Nothing else added.
- **No premature abstraction**: the setter is a per-service method, not a shared interface. The four monitors already have divergent constructor shapes (`MonitorConfig` vs `PrMonitorConfig`; `phaseTracker` on label monitor only); a shared `WebhookAwareMonitor` interface is not required and would spread blast radius. Four identical ~10-line method bodies are cheaper than an abstraction.
- **No feature flags**: the fix corrects a bug; there is no gated rollout. Old behavior (fast-poll on smee-less clusters) is preserved because the setter is only invoked from `startSmeePipeline`, which is not called when no channel is resolvable.

## Key Decisions

| # | Decision | Source |
|---|----------|--------|
| 1 | Setter is one-way (`setWebhooksConfigured(true, …)`). No `false` overload. TypeScript literal type `true` enforces the constraint at the call site. | Q1=A |
| 2 | Setter does **not** modify `options.adaptivePolling`. The controller only consults `adaptivePolling` in the `!webhooksConfigured` branch (`adaptive-poll-controller.ts:106`); once `webhooksConfigured=true` the staleness/recovery branches govern regardless. | Q2=A |
| 3 | Setter is fired **after** the smee receiver reports `Connected`, not at `startSmeePipeline` entry and not gated on webhook-registration success. | Q5=B |
| 4 | FR-004 wiring is in scope from day one. Any missing `recordWebhookEvent()` call from the inbound dispatcher (currently: PR-feedback / merge-conflict / clarification-answer via smee) is wired in this PR — otherwise the Q2 staleness safety net is unreachable for those monitors. | Q3=A |
| 5 | `ClarificationAnswerMonitorService` constructor gains an optional-with-default `webhooksConfigured?: boolean = false` parameter (matches `label-monitor-service.ts:99`); `server.ts` passes `config.smee.channelUrl != null` explicitly (matches `server.ts:493`). Not a required parameter. | Q4=C |
| 6 | The smee receiver calls `recordWebhookEvent()` on **all four** monitors for every parsed inbound event whose repo matches `watchedRepos`, regardless of `x-github-event` type. Rationale: the staleness safety net only needs `lastWebhookEvent` to be non-null; per-monitor gating would leave the merge-conflict monitor's safety net dead again (there is no natural "merge-conflict event" family on GitHub webhooks). This is a wider fan-out than per-event dispatch, but it costs one method call per event and gives all four the Q2 safety net for free. | FR-004 + spec §"Root cause" (staleness dependency) |
| 7 | Per-event **processing** dispatch is added to smee receiver only where the monitor exposes a natural entry point: `pull_request_review` / `pull_request_review_comment` → `PrFeedbackMonitorService.processPrReviewEvent`; `issue_comment.created` → `ClarificationAnswerMonitorService.processClarificationAnswerEvent`. Merge-conflict processing stays on the poll path — a webhook doesn't carry the "waiting-for:merge-conflicts + agent:paused" combo directly. | Minimum-diff over full parity |
| 8 | `ClarificationAnswerMonitorService.recordWebhookEvent()` and `updateAdaptivePolling()` are rewritten to delegate to `decideAdaptivePoll` (matches the other three). This is required for FR-005: the current inline logic doesn't emit `webhook-stale` / `webhook-recovered` transitions and never returns `quiet` — so without this rewrite the flipped state's staleness escalation is unreachable on the clarification monitor. | FR-005 |
| 9 | Setter also updates `state.basePollIntervalMs`, not just `state.currentPollIntervalMs`. Rationale: the controller's `webhook-recovered → to-base` branch resets `currentPollIntervalMs` to `basePollIntervalMs`; if we only update `currentPollIntervalMs`, a later recovery would return the monitor to the **construction-time** interval (which for smee-less-then-provisioned is the fast base of ~30s, not `fallbackPollIntervalMs`). Both fields must be aligned. | Direct read of `adaptive-poll-controller.ts:142-149` |
| 10 | The `onConnected` callback fires exactly once per receiver instance, on the first successful SSE connect. Subsequent reconnects (`this.reconnectAttempt = 0`) do **not** re-invoke it. Callers rely on the setter's idempotence (setting `webhooksConfigured=true` twice is a no-op), but firing once is cheaper and semantically clearer. | Spec §"Proposed fix" — "once the smee receiver reports Connected" reads as edge, not level |
| 11 | Direct-HTTP webhook paths (`routes/webhooks.ts`, `routes/pr-webhooks.ts`) are **not** changed. They already call `recordWebhookEvent()` on their target monitor. FR-004 is satisfied for the smee-primary path (which is the entire bug). Direct-HTTP paths for merge-conflict and clarification-answer are a follow-up (`#988`-adjacent) — the bug in scope for #987 is the smee-provisioned cluster. | Spec framing: "auto-provisioned … the #952 path" |
| 12 | Changeset is `patch` for `@generacy-ai/orchestrator` (defect fix per `CLAUDE.md`). No new export from any package `index.ts`. | `CLAUDE.md` §Changesets |

## Next Step

Run `/speckit:tasks` to generate the task list with dependency ordering. Suggested parallelization:

- FR-001 (`setWebhooksConfigured` on each of four services) is four independent leaf edits — can go in parallel.
- FR-003 (clarification-answer constructor + decideAdaptivePoll delegation) depends on nothing but its own file; can go in parallel with FR-001 items for the other three services.
- FR-002 (`SmeeWebhookReceiver.onConnected` + broad `recordWebhookEvent` fan-out) depends on FR-001 setters existing so the callback body compiles.
- FR-005 test additions depend on FR-001, FR-002, FR-003 all landing.
- The `server.ts` construction-site edit (passing `config.smee.channelUrl != null` to `ClarificationAnswerMonitorService`, passing the three extra monitor refs + `onConnected` into `SmeeWebhookReceiver`, holding refs to all four monitors for the callback closure) is the join point — one edit, after all four setters and the receiver callback API exist.
