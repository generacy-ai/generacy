# Clarifications — #530

## Batch 1 (2026-05-04)

### Q1: Repos Data Authority for clone-peer-repos
**Context**: The issue explicitly notes "verify which side has authority post-launch" — whether repos come from the cloud-forwarded request body or from local config (`.generacy/config.yaml` or `cluster.yaml`). This determines the handler's input source and Zod validation schema.
**Question**: Does the cloud forward the repos list in the `clone-peer-repos` request body (making the handler stateless), or should the handler read repos from local config files? If request body, what is the exact shape — `{ repos: { primary: string, dev?: string[], clone?: string[] } }` matching the existing `ReposConfigSchema`?
**Options**:
- A: Cloud forwards repos in request body (handler is stateless, validates body)
- B: Handler reads from `.generacy/config.yaml` repos section (cloud sends no body)
- C: Handler reads from `cluster.yaml` (written by launch/deploy scaffolder)

**Answer**: *Pending*

### Q2: Git Clone Authentication
**Context**: Cloning private repos requires authentication. The credhelper daemon provides credential sessions for agent processes, but the control-plane lifecycle handler runs in a different context. Neither the spec nor the issue addresses how `git clone` authenticates.
**Question**: How should the `clone-peer-repos` handler authenticate git clone operations for private repos? Does the container already have git credentials (e.g., mounted SSH keys, pre-configured credential helper), or does the handler need to obtain credentials from credhelper-daemon?
**Options**:
- A: Container already has git credentials configured at boot (no extra work needed)
- B: Handler must begin a credhelper session to get git credentials before cloning
- C: Cloud includes auth tokens in the request body alongside repo URLs

**Answer**: *Pending*

### Q3: Relay Event Emission Pattern
**Context**: Two event-emission patterns exist in control-plane: (1) `setRelayPushEvent` — module-level function setter already wired by orchestrator for audit routes, calls `pushEvent(channel, payload)`, and (2) TunnelHandler-style constructor DI of `RelayMessageSender` with raw `.send(message)`. The spec says "Same as TunnelHandler" but `setRelayPushEvent` is a more natural fit for channel-based events.
**Question**: Should the `clone-peer-repos` service use the existing `setRelayPushEvent` pattern (simpler, already wired, event-oriented), or introduce a new TunnelHandler-style `RelayMessageSender` injection (more explicit DI, requires new wiring in orchestrator)?
**Options**:
- A: Use existing `setRelayPushEvent` pattern (reuse audit wiring, call `pushEventFn('cluster.bootstrap', data)`)
- B: New `RelayMessageSender` constructor DI (TunnelHandler pattern, new wiring in server.ts)

**Answer**: *Pending*

### Q4: Which Repos Does clone-peer-repos Clone?
**Context**: The request body includes primary, dev, and clone repos. The primary repo is typically already the main workspace directory (cloned during cluster setup). With idempotency, an already-existing primary would be skipped, but the intent affects event emission (should the wizard expect a `done` event for the primary repo?).
**Question**: Should clone-peer-repos iterate over ALL repos including primary, or only dev + clone repos (assuming primary is already the workspace)?
**Options**:
- A: Clone ALL repos (primary + dev + clone); idempotency handles already-existing primary
- B: Clone only dev + clone repos; skip primary entirely

**Answer**: *Pending*

### Q5: YAML Writing for set-default-role
**Context**: The `set-default-role` handler needs to write `defaults.role` to `.generacy/config.yaml`. The control-plane package currently has zero YAML dependencies (only `zod` and `@generacy-ai/credhelper`). Round-trip YAML editing requires a parser to preserve existing content, comments, and formatting.
**Question**: Should the control-plane add a YAML library dependency (e.g., `yaml`) for proper round-trip config editing, or use a simpler approach?
**Options**:
- A: Add `yaml` package dependency for proper YAML parse/modify/serialize
- B: Use a simpler file-level approach (e.g., read as text, regex-based insert/replace)
- C: Delegate config writing to a different package that already has YAML support

**Answer**: *Pending*
