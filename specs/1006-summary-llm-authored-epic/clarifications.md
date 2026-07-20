# Clarifications

## Batch 1 — 2026-07-19

### Q1: Phase-shaped heading rule (FR-002)
**Context**: The new warning must fire only when the body contains `####` headers whose text looks like a phase header. FR-002 offers three candidate rules but does not pin one. The choice determines both a small regex in `parse-epic-body.ts` and the false-positive / false-negative envelope of the whole detector. Picking the wrong rule either misses the snappoll#1 shape (fails SC-001) or fires on legitimate `#### Notes` / `#### Follow-ups` sub-headers (fails SC-002).
**Question**: Which exact rule should `parseEpicBody` use to decide a `####` heading is "phase-shaped"?
**Options**:
- A: `/^\s*P\d+\b/i` only — matches `P1`, `P2`, …, `p1 — Foundation`. Narrowest; matches the snappoll#1 fixture directly; false positive rate near-zero.
- B: Case-insensitive substring "phase" — matches `#### Phase 1`, `#### Delivery phase`. Slightly wider; catches human-authored bodies that spell phase out.
- C: A ∪ B — `/^\s*P\d+\b/i` OR case-insensitive "phase". Broadest of the pinned options while still narrow.
- D: Reuse `firstToken()` from `heading-match.ts` (the same extractor `###` phase tokens use) and treat any non-empty first-token as phase-shaped. Consistent with `###`, but risks false positives on `#### Notes` / `#### Follow-ups` — those are also non-empty first-tokens, and the FR-005/FR-006/FR-007 narrowness bar is the only defense.

**Answer**: **C** — `/^\s*P\d+\b/i` OR case-insensitive `phase`. Covers the epic-LLM shape (`#### P1 …`) and human spelled-out phases (`#### Phase 1` / `#### Delivery phase`) while excluding `#### Notes` / `#### Follow-ups` (SC-002). Refinement: word-boundary the phase arm (`/\bphase\b/i`, not a raw substring) so it does not match `#### Rephrase …`.

### Q2: Exact warning marker substring (FR-003, FR-004)
**Context**: FR-003 requires "a stable, documented marker substring … so tests can assert via `toContain()` without pinning full wording." FR-004 sketches an example: `"cockpit: N task refs fell to ad-hoc; phase headers must be '###', found '####'"`. The stable marker substring anchors both the test in `parse-epic-body.test.ts` (FR-010) and the grep audit in SC-006. Picking a substring that's too short risks accidental collision with the three existing rejection-family markers at `parse-epic-body.ts:15-33` (`"bare '#N'"`, `"titled but not ref-shaped"`, `"URL path not /(issues|pull)/N"`); picking one that's too long fossilizes wording.
**Question**: What exact marker substring should tests assert via `toContain()`?
**Options**:
- A: `phase headers must be '###', found '####'` — matches FR-004's example verbatim; explicit, self-documenting, no collision with existing markers.
- B: `phase headers must be '###'` — shorter; still unambiguous; leaves the `found '####'` phrasing free to evolve.
- C: `fell to ad-hoc` — leads on the observable symptom; risks colliding with future adhoc-related warnings.
- D: A distinct opaque code like `EPIC_H4_PHASE_HEADERS` embedded in the message — machine-friendly but breaks the existing convention (the three current markers are all human-readable substrings).

**Answer**: **B** — `phase headers must be '###'`. FR-003's goal is to assert via `toContain()` without pinning full wording; B is the stable, load-bearing instruction, collision-free with the three existing markers, and leaves the count and `found '####'` phrasing free to evolve. (A pins nearly the whole sentence — the fossilization FR-003 warns against.)

### Q3: Surfacing hook — this PR or companion PR (FR-009)
**Context**: FR-009 has two parts: (a) surface `parseEpicBody`'s `warnings[]` on the affected epic, and (b) print a loud signal when `phases[].every(p => p.refs.length === 0) && adhocRefs.length > 0`. Part (a) is already partially wired — `resolveEpic()` at `packages/cockpit/src/resolver/resolve.ts:53-55` iterates `parsed.warnings` and calls `options.logger.warn(w)`, and `status.ts` uses the default logger which lands on stderr. Part (b) does not exist yet in any form. The `/cockpit:auto` skill (`/home/node/.claude/commands/cockpit/auto.md` step 3) reads status via the `cockpit_status` MCP tool, so an in-repo hook must land in either the CLI's `--json` envelope, the MCP tool's return shape, or both — else the auto skill's sweep cannot see the signal. The spec's Assumption 2 explicitly names FR-009 as load-bearing "if [warnings] is currently discarded on every path."
**Question**: Should the surfacing hook (both the warnings forwarding and the loud all-adhoc-zero-populated-phases signal) land in THIS PR or a COMPANION PR?
**Options**:
- A: This PR, both parts (a) and (b). Extend the `cockpit status --json` envelope (and the `cockpit_status` MCP tool return shape) to include `warnings[]` + an `allAdhocZeroPopulatedPhases: boolean` field; ensure human-readable stderr line fires for part (b). Ships the full loud-signal path end-to-end; no time gap between the warning existing and being visible.
- B: This PR, part (a) only (warnings already flow to `logger.warn`; verify the `--json` envelope carries them). Defer part (b)'s all-adhoc signal to a companion PR. Smaller diff, but if the auto skill can't see warnings without the JSON change, the fix is invisible in the exact operator path this spec targets.
- C: This PR, resolver-only (just add the warning). Both surfacing pieces move to a companion PR. Cleanest layering (resolver stays a pure library change), but the operator-visible signal doesn't ship until the companion lands — worst outcome for the "silent stall" experience the spec is fixing.
- D: This PR, resolver + CLI stderr only; MCP tool surface changes to a companion PR. Balances scope but still requires two coordinated PRs to close the loop for `/cockpit:auto`.

