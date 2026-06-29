# Clarifications: Journal-based stuck detection (G5.2)

**Issue**: generacy-ai/generacy#793
**Branch**: `793-epic-generacy-ai-tetrad`

These questions resolve the ambiguities flagged in `spec.md` § _Open Questions / Clarification Targets_. Each lists the proposed default the implementor will use if no override is given.

---

## Batch 1 — 2026-06-29

### Q1: Missing-journal policy
**Context**: An issue can be labelled `agent:in-progress` while its journal file does not yet exist (queued / just-dispatched worker, or a worker that crashed before its first write). FR-006 needs a deterministic rule. This decision drives whether `watch` needs to track "time the issue acquired `agent:in-progress`" — a structural addition to the poll-state carried across iterations.
**Question**: When `agent:in-progress` is set but `.agency/conversations/{n}/journal.jsonl` does not exist, when (if ever) should the cockpit flag the issue as stuck?
**Options**:
- A: Never flag a missing-journal issue. `stuck=false`, `stuckReason=null`. (most conservative; proposed default)
- B: Flag as stuck only after `gracePeriodMinutes` have elapsed since the issue gained `agent:in-progress` and no journal file exists. (requires watch to track label-acquisition time)
- C: Flag as stuck immediately on first observation. `stuck=true`, `stuckReason='no-journal'`.

**Answer**: *Pending*

---

### Q2: Recovery event semantics
**Context**: FR-005 says watch emits a `recovered` event on the transition `stuck → not-stuck-but-still-in-progress`. There are two distinct ways the stuck state ends: (a) the journal's last-entry timestamp moves forward; (b) the issue leaves `agent:in-progress` (any label change). The existing `label-change` event already covers (b). Question is whether `recovered` should also fire for (b) — i.e., whether consumers see one event or two for a label-driven recovery.
**Question**: When a stuck issue leaves `agent:in-progress` (label change), should watch also emit a separate `recovered` event in addition to the existing `label-change` event?
**Options**:
- A: No — `recovered` fires only on case (a) (journal advance). Case (b) is handled by the existing `label-change` event. Watch deduplicates so consumers never see double-fires. (proposed default)
- B: Yes — `recovered` fires for both (a) and (b). Consumers get a uniform "stuck cleared" signal regardless of cause.

**Answer**: *Pending*

---

### Q3: Journal file location authority
**Context**: The issue specifies `.agency/conversations/{n}/journal.jsonl` as the read path. The orchestrator's existing `ConversationLogger` writes to `specs/{issue-number}/conversation-log.jsonl`. Cockpit is a read-only sensor (FR-009) and cannot move the writer. If cockpit reads the wrong location it sees zero journal entries and (per Q1's default) never flags anything — silent failure.
**Question**: Which path should cockpit's journal module treat as canonical for this feature?
**Options**:
- A: `.agency/conversations/{n}/journal.jsonl` exactly as the issue specifies. Cockpit will appear empty until a separate issue migrates the orchestrator writer. (proposed default; cleanest API surface)
- B: `specs/{n}/conversation-log.jsonl` to match the current writer. Cockpit works today; the issue's wording is treated as aspirational.
- C: Both — journal module accepts a configurable list of candidate paths and uses the most recently modified one. (most resilient; widest surface)

**Answer**: *Pending*

---

### Q4: Stuck-reason taxonomy
**Context**: FR-004 defines `stuckReason` as `'stale' | 'no-journal' | null`. FR-008 mentions a possible future `'journal-error'` value for unreadable / corrupt files. Adding it now requires consumers (status renderer, watch event schema, `--json` consumers) to handle three reason values; folding it into `'no-journal'` keeps two.
**Question**: When the journal file exists but cannot be read or parsed (EACCES, EBUSY, every line malformed JSON), what `stuckReason` should the cockpit report?
**Options**:
- A: `'no-journal'` — same as missing-file. Operators only care that there is no liveness signal; the cause is in the stderr log line. (proposed default)
- B: `'journal-error'` as a third distinct value. Operators can visually distinguish "never wrote a journal" from "wrote a journal we cannot read."

**Answer**: *Pending*

---

### Q5: Per-invocation CLI override
**Context**: FR-007 puts the threshold in `.generacy/config.yaml`. Operators sometimes want to override it for a single one-shot run ("show me anything idle for 5 minutes, just this once") without editing config. Adding a CLI flag is cheap (`--stuck-threshold <minutes>` on `status` and `watch`); deferring it keeps the first cut smaller.
**Question**: Should `cockpit status` and `cockpit watch` accept a `--stuck-threshold <minutes>` flag in this iteration?
**Options**:
- A: No — config-only for the first cut. Add the CLI flag in a follow-up if operators ask for it. (proposed default)
- B: Yes — add `--stuck-threshold <minutes>` on both commands. Flag overrides config when set; config overrides default when set.

**Answer**: *Pending*

---

*Generated by /clarify*
