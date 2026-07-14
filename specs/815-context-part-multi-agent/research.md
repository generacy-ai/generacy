# Research: verification mechanisms and rationale

Nothing new is being built. Every decision below is a mechanism choice for how the verification is captured, reviewed, and later re-derivable. Decisions trace directly to the clarifications in `clarifications.md`.

## Decision 1 — Evidence capture: inline Pino-grep fenced blocks in the PR body

**Choice**: `docker logs <orchestrator> | grep -E 'Spawning Claude CLI|agent.model.transition|--model'` (or equivalent Pino grep against a saved log), pasted as fenced code blocks in the PR body — one block per phase for the configured run, one block for the entire parity run showing zero matches for `--model`.

**Alternatives considered**:
- Redirect stdout to a file, gist both files (Q1 → B): externalizes durable evidence into a resource that outlives the PR review window but that reviewers must click through to.
- New shell harness under `specs/815-.../verification/` (Q1 → C): brushes the spec's Out of Scope §9 line; a checked-in harness only re-runs meaningfully against a live cluster that no longer exists at review time.

**Rationale**: The evidence set is tiny — one spawn line per agent phase + one empty parity grep. Inline blocks give reviewers everything without leaving the PR (satisfies FR-011 in the same file the reviewer is already looking at). If a block outgrows the body, spilling it to `gh pr comment --body-file` is a formatting fallback, not a different mechanism.

**Sources**: clarifications.md Q1 → A; spec.md FR-003, FR-006, FR-011.

## Decision 2 — Phase coverage: all five agent-spawning phases, operator-driven gate advancement

**Choice**: The operator running the verification session manually adds `completed:<gate>` at each `waiting-for:*-review` pause and drives the run through to the natural implementation-review stop. Denominator for SC-002 is the five agent-spawning phases: `specify`, `clarify`, `plan`, `tasks`, `implement`. `validate` is a shell phase in the current `speckit-feature` workflow and produces no `--model` evidence.

**Alternatives considered**:
- Phase-subset floor (Q2 → B): configure only three phases and terminate before the rest. Marginal cost saving over the full run is one or two gate advances; loses coverage of the same-model-adjacency boundaries SC-004 depends on.
- First-natural-stop only (Q2 → C): typically reaches only `specify`. Cannot demonstrate two distinct models, cannot demonstrate cross-phase carryover — proves nothing this feature actually changed.

**Rationale**: Advancing human-review gates is ordinary cockpit operation, not a protocol invention. The marginal cost over a three-phase floor is a couple more gate advances; the payoff is observing the full sequence including the same-model boundaries SC-004 depends on.

**Sources**: clarifications.md Q2 → A; spec.md FR-003 note, SC-002 denominator.

## Decision 3 — Config fixture shape: full three-layer stack

**Choice**: The test repo's `.generacy/config.yaml` sets all three layers:
- `orchestrator.agents.default.model` = X (some Claude model, e.g., `sonnet-4-6`)
- `orchestrator.agents.workflows.speckit-feature.default.model` = Y (a different Claude model, e.g., `sonnet-4-5`)
- `orchestrator.agents.workflows.speckit-feature.phases.implement.model` = Z (a third Claude model, e.g., `opus-4-7`)

X, Y, Z are three distinct Claude models. The provider stays `claude-code` at every layer.

**Alternatives considered**:
- Two-phase minimum (Q3 → A): sets only `phases.specify.model` and `phases.implement.model`. Simpler to write but leaves precedence undemonstrated in-run and destroys the same-model adjacency SC-004 needs.
- Six-phase override (Q3 → C): sets `phases.<phase>.model` on every phase. Directly documents what an operator would write for maximal control but doesn't exercise the precedence chain, and by giving every phase a distinct model destroys the adjacent same-model pairs SC-004 requires.

**Rationale**: The three-layer stack observably proves the resolution that matters most (phase override Z beating workflow default Y) while every non-implement phase resolving to Y supplies four adjacent same-model boundaries any of which satisfies SC-004. It's also the fixture an operator would actually copy from `examples/config-full.yaml`, serving FR-008/SC-005 without producing a divergent shape.

