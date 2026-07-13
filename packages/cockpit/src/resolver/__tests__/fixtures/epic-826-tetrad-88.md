Epic — Epic Cockpit: developer-side workflow automation.

Implements the developer-side automation layer for running speckit epics: a @generacy-ai/cockpit package + "generacy cockpit" CLI (engine) and a claude-plugin-cockpit providing /cockpit:* slash commands via the agency marketplace. Watches issue/label/PR state and helps advance gates, with a per-gate autonomy policy (manual/assist/auto).

Plan: docs/epic-cockpit-plan.md in tetrad-development.

Scope: 19 child issues across 6 phases (P0–P5); rev 3 simplification (plan doc, 2026-07-02) adds 6 children across S1–S5. Core (the daily watch-and-approve loop) lands at end of P2; pipeline at P4; polish at P5. Children span generacy (engine + CLI) and agency (slash commands). No process:* labels yet — queue phase-by-phase.

## Children by phase

### P0 — foundation (generacy)
- [ ] generacy-ai/generacy#786 — @generacy-ai/cockpit engine foundation package

### P1 — core internals (generacy ∥ agency)
- [ ] generacy-ai/generacy#787 — CLI: cockpit watch + status
- [ ] generacy-ai/generacy#788 — CLI: cockpit state + advance + clarify-context
- [ ] generacy-ai/generacy#789 — CLI: cockpit merge + review-context
- [ ] generacy-ai/agency#350 — claude-plugin-cockpit scaffold + marketplace entry

### P2 — core commands → v1 (agency)
- [ ] generacy-ai/agency#351 — /cockpit:watch
- [ ] generacy-ai/agency#352 — /cockpit:status
- [ ] generacy-ai/agency#353 — /cockpit:clarify
- [ ] generacy-ai/agency#354 — /cockpit:review
- [ ] generacy-ai/agency#355 — /cockpit:merge

### P3 — pipeline verbs (generacy)
- [ ] generacy-ai/generacy#790 — CLI: cockpit manifest init/sync
- [ ] generacy-ai/generacy#791 — CLI: cockpit queue <phase>

### P4 — pipeline commands → v2 (agency)
- [ ] generacy-ai/agency#356 — /cockpit:plan
- [ ] generacy-ai/agency#357 — /cockpit:breakdown
- [ ] generacy-ai/agency#358 — /cockpit:file
- [ ] generacy-ai/agency#359 — /cockpit:queue

### P5 — polish → v3 (generacy ∥ agency)
- [ ] generacy-ai/generacy#792 — Orchestrator API status tier
- [ ] generacy-ai/generacy#793 — Journal-based stuck detection
- [ ] generacy-ai/agency#360 — /cockpit:bug + AFK push

### S1 — rev 3 simplification: deletions (filed 2026-07-02; parallel across repos)
- [ ] generacy-ai/generacy#805 — G-S1 delete dark subsystems
- [ ] generacy-ai/tetrad-development#87 — T-S1 retire epic manifest + document epic-body convention

### S2 — single-source discovery
- [ ] generacy-ai/generacy#806 — G-S2 epic-body discovery, fail-loud

### S3 — verb collapse
- [ ] generacy-ai/generacy#807 — G-S3 context verb + wrapper/resolver unification

### S4 — plugin rewrite + residue cleanup
- [ ] generacy-ai/agency#372 — A-S1 six self-contained assist commands
- [ ] generacy-ai/generacy#810 — G-S4 G-S1 residue: changesets, docs, test surface
- [ ] generacy-ai/tetrad-development#90 — T-S3 epic-body grammar residue

### S6 — plugin packaging (preview-channel delivery; filed 2026-07-06)
- [ ] generacy-ai/agency#374 — A-S2 publish @generacy-ai/claude-plugin-cockpit
- [ ] generacy-ai/generacy#816 — G-S5 setup build wires cockpit commands

### S7 — cluster delivery (hand-run; repo not monitored)
- [ ] generacy-ai/cluster-base#69 — C-S1 install plugin during cluster setup, channel-aware

### S5 — integration gate (human; runs LAST, after S7, on a fresh preview-channel cluster)
- [ ] generacy-ai/tetrad-development#88 — T-S2 v1 integration smoke test on scratch epic

---
Plan: docs/epic-cockpit-plan.md in tetrad-development. No process:* labels yet — queue phase-by-phase.




