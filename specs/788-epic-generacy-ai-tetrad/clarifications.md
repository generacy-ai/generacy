# Clarifications: G1.2 — `cockpit state` + `advance` + `clarify-context`

**Issue**: generacy-ai/generacy#788
**Branch**: `788-epic-generacy-ai-tetrad`

---

## Batch 1 — 2026-06-26

### Q1: Manual-advance marker mechanism
**Context**: FR-007 says `cockpit advance` must mark the completion as manual so downstream watchers can distinguish it from agent-driven completions, but the spec defers the exact format to the plan. The choice has visible downstream consequences: an issue comment is human-readable but adds noise; a body marker is cheap but couples to issue body parsing; a label suffix is queryable but extends the label vocabulary (which Out of Scope says we are NOT extending).
**Question**: How should a manual advance be marked?
**Options**:
- A: Post an issue comment (e.g., `<!-- generacy-cockpit:manual-advance gate=<name> actor=<gh-login> -->` plus a short human-readable line) when adding `completed:<name>`. No label vocabulary change.
- B: Append a hidden HTML marker (`<!-- generacy-cockpit:manual-advance ... -->`) to the issue body. Single source, but mutates the body and conflicts with stage trackers.
- C: Both: comment for human visibility AND a structured marker line in the comment body that downstream tooling greps for.
- D: Other (please specify).

**Answer**: Manual-advance marker mechanism
**Context**: FR-007 requires `cockpit advance` to mark the completion as manual but defers the format to the plan. Choice has downstream consequences: comments are human-readable but noisy; body markers couple to body parsing; label suffixes extend label vocabulary (which Out of Scope says we are NOT extending).

**Question**: How should a manual advance be marked?
- **A**: Post an issue comment (e.g., `<!-- generacy-cockpit:manual-advance gate=<name> actor=<gh-login> -->` plus a short human-readable line) when adding `completed:<name>`. No label vocabulary change.
- **B**: Append a hidden HTML marker to the issue body. Single source, but mutates the body and conflicts with stage trackers.
- **C**: Both: comment for human visibility AND a structured marker line in the comment body that downstream tooling greps for.
- **D**: Other (please specify).

---

---

### Q2: `clarify-context` — "relevant code references" payload shape
**Context**: FR-009 requires the JSON document to include "code references (touched files / open PR diff)" but does not pin the shape. This drives the consumer schema, the payload size budget, and how the command discovers code (open PR, branch-name lookup, working-tree diff). The clarification skill that consumes this will branch on whichever schema we pick.
**Question**: What shape should the `codeReferences` field take?
**Options**:
- A: `{ touchedFiles: string[], prUrl: string | null, prDiffSummary: string | null }` — file paths plus a short text summary of the PR diff (e.g., `gh pr diff --name-only` + a short stat block). No raw diff blob. Bounded size.
- B: `{ touchedFiles: string[], prUrl: string | null, diff: string | null }` — same plus the full unified diff (subject to a max-bytes cap), so the clarifier has the actual code change to reason over.
- C: `{ files: Array<{ path: string, status: 'added'|'modified'|'deleted', hunks?: string }> }` — structured per-file entries; richer schema, more code in the command.
- D: Other (please specify).

**Answer**: `clarify-context` — "relevant code references" payload shape
**Context**: FR-009 requires "code references (touched files / open PR diff)" but does not pin the shape. Drives the consumer schema, payload size budget, and how the command discovers code.

**Question**: What shape should the `codeReferences` field take?
- **A**: `{ touchedFiles: string[], prUrl: string | null, prDiffSummary: string | null }` — file paths plus a short text summary of the PR diff. No raw diff blob. Bounded size.
- **B**: `{ touchedFiles: string[], prUrl: string | null, diff: string | null }` — same plus the full unified diff (subject to a max-bytes cap), so the clarifier has the actual code change to reason over.
- **C**: `{ files: Array<{ path: string, status: 'added'|'modified'|'deleted', hunks?: string }> }` — structured per-file entries; richer schema, more code in the command.
- **D**: Other (please specify).

---

---

### Q3: `clarify-context` — which comment is "the clarification comment"?
**Context**: US3 acceptance says the JSON must contain "the clarification comment (text + author + timestamp)". An open `waiting-for:clarification` issue typically has the bot's posted question comment, possibly older clarification rounds, and any developer chatter. The selection heuristic is implementation-defining: misidentifying the comment makes the whole payload useless to the clarification skill.
**Question**: How should `cockpit clarify-context` identify "the clarification comment" on the issue?
**Options**:
- A: The most recent comment authored by the orchestrator/bot (resolved via cockpit config) whose body matches a clarification marker (e.g., contains `<!-- generacy-clarify -->` or starts with `## Clarifications`).
- B: The most recent comment posted at-or-after the `waiting-for:clarification` label was last applied (label-event timestamp lookup), regardless of author.
- C: All comments since the most recent `waiting-for:clarification` label application, as an array (let the consumer pick).
- D: Other (please specify).