**Answer**: **A** — this PR, end-to-end. The spec exists to make the silent stall visible to `/cockpit:auto`, which reads the `cockpit_status` MCP tool; deferring the surface re-opens a window where the warning exists but the target caller can't see it. **Caveat**: implement the machine-readable signal via `warnings[]` (per Q4/Q5), **NOT** the `allAdhocZeroPopulatedPhases` boolean that A's text mentions — that richer degradation return-type is excluded by Out-of-Scope §5.

### Q4: Surfacing channel for the all-adhoc-zero-populated-phases signal (FR-009)
**Context**: The FR-009 loud signal is a distinct output from `parseEpicBody`'s `warnings[]` — it fires at the caller level (status/sweep/auto), not the parser level. The channel choice affects how tests assert it, how `/cockpit:auto`'s sweep consumes it, and whether machine-readable pipelines (json envelope) see it.
**Question**: What channel(s) should the sweep-level all-adhoc-zero-populated-phases signal use?
**Options**:
- A: Human-readable stderr line only. Matches the existing warning path (`resolveEpic` → `logger.warn` → stderr). Simplest; adequate for a human operator watching the CLI; invisible to `--json` consumers.
- B: Structured logging only — new field in the `cockpit status --json` envelope (e.g. `"warnings": [...]` + `"degradation": { "kind": "all-adhoc-zero-populated-phases" }` or similar). Machine-readable; the auto skill sweep can key on it directly; silent for interactive human operators unless the CLI also prints it.
- C: Both — stderr line AND JSON envelope field. Highest coverage; slightly more code; guarantees both operator paths (interactive + auto skill) see the signal.
- D: stderr line + include `warnings[]` in `--json` envelope, but NO separate structured `degradation.kind` field (Out-of-Scope §5 already excludes a richer return type). Auto skill infers the degradation from `warnings[].some(w => w.includes(<FR-003 marker>))`.

**Answer**: **D** — stderr line + `warnings[]` in the `--json` envelope; no separate `degradation.kind` field. Covers both operator paths (interactive human via stderr, auto sweep via `warnings[]`) without the richer return-type Out-of-Scope §5 forbids. The auto skill infers degradation from `warnings[].some(w => w.includes("phase headers must be '###'"))` (the Q2 marker).

### Q5: Include `warnings[]` in `cockpit status --json` envelope
**Context**: Today's `cockpit status --json` envelope (`renderJsonEnvelope` at `status.ts:168-172`) emits `{ owner, repo, issue, rows }` — no `warnings` field. `/cockpit:auto`'s step 3 startup sweep uses the `cockpit_status` MCP tool, which mirrors the CLI shape. If the JSON envelope stays silent on warnings, the resolver-side fix will fire but be invisible to the exact caller the spec is trying to unblock. This is technically implied by Q3 + Q4 but is worth pinning as a separate binary decision because Out-of-Scope §5 forbids a richer degradation return-type, not the warnings array itself.
**Question**: Should `cockpit status --json` (and the `cockpit_status` MCP tool by parity) include `warnings[]` in its envelope as part of this PR?
**Options**:
- A: Yes — add `warnings: string[]` to the JSON envelope in this PR. Sourced directly from `parsed.warnings`; empty array when clean. Required for `/cockpit:auto`'s sweep to see the FR-003 marker; consistent with the "additive, non-breaking" contract in FR-012.
- B: No — leave the JSON envelope shape unchanged in this PR; warnings surface only via stderr. Defers to a companion PR any change to the machine-readable path. Consequence: the auto skill sweep will not see warnings until the companion ships.
- C: Yes for the CLI JSON envelope, defer the MCP tool return-shape change. Splits the surface change across two PRs but ships the CLI half now.

**Answer**: **A** — yes, add `warnings: string[]` to the JSON envelope AND the `cockpit_status` MCP tool return (parity). Given Q3=A + Q4=D, the auto sweep reads `warnings[]` off the MCP tool, so MCP parity is required, not optional. Additive / non-breaking per FR-012; empty array when clean.

---

## Correctness note (raised alongside answers)

For the plan/implement phase (applies regardless of the picks above): **FR-009 part (b)'s loud "all-adhoc / zero-populated-phases" signal must be gated on the same Q1 detector** — empty `###` phases **AND** `####` phase-shaped headers present — **NOT** on a bare `phases.every(p => p.refs.length === 0) && adhocRefs.length > 0` predicate. `[].every(...)` is vacuously `true`, so that bare predicate fires on legitimate flat-list bodies (`phases.length === 0`, all refs adhoc), which `resolve.ts:57-63` documents as a valid, supported mode — a false positive that would fail SC-002.

