# Clarifications for #1080 — re-justify `cockpit_gate_list`'s `runId` drop

## Batch 1 — 2026-07-29

### Q1: Test seam
**Context**: FR-003 / SC-003 says the guard test must "assert `client.listGates` was called *without* `runId` on its query argument (spy/mock the cloud client at the seam, not the wire)". The suite already has a passing guard at `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts:234-247` — but it works one level below the seam (it spies `fetchImpl` and asserts `expect(url).not.toContain('runId=')`). That is wire-level, not client-level. Which shape does implementation ship?
**Question**: How should the guard test satisfy FR-003 / SC-003?
**Options**:
- A: Leave the existing URL-check test as-is (rename its description away from any 400 rationale wording) and add a **new** test alongside it that spies `client.listGates` directly (mock `createGateQueryClient`), asserting the argument object has no `runId` property.
- B: Rewrite the existing test to mock `createGateQueryClient` and spy `client.listGates`, replacing the URL check. Only one guard remains.
- C: Keep the URL check as the only guard, treat "outbound URL never carries `runId=`" as an acceptable seam per SC-003, and only update the surrounding describe/test descriptions to name the agency#471 rationale.

**Answer**: *Pending*

### Q2: Docblock strategy on `CockpitGateListInputSchema.runId`
**Context**: FR-002 offers two shapes for the field docblock at `query-schemas.ts:65-75` — either restate the full agency#471 rationale in prose, or delete field-level prose and cross-link to the handler-site comment as the single source of truth. Two independent prose sites raise a drift risk (this issue exists because prose drifted from behavior once already).
**Question**: What shape should the `CockpitGateListInputSchema.runId` docblock take after the fix?
**Options**:
- A: Keep an independent full prose docblock on the schema field that mirrors the handler-site rationale. Both sites carry the full explanation; reviewers must keep them in sync.
- B: Shrink the docblock to one line ("Accepted for MCP-surface parity with `cockpit_gate_status`. Handler drops it before the cloud call — see `tools/cockpit_gate_list.ts` for rationale.") with the handler comment as the sole source of truth for the *why*.
- C: Some hybrid — brief one-sentence rationale on the schema, cross-link to handler for the long form.

**Answer**: *Pending*

### Q3: Fate of the handler comment's secondary sentences
**Context**: The current handler comment at `cockpit_gate_list.ts:50-60` carries three secondary sentences beyond the (now-stale) refine claim:
  (a) "The schema accepts `runId` for MCP-surface parity with `cockpit_gate_status`, but the handler MUST NOT propagate it"
  (b) "does NOT emit the `runIdSource` log line per Q3=C"
  (c) "Cloud follow-up for a list-mode `runId` filter is a separate generacy-cloud issue"
Sentences (a) and (b) are still factually true after generacy-cloud#894. Sentence (c) is now stale (the follow-up shipped as #894 and applies `where('runId', '==', X)` as a real filter — that is precisely what makes forwarding worse than dropping).
**Question**: Which secondary sentences survive the rewrite?
**Options**:
- A: Keep (a) and (b) verbatim; rewrite (c) to note the cloud filter shipped in generacy-cloud#894 and that this handler still declines to forward.
- B: Keep (a) and (b); delete (c) outright (the new primary paragraph already establishes that forwarding is a behaviour change requiring a named consumer).
- C: Delete all three; the new comment focuses only on the agency#471 rationale and the parity/log-line details are considered code-review-obvious.

**Answer**: *Pending*

### Q4: Extension-path prescription
**Context**: US1 AC bullet 3 ("adding an explicit opt-in for run-scoped list is the correct extension path if a future consumer needs it, not removing the drop") is a design-intent statement. The comment can express this at three levels of specificity, and the level affects what a future consumer will read as prescribed vs advisory.
**Question**: How specific should the extension-path guidance be in the new handler comment?
**Options**:
- A: Abstract — "adding an explicit opt-in for run-scoped list is the correct extension path if a future consumer needs it, not removing the drop" (verbatim spec wording, no shape).
- B: Prescribe a shape — name a concrete opt-in (e.g., a `runScoped: true` flag on the same tool, OR a separate `cockpit_gate_list_by_run` MCP tool). The comment commits to one of these as the recommended shape.
- C: Omit — the comment justifies the drop only and leaves the extension shape to the future consumer's spec. No forward-looking sentence in the code.

**Answer**: *Pending*

### Q5: Verbatim vs paraphrase for the replacement paragraph
**Context**: The issue Ask #1 supplies a fully-drafted 4-sentence replacement paragraph. It reads as prose (dashes, "which is exactly why", "not a cleanup"). The spec says "Verbatim replacement text is provided in the issue Ask #1" (FR-001 Notes). Code comments in this file use a compressed voice (see the observer-independence header at lines 10-15 and the current `#1067` comment).
**Question**: Should the new comment be verbatim from the issue or paraphrased into code-comment voice?
**Options**:
- A: Verbatim — copy the issue Ask #1 paragraph into the comment as-is (adapted only for `//` line-prefix), preserving all four sentences and stylistic dashes. Load-bearing facts and prose byte-identical to the issue.
- B: Paraphrase — same load-bearing facts (drop is policy, cloud accepts `?runId=` as of #894, agency#471 startup-sweep depends on run-agnostic visibility, forwarding is a behaviour change requiring a named consumer) but rewritten to match the compressed voice of adjacent comments in this file.
- C: Verbatim with an appended per-file convention line (e.g., a leading `#1080 —` tag prefix and a trailing SC-002 anchor comment naming `agency#471` / `startup-sweep` explicitly for the grep gate).

**Answer**: *Pending*