**Answer**: `clarify-context` — which comment is "the clarification comment"?
**Context**: US3 says the JSON must contain "the clarification comment (text + author + timestamp)". An open `waiting-for:clarification` issue typically has the bot's posted question, possibly older clarification rounds, and any developer chatter. Misidentifying it makes the payload useless.

**Question**: How should `cockpit clarify-context` identify "the clarification comment"?
- **A**: The most recent comment authored by the orchestrator/bot whose body matches a clarification marker (e.g., contains `<!-- generacy-clarify -->` or starts with `## Clarifications`).
- **B**: The most recent comment posted at-or-after the `waiting-for:clarification` label was last applied (label-event timestamp lookup), regardless of author.
- **C**: All comments since the most recent `waiting-for:clarification` label application, as an array (let the consumer pick).
- **D**: Other (please specify).

---

---

### Q4: Scope of `--force` override on `cockpit advance`
**Context**: FR-006 says `cockpit advance` refuses to advance a gate that is not the active `waiting-for:*`, then parenthetically lists `--force` as P2. P2 is ambiguous: it might mean "ship in v1 but de-prioritized", or "explicitly out of scope for v1". Without a decision, the implementer either builds (and tests) the flag or leaves it out, both legitimate readings. SC-001 / tests depend on this.
**Question**: Should `--force` be implemented in this issue (v1) or deferred to a follow-up?
**Options**:
- A: Implement `--force` in v1 — bypasses the active-gate check, still emits the manual-advance marker, and is exercised by at least one integration test.
- B: Defer `--force` to a follow-up issue — v1 has no override; mis-typed or out-of-order gates always exit non-zero with the valid-gate list.
- C: Implement `--force` as a stub that always errors with "not yet supported" so the flag exists in `--help` but is not functional yet.

**Answer**: Scope of `--force` override on `cockpit advance`
**Context**: FR-006 lists `--force` parenthetically as P2. Without a decision, the implementer either builds the flag or leaves it out — both legitimate readings. SC-001 / tests depend on this.

**Question**: Should `--force` be implemented in this issue (v1) or deferred?
- **A**: Implement `--force` in v1 — bypasses the active-gate check, still emits the manual-advance marker, exercised by at least one integration test.
- **B**: Defer `--force` to a follow-up issue — v1 has no override; mis-typed or out-of-order gates always exit non-zero with the valid-gate list.
- **C**: Implement `--force` as a stub that always errors with "not yet supported" so the flag exists in `--help` but is not functional yet.

---

---

### Q5: Issue identifier resolution when multiple `MONITORED_REPOS` are configured
**Context**: FR-003 says the command accepts `<number>`, `<owner>/<repo>#<number>`, or full URL, and resolves the bare-number form via the cockpit config. The config's `MONITORED_REPOS` is a list, so a bare `788` is ambiguous when more than one repo is monitored. The resolution rule affects UX (terse vs. always-qualified) and the error message for misuse.
**Question**: How should a bare `<number>` resolve when the config lists multiple repos?
**Options**:
- A: Require the bare-number form only when exactly one monitored repo is configured; otherwise exit non-zero asking for `<owner>/<repo>#<number>` or URL form.
- B: Search every configured monitored repo for an issue with that number; if exactly one matches, use it; if zero or >1 match, exit non-zero with the candidate list.
- C: Use the first repo in `MONITORED_REPOS` order; document this and accept the foot-gun.
- D: Other (please specify).

**Answer**: Issue identifier resolution when multiple `MONITORED_REPOS` are configured
**Context**: FR-003 accepts `<number>`, `<owner>/<repo>#<number>`, or full URL and resolves the bare-number form via the cockpit config. `MONITORED_REPOS` is a list, so `788` is ambiguous when more than one repo is monitored.

**Question**: How should a bare `<number>` resolve when the config lists multiple repos?
- **A**: Require the bare-number form only when exactly one monitored repo is configured; otherwise exit non-zero asking for `<owner>/<repo>#<number>` or URL form.
- **B**: Search every configured monitored repo for an issue with that number; if exactly one matches, use it; if zero or >1 match, exit non-zero with the candidate list.
- **C**: Use the first repo in `MONITORED_REPOS` order; document this and accept the foot-gun.
- **D**: Other (please specify).

---

_Posted by `/clarify` for issue #788._
