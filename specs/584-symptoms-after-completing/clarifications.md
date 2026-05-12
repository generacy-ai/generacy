# Clarifications for #584 — VS Code Desktop tunnel

## Batch 1 (2026-05-12)

### Q1: Generacy Repo Scope
**Context**: The spec lists 3 repos (cluster-base, generacy, generacy-cloud) and 7 FRs. FR-001 is a Dockerfile change in cluster-base; FR-004/FR-005 are web UI changes in generacy-cloud. Knowing exactly which FRs this issue covers determines what code to write in this PR.
**Question**: For this issue in the generacy repo, is the scope limited to FR-002 (lifecycle action), FR-003 (relay events), FR-006 (auto-start), and FR-007 (stop action)? Or should this issue also include the cluster-base Dockerfile change (FR-001) and/or generacy-cloud UI changes (FR-004/FR-005)?
**Options**:
- A: Generacy repo only — FR-002, FR-003, FR-006, FR-007 (cluster-base and generacy-cloud tracked in separate issues)
- B: Include cluster-base FR-001 as well (cross-repo PR or companion PR)
- C: All FRs in a single issue across all repos

**Answer**: *Pending*

### Q2: Tunnel Process Management Pattern
**Context**: FR-006 lists two approaches: `code tunnel service install` (systemd-based) or supervisor integration. Containers typically lack systemd. The existing `CodeServerProcessManager` uses a managed child process with idle timeout. The choice affects the `vscode-tunnel-start` lifecycle action architecture (FR-002).
**Question**: Should the tunnel manager follow the existing `CodeServerProcessManager` pattern (managed child process with start/stop lifecycle actions) rather than `code tunnel service install` (which requires systemd)?
**Options**:
- A: Managed child process (like CodeServerProcessManager) — start/stop via lifecycle actions, no systemd dependency
- B: `code tunnel service install` — investigate systemd-in-container feasibility first
- C: Supervisor process (e.g., supervisord) — separate process manager

**Answer**: *Pending*

### Q3: Relay Event Schema
**Context**: FR-003 says "surface device code to web UI via relay event channel" using `cluster.vscode-tunnel` (or similar), but doesn't define the event payload schema. The tunnel has several states (starting, waiting-for-auth, authenticated/connected, disconnected, error). The web UI needs structured data to show the right UX at each stage.
**Question**: What states and fields should the `cluster.vscode-tunnel` relay events carry? Specifically: should the events include full lifecycle transitions (starting → awaiting-auth → connected → disconnected → error), or just the device-code payload when auth is needed?
**Options**:
- A: Full lifecycle events — `{ status: 'starting' | 'awaiting-auth' | 'connected' | 'disconnected' | 'error', deviceCode?: string, verificationUri?: string, tunnelName?: string, error?: string }`
- B: Minimal — only emit when device code is available: `{ deviceCode: string, verificationUri: string }` and when tunnel is connected: `{ tunnelName: string }`
- C: Mirror code-server pattern — return status from lifecycle action response, don't use relay events for state

**Answer**: *Pending*

### Q4: Auth State Persistence Across Container Recreation
**Context**: US2 requires the tunnel to survive "cluster restarts" without re-authentication. `code tunnel` stores GitHub auth tokens in `~/.vscode-cli/`. A `docker restart` preserves container filesystem, but `docker compose down && up` (used by `generacy update`) recreates containers, losing `~/.vscode-cli/`. This distinction affects whether a named Docker volume mount is needed.
**Question**: Should "cluster restarts" in US2 include container recreation (e.g., `generacy update` which runs `docker compose down && up`)? If yes, should `~/.vscode-cli/` be persisted via a named Docker volume?
**Options**:
- A: Yes, persist via named volume — tunnel auth survives both restarts and recreations
- B: Only survive `docker restart` — re-auth on recreation is acceptable for v1
- C: Defer persistence (P2) — implement basic start/stop first, add persistence later

**Answer**: *Pending*

### Q5: Stdout Parsing Strategy for Device Code
**Context**: FR-002 requires parsing the device code from `code tunnel` stdout. The `code tunnel` CLI outputs an interactive prompt containing a URL (`github.com/login/device`) and a code (e.g., `ABCD-1234`). If Microsoft changes this output format, parsing breaks silently. The spec assumes this format is stable.
**Question**: Is there a known structured output mode for `code tunnel` (e.g., `--output json`), or should the implementation use regex parsing of the human-readable stdout? If regex, what's the fallback if parsing fails — should the raw output be forwarded to the web UI?
**Options**:
- A: Regex parsing with fallback — parse known format, forward raw output if pattern doesn't match
- B: Regex parsing, hard fail — if pattern doesn't match, emit error event, stop tunnel
- C: Investigate `code tunnel` API/structured output first before committing to stdout parsing

**Answer**: *Pending*