**Honesty note for the PR body**: `agents.default` (X) is configured but shadowed by the workflow default (Y) in a `speckit-feature` run — X-tier resolution is covered by #814's precedence unit tests (its SC-001), not this run.

**Sources**: clarifications.md Q3 → B; spec.md FR-001.

## Decision 4 — Resume-preservation evidence: cross-phase carryover (behavior b)

**Choice**: At least once during the configured run, phase N+1's spawn argv MUST include `--resume <sessionId>` matching the `sessionId` phase N produced, where both phases resolved to the same `{provider, model}`.

**Alternatives considered**:
- Intra-phase resume evidence (Q4 → C): the kill-and-continue path used by increments/timeouts/human input. Exists but is pre-existing machinery unrelated to #814's change.
- Both (Q4 → B): requires artificially inducing an implement increment or timeout to produce intra-phase resume evidence. Adds flaky ceremony that tests nothing new.

**Rationale**: The behavior this feature actually changed is the provider/model-aware cross-boundary carryover from #814 (its FR-011 plus the Q2→C decision to preserve sessions on model-only same-provider transitions). Integration must prove *that* survived — not something already established pre-#813. The three-layer fixture in Decision 3 guarantees a suitable boundary exists (every non-implement phase resolves to Y, so any adjacent pair among `specify`→`clarify`→`plan`→`tasks` satisfies the requirement).

**Sources**: clarifications.md Q4 → A; spec.md FR-004, SC-004; #814 spec/plan FR-011 and clarification Q2 → C.

## Decision 5 — Cross-repo docs deliverables: re-scoped to a sibling `tetrad-development` issue

**Choice**: This PR lands the in-repo docs deliverable only (`packages/generacy/examples/config-full.yaml`, FR-008). FR-009 (`dev-cluster-architecture.md`) and FR-010 (`multi-agent-provider-plan.md`) are re-scoped to a sibling issue on `generacy-ai/tetrad-development` and linked from this PR body as follow-ups.

**Alternatives considered**:
- Block this PR on sibling tetrad-development PR (Q5 → B): parks the cluster-managed PR behind a gate the automation cannot observe or satisfy.
- Operator opens the sibling PRs alongside this one and both merge together (Q5 → C): same automation blocker as B, plus adds hidden coordination cost between two humans.

**Rationale**: The established convention for cross-cutting work in this ecosystem is one self-contained issue per repo. Cluster automation cannot span repos; blocking on out-of-band human PRs in another repo strands the workflow. The sibling issue keeps the docs work tracked in the repo where the files live and is discoverable from this PR body.

**Sources**: clarifications.md Q5 → A; spec.md FR-009, FR-010, SC-006.

## Implementation patterns

- **Config fixture** goes into the *test repo's* `.generacy/config.yaml`, not this repo. Nothing about the fixture is checked into `generacy-ai/generacy`.
- **Docs deliverable** replaces the commented-out `# agents:` block in `packages/generacy/examples/config-full.yaml` with a live, uncommented three-layer example plus inline precedence documentation. The existing precedence-chain comment (lines 48–56) stays.
- **Sibling tetrad-development issue** is opened before or during PR review; its URL is embedded in this PR body under an explicit "Follow-ups" section.
- **PR body evidence layout**: one H2 per verification track, with H3 subsections per phase for the configured track. Grep commands shown inline (in text, not just output) so reviewers can re-derive locally.

## Key sources / references

- `packages/orchestrator/src/worker/cli-spawner.ts:61` — spawn log message.
- `packages/orchestrator/src/worker/phase-loop.ts:388` — `agent.model.transition` log line.
- `packages/orchestrator/src/worker/phase-loop.ts:402` — `resumeSessionId: currentSessionId` handoff.
- `packages/orchestrator/src/worker/phase-loop.ts:466` — `currentSessionId = result.sessionId` producer.
- `packages/generacy/examples/config-full.yaml` — the file this PR edits.
- `docs/multi-agent-provider-plan.md` (in `tetrad-development`) — Wave 1 phase-1 tracker.
- #813 (provider seam), #814 (agents.provider/model resolver + wire) — the two changes this issue verifies.
