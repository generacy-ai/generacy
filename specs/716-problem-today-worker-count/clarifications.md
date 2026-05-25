# Clarifications: workers is per-host; CLI launch picks the count

**Branch**: `716-problem-today-worker-count` | **Spec**: [spec.md](./spec.md)

## Batch 1 — 2026-05-25

### Q1: Cloud relay mechanism for chosen worker count
**Context**: FR-010 says the CLI must tell the cloud which worker count was chosen at launch so the cluster doc's `targetWorkers` field starts in sync. The spec explicitly defers the mechanism: activation-complete payload vs. the cluster's metadata push pipeline (which #714 just made richer). This decision affects which code paths land in this issue vs. follow-up.
**Question**: Which mechanism should the CLI/orchestrator use to relay the chosen worker count to the cloud at first boot?
**Options**:
- A: Metadata push (#714 pipeline) — include `workers` in the periodic metadata payload the orchestrator already sends; cloud reconciles `targetWorkers` on each push.
- B: Activation-complete payload — extend the device-flow `approve`/`activate` call to include `workers`; cloud sets `targetWorkers` once at activation.
- C: Both — activation payload for fast initial sync, metadata push for ongoing reconciliation drift.

**Answer**: B — activation-complete payload extends to include `workers`; cloud sets `targetWorkers` once at activation. Keeps the contracts clean: `metadata.workers` is observed state (post-#714 Engine API enumeration); `targetWorkers` is declared intent (user-chosen at launch, mutated by scale ops via the existing `PATCH /clusters/:clusterId/workers` flow). Routing both through metadata push conflates the two semantics. There is no drift to reconcile after activation, so C (both) is unnecessary.

### Q2: Cloud bootstrap UI scope
**Context**: The "Run on my computer" cloud page could optionally prompt for workers and bake the value into the claim code / launch-config (so the CLI prompt pre-fills a value the user already chose). The spec leans toward CLI-side ("host knows itself best") but explicitly defers the decision to clarify. This affects whether the companion cloud issue (#696) needs a UI surface, or whether CLI-side prompt is the only entry point.
**Question**: Should the cloud's bootstrap UI ("Run on my computer" page) prompt for worker count and pass it through `launch-config`, or is CLI-side prompt the only entry point for v1?
**Options**:
- A: CLI-side only — cloud UI does not prompt; `launch-config` carries only the tier cap; CLI is the sole source of the chosen value.
- B: Cloud-side optional hint — cloud UI prompts with a non-binding default; CLI uses it as the prompt default but still allows override.
- C: Cloud-side authoritative — cloud UI picks the value; CLI just honors `launch-config.workers` and only re-prompts if missing.

**Answer**: A — CLI-side only; `launch-config` carries the tier cap, not a chosen value. The host knows itself; the cloud doesn't — that's the whole point of the refactor. B/C invert that and create the awkward case where the user picks a value in the cloud UI that the host can't actually handle (silent downgrade or hard reject — both bad). A makes the host the single point of decision with the cloud providing only the cap as a constraint.

### Q3: Tier cap source in launch-config
**Context**: The spec's FR-002 and Assumptions state the launch-config "either already exposes the org's tier cap or will be extended to do so." Inspection of `LaunchConfigSchema` in `packages/generacy/src/cli/commands/launch/types.ts` shows no tier-cap field currently. This issue can't ship FR-002 / FR-004 (tier-cap rejection) without one. The CLI's behavior when the field is absent at runtime needs to be defined.
**Question**: What should the CLI do when `launch-config` does not yet expose a tier cap field?
**Options**:
- A: Hard prerequisite — block this issue until the companion cloud issue adds `tierCap` to `launch-config`; assume both ship together.
- B: Optional with fallback — treat absence as "no cap"; accept any positive integer; log a warning that tier validation is unavailable.
- C: Optional with conservative default — treat absence as a fixed cap (e.g. 8) baked into the CLI; reject values above that until cloud-side exposes the real cap.

**Answer**: C — optional with a conservative CLI-baked cap of `8` until launch-config exposes the real value. Decouples this issue's release from the cloud companion (A is unnecessarily coupling). B (no-cap fallback) is dangerous — `--workers=100` would melt a host before docker compose figures out it can't schedule that many. Implementation: `tierCap = launchConfig.tierCap ?? CLI_FALLBACK_CAP` where `CLI_FALLBACK_CAP = 8`. Log a warning when the fallback is used; remove once the cloud companion is known to ship.

### Q4: Default suggested worker count for v1
**Context**: FR-002 specifies the prompt default as `min(tierCap, suggestedFromHost)`. The spec notes resource-aware suggestion (CPU/RAM-based) is out of scope, and that `suggestedFromHost` "could start at a constant like 2 for v1." The exact constant must be pinned to ship; today's hardcoded `WORKER_COUNT=1` in `scaffolder.ts:75` is the implicit current default.
**Question**: What constant value should `suggestedFromHost` use for v1 (before resource-aware logic lands)?
**Options**:
- A: `1` — preserves today's default behavior; conservative; matches what users get with no flag today.
- B: `2` — matches the spec's example; mildly opinionated; assumes most dev hosts can handle 2.
- C: `min(os.cpus().length, 4)` — minimal smarter default that doesn't require full resource-aware logic; uses CPU count up to a small cap.

**Answer**: B — constant `2` as the v1 `suggestedFromHost`. A (1) preserves today's behavior but that behavior is the bug — 1 is the legacy hardcoded value, not a deliberate choice. C is the right shape long-term but belongs in the resource-aware-defaults follow-up, and one worker per CPU is aggressive for full dev-container environments. B lands cleanly with no resource detection. Final default at the prompt: `min(tierCap, 2)` — which is 1 on Free, 2 everywhere else.

### Q5: Non-interactive launch without --workers
**Context**: `npx generacy launch --claim=<code>` could be invoked in CI or scripted environments where no TTY is available. Spec is silent on what happens when neither a TTY nor `--workers` is present. Three reasonable behaviors exist; this affects scripted onboarding paths and the user-facing error story.
**Question**: When `generacy launch` runs with no TTY and no `--workers=N` flag, what should it do?
**Options**:
- A: Error out — require `--workers=N` explicitly; print clear message pointing at the flag. CI must always be explicit.
- B: Default silently — use `suggestedFromHost` (per Q4) and log the chosen value at info level; do not block.
- C: Default with warning — use `suggestedFromHost`, log a prominent warning telling users to pin `--workers=N` for reproducibility.

**Answer**: C — default with prominent warning telling users to pin `--workers=N`. A (hard error) is hostile to common cases (scripts, Docker, tmux without real TTY). B (silent default) hides important info from CI users. C is the middle ground: launch succeeds with a sensible default, warning tells the user `if you're scripting this, pin --workers=N for reproducibility`. Warning text: `No TTY detected and --workers not provided. Defaulting to <N> workers. For reproducible scripted launches, pass --workers=<N> explicitly.`
