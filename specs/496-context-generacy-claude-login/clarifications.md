# Clarifications: CLI claude-login and open commands

## Batch 1 — 2026-04-29

### Q1: Host-side cluster resolution
**Context**: The spec assumes `getClusterContext` resolves the cluster from cwd, but no such helper exists, and the cluster metadata (`ClusterJson` with `cluster_id`, `cloud_url`, etc.) lives inside the orchestrator container at `/var/lib/generacy/cluster.json`. The host-side CLI has no registry or mapping from a working directory to a running cluster.
**Question**: How should the CLI on the host resolve which cluster is associated with the current working directory? Should it detect the docker compose project (e.g., by finding `.generacy/` or `docker-compose.yml` in cwd), then use `docker compose exec` to read `/var/lib/generacy/cluster.json` from the running container?
**Options**:
- A: Detect docker compose project from cwd, then `docker compose exec` to read cluster metadata from the container
- B: Maintain a host-side registry file (e.g., `~/.generacy/clusters.json`) that maps project paths to cluster info
- C: Use docker labels or `docker compose ps` to find the orchestrator container, then inspect it

**Answer**: B — Use the host-side `~/.generacy/clusters.json` registry (defined in #494) plus the per-project `.generacy/cluster.json` mirror file. No need to exec into running containers for cwd resolution — the registry and project files are authoritative. `getClusterContext(cwd)` walks up from cwd looking for a `.generacy/` directory (longest-prefix-match per #493-Q3), reads `.generacy/cluster.json` for the cluster identity, then optionally cross-references `~/.generacy/clusters.json` for any registry-only metadata.

### Q2: CLI package location
**Context**: The issue body references `packages/cli/src/commands/claude-login.ts`, but the existing CLI is at `packages/generacy/src/cli/commands/` using Commander.js. This discrepancy could cause implementation confusion.
**Question**: Should the new commands be added to the existing CLI at `packages/generacy/src/cli/commands/` (following the current pattern), or should a new `packages/cli/` package be created as the issue body suggests?
**Options**:
- A: Add to existing `packages/generacy/src/cli/commands/` (consistent with current codebase)
- B: Create new `packages/cli/` package as the issue body suggests

**Answer**: A — Add to existing `packages/generacy/src/cli/commands/`. Cross-cutting decision applied to all four Phase 5 issues; see #494 for full rationale. `claude-login` and `open` become `packages/generacy/src/cli/commands/claude-login/` and `packages/generacy/src/cli/commands/open/`.

### Q3: Browser URL interception for claude-login
**Context**: FR-003 says the browser callback URL should auto-open on macOS/Windows. The `claude /login` command prints a URL to stdout, which the CLI is proxying to the user's terminal. To auto-open the URL, the CLI would need to intercept stdout, detect the URL pattern, and launch the browser — while still displaying the output to the user.
**Question**: Should the CLI parse the proxied stdout stream to detect and auto-open the callback URL? Or should it simply proxy everything transparently and rely on the user to click/open the URL themselves (as `claude /login` may already trigger browser opening via Docker Desktop's shared networking)?
**Options**:
- A: Parse stdout to detect URL pattern and auto-open on macOS/Windows, print-only on Linux
- B: Proxy transparently — Docker Desktop networking handles browser opening on macOS/Windows; print instructions on Linux
- C: Proxy transparently on all platforms, no URL interception (simplest)

**Answer**: A — Parse stdout to detect URL patterns, auto-open on macOS/Windows; print-only on Linux. Docker Desktop doesn't auto-open URLs printed to stdout from inside a container — the in-container `claude /login` just prints text. The CLI proxying that stdout is the right place to detect URLs and trigger the host's default browser. Use a simple regex looking for `https?://[^\s]+` in the proxied output; first match wins. Linux prints "Open this URL in your browser:" with the matched URL on a clear line (per dev-cluster-architecture.md Open question #3).

### Q4: What does --cluster <id> refer to
**Context**: FR-005 says `open` accepts `--cluster <id>` as an alternative to cwd resolution. But it's unclear what `<id>` refers to — is it the `cluster_id` from `ClusterJson`, a docker compose project name, or a user-defined alias?
**Question**: What identifier should `--cluster <id>` accept? And how would the CLI look up the cluster's `cloud_url` when given an explicit ID (vs. resolving from cwd)?
**Options**:
- A: `cluster_id` (UUID from activation) — requires a host-side registry to look up
- B: Docker compose project name — can resolve via `docker compose` commands
- C: Both, with docker compose project name as default and `--cluster-id` for UUID

**Answer**: A — `cluster_id` from activation, looked up via the host-side registry. Since the cluster_id is used as the docker compose project name (per #494's decision), there's no real distinction between "cluster_id" and "compose project name" — they're the same value. `--cluster <id>` accepts that value and looks up the cluster's `cloudUrl`, `path`, and other fields from `~/.generacy/clusters.json`. Tab completion can be added later.

### Q5: TTY allocation for docker compose exec
**Context**: FR-002 requires interactive stdin/stdout proxying for `claude /login`. The `docker compose exec` command needs `-it` flags for proper TTY allocation, but this only works when the CLI's own stdin is a TTY. Non-TTY contexts (piped input, CI) would fail.
**Question**: Should the CLI always use `-it` (and fail if stdin isn't a TTY), or should it detect TTY availability and adjust flags accordingly? Also, should it use `docker compose exec` directly or go through the CLI's existing `exec.ts` utilities?
**Options**:
- A: Detect TTY with `process.stdin.isTTY` — use `-it` when available, `-i` only otherwise
- B: Always require TTY (`-it`) and fail with a clear error if stdin isn't a TTY
- C: Use `child_process.spawn` with `stdio: 'inherit'` to pass through the terminal directly

**Answer**: C — Use `child_process.spawn` with `stdio: 'inherit'` to pass through the user's terminal directly. Invoke `docker compose exec -it orchestrator claude /login` (the `-it` tells Docker to allocate a TTY for the exec'd command; stdio inheritance proxies it to the user's shell). Non-TTY contexts (CI, piped input) will fail at the docker exec step with a Docker-native error — that's the correct behavior since `claude /login` is interactive-only. No need for explicit `process.stdin.isTTY` detection.

## Batch 2 — 2026-04-29

### Q6: stdio inherit vs URL interception conflict
**Context**: Q3 answer says to intercept stdout to detect URLs and auto-open them, but Q5 answer says to use `stdio: 'inherit'` which passes stdout directly to the terminal (no interception possible). These are mutually exclusive approaches.
**Question**: How should the CLI handle the conflict between full terminal passthrough and URL detection?
**Options**:
- A: Use `stdio: ['inherit', 'pipe', 'inherit']` — pipe stdout to scan for URLs while forwarding to terminal. stdin/stderr stay inherited. May lose TTY coloring on stdout inside container.
- B: Use `stdio: 'inherit'` and skip URL detection — just print instructions on all platforms.
- C: Use `node-pty` for full PTY emulation while intercepting output — preserves TTY but adds native dependency.

**Answer**: A — Use `stdio: ['inherit', 'pipe', 'inherit']` to pipe stdout only. Scan for URL patterns while forwarding all output to the terminal. stdin and stderr remain inherited for direct terminal passthrough. May lose TTY coloring characteristics on stdout inside the container, but URL detection is the higher priority for macOS/Windows UX.
