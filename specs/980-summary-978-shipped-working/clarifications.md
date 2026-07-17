# Clarifications for #980 — Wire the smee doorbell end-to-end (channel URL delivery + startup resilience)

## Batch 1 — 2026-07-17

### Q1: Which workspace(s) does the writer target on multi-repo clusters?
**Context**: FR-001 says "write the resolved channel URL to a workspace-relative path (e.g. `/workspaces/<repo>/.generacy/cockpit/smee-channel`)". A cluster's `WorkspaceConfig.repos` can list multiple entries; `packages/orchestrator/src/config/loader.ts:502-506` maps each to `/workspaces/<name>`, and the `*_workspace` volume mounts them all. The `<repo>` token in FR-001 is ambiguous when there are 2+ mounted workspaces:
- Writing to only the primary means an operator working out of a peer repo's workspace sees no channel file (poll-fallback).
- Writing to all means N filesystem writes per re-provision and N potentially stale copies if a repo is added/removed mid-run.
- The doorbell reader itself takes `<epic-ref>` (`owner/repo#N`) as input, so it *could* derive a repo-scoped read path — but that would require the reader to know the workspace layout, not just its own file.

The doorbell only holds one channel URL at a time and the URL is cluster-scoped, not repo-scoped — same URL works regardless of which workspace the reader is in.

**Question**: Where should `SmeeChannelResolver`/orchestrator-boot write the workspace-relative channel file when the cluster has multiple mounted workspaces?
**Options**:
- A: Write to every `/workspaces/<name>/.generacy/cockpit/smee-channel` for each repo in `WorkspaceConfig.repos`. Reader always looks at its own `cwd`-relative `.generacy/cockpit/smee-channel` (walks up like `resolveIssueContext`). All operator sessions see the URL regardless of which workspace they're in; cost is N writes per re-provision.
- B: Write only to the *primary* workspace (`repos[0]`) and require operator sessions in peer-repo workspaces to fall back to env override or shared discovery via the primary. Simpler writer; operator UX differs between primary and peer workspaces.
- C: Write to a *single* cluster-scoped location outside per-repo trees but still on the shared workspace volume (e.g. `/workspaces/.generacy/cockpit/smee-channel` — sibling of the per-repo dirs). Reader looks at `../.generacy/cockpit/smee-channel` from any workspace. One write, uniform reader behavior; requires the volume to expose that sibling path (verify mount surface).
- D: Write to a workspace-relative path *and* a repo-scoped derived path based on the epic's `<owner>/<repo>`, so different epics could theoretically use different channels. Overkill for a cluster-scoped URL; rejected unless there's a per-repo channel plan.

**Answer**: *Pending*

### Q2: Retry policy shape for FR-003 / FR-004 — bounded or unbounded, and what happens on ultimate failure?
**Context**: FR-003/FR-004 say "retry with backoff via the already-wired `rateLimitScheduler`" but don't specify termination. Today (`packages/generacy/src/cli/commands/cockpit/doorbell.ts:150-155, :460-470`), a `runPollMode` failure returns `null` → `exit(2)`; `runSmeeMode`'s `SmeeDoorbellSource.start()` calls `resolveEpic` at `smee-source.ts:171` and propagates thrown errors → smee-attempt fails → falls to poll → then `exit(2)` on poll failure. The spec makes clear that `exit(2)` is the bug (#431 doesn't re-spawn), but "retry" without a stop rule risks a doorbell process that lives forever burning `gh` calls against a broken PAT. The `rateLimitScheduler` handles the *spacing* of retries but not the give-up decision.

**Question**: What is the termination rule for FR-003/FR-004 retries, and what happens on ultimate failure?
**Options**:
- A: Retry indefinitely with the existing `rateLimitScheduler` backoff for the entire lifetime of the doorbell process. Never `exit(2)` from a startup call; the process only exits on epic-complete/signal. Simplest; but a permanently broken PAT keeps a doorbell process alive forever (heartbeat still fires from the skill side).
- B: Bounded retry — e.g. 5 attempts with exponential backoff capped at ~60s (total ~2 min). If still failing, `exit(2)` as today. Preserves today's fail-loud behavior for genuinely broken states; still strands the run on the 5-min heartbeat as the spec complains about. Only helps for the "single blip" case in the spec's `snappoll` evidence.
- C: Bounded retry window (~2 min) for the *initial* attempt; on exhaustion, log `source=degraded reason=startup-retry-exhausted` on stderr and *continue running* in a mode where the doorbell blocks on the stop-signal without a live wake path. The passive skill's heartbeat then covers the run at 5-min cadence, exactly as today, but the doorbell process does not die and reappear as a "source-lost" state to the skill. No further retry once exhausted.
- D: Bounded retry window (~2 min) for the initial attempt, then transition to a periodic *late-startup retry* every ~5 min (matching #978 Q3=D's demotion-with-retry pattern). Process stays alive; if the blip clears in 10 min, the wake path recovers automatically. Adds one background retry timer; symmetric with the runtime SSE-loss policy already adopted for smee.

**Answer**: *Pending*

### Q3: Which error classes count as "transient" and get retried vs. which propagate to exit?
**Context**: FR-003/FR-004 name "transient `gh`/rate-limit error" — 429 is unambiguous. But `gh` failures at `acquireEpicBus`/`resolveEpic` also cover: network errors (ECONNRESET, DNS), 5xx, 401 (revoked token), 403 (SSO/scope), 404 (epic issue deleted or wrong owner), malformed JSON output from `gh`, and PAT-lacks-permission on a *specific* endpoint (e.g. `Webhooks: read`, which the spec itself calls out as a permanent operator-PAT limitation). Blindly retrying 401/403/404 forever masks real misconfiguration — the operator sees a silent doorbell and no diagnostic path.

**Question**: Which error classes should trigger backoff-retry, and which should surface immediately (still `exit(2)` or `exit(3)` with a distinct code)?
**Options**:
- A: Retry only HTTP 429 and network-level errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNREFUSED, socket hang up). Everything else (401/403/404/5xx/malformed) exits immediately as today. Narrow, easy to audit; misses transient 5xx which are legitimately worth retrying.
- B: Retry 429, network errors, AND 5xx (500/502/503/504). Non-retriable: 401/403/404 and malformed output. Matches typical HTTP client convention; still preserves fail-loud on permanent auth/scope/not-found errors.
- C: Retry any error whose message matches known transient markers (rate-limit text, "temporary failure", timeout keywords, 5xx status codes). Everything else propagates. Simpler to implement (message-string matching) but brittle against `gh` output changes.
- D: Retry everything except a hard-coded permanent-error allowlist (401 "Bad credentials", 403 with "SAML" or "scope" in message, 404). Aggressive; keeps the doorbell alive through broader classes of transient trouble at the cost of longer time-to-diagnose on rarer permanent failures.

**Answer**: *Pending*

### Q4: Does the running doorbell need to react to mid-run channel re-provision, or is that out of scope?
**Context**: The Assumptions section says "if the channel is re-provisioned mid-run, the workspace-relative path is refreshed alongside the cluster-internal path" — that describes the *writer*. But `channel-discovery.ts` reads the file exactly once at doorbell startup (`doorbell.ts:342-347`); after that, `SmeeDoorbellSource` holds the URL as constructor state and reconnects to it forever (`smee-source.ts` has no re-read path). If the orchestrator provisions a new smee URL mid-run (e.g. cluster restart), the running doorbell process silently attaches to a dead URL. The doorbell's SSE reconnect handles smee.io outages but does not handle *URL change*. This is either:
- A real gap the fix should close (add a file-watch or periodic re-read), or
- Deliberately deferred — mid-run re-provision requires an operator restart, and the workaround section already accepts operator restarts.

**Question**: Should the running doorbell re-read the channel file mid-run, and if so, how?
**Options**:
- A: Out of scope. Doorbell reads channel at startup only. Mid-run re-provision requires operator to restart `/cockpit:auto`. Document as a known limitation; matches today's shipped #978 behavior and the spec's "workaround" tone. No new machinery.
- B: In scope, periodic re-read. Every ~5 min the doorbell re-invokes `discoverChannelUrl`; if the URL changed, tear down the SmeeEventSource and reconnect. Bounds mid-run staleness at 5 min; adds a timer and a reconnect-on-change path.
- C: In scope, `fs.watch`-based. Doorbell watches the channel file's `mtime`; on change, re-read and reconnect. Near-instant, no polling; risk: `fs.watch` semantics vary across FS backends (bind mounts, Docker volumes) — could miss events.
- D: In scope via a hybrid: `fs.watch` primary, ~5-min timer as safety net (mirrors #978 Q2's hybrid pattern for ref-set refresh). Most robust; most code.

**Answer**: *Pending*

### Q5: File permissions & content shape for the operator-visible path
**Context**: The cluster-internal file (`/var/lib/generacy/smee-channel`) is mode `0600` on a root-owned volume — invisible to non-root callers. The proposed workspace path lives on a user-writable, user-visible `*_workspace` volume where the auto ledger sits at mode `0644`-ish. Two open decisions:
1. **Mode**: `0600` on the workspace path may fail (operator's uid may differ from writer's), or may work but hide the file from `ls` inspection during troubleshooting. `0644` is friendlier but exposes the channel URL to anyone with workspace read (this is a shared devcontainer/tunnel surface; the URL is "capability by knowledge" — anyone with it can inject fake webhooks into your run).
2. **Content**: The cluster-internal file is bare URL only, no metadata. The workspace file could carry the same shape for symmetry, or add metadata (write timestamp, cluster-id) to help the reader detect staleness or a wrong-cluster scenario. Q4's answer partly constrains this: if the reader never re-reads (Q4=A), metadata is only useful for humans debugging; if it re-reads (Q4=B/C/D), a timestamp helps the reader distinguish a stale copy from a fresh one.

**Question**: What should the mode and content of the workspace-relative channel file be?
**Options**:
- A: Mode `0600`, bare URL content — mirror the cluster-internal file exactly. Uniform reader; fails if operator uid ≠ writer uid; hides the file from human `ls` (troubleshooting cost). Content-symmetric with the fallback path.
- B: Mode `0644`, bare URL content — human-readable during troubleshooting; accepts the "URL is capability" exposure on the shared workspace (the URL was already discoverable via `gh api hooks` before the operator-PAT scope constraint). Reader identical to A.
- C: Mode `0640` (owner rw, group r), bare URL content — compromise between `0600` and `0644`; requires uid/gid alignment between writer and reader, which the workspace volume typically has.
- D: Mode `0644`, JSON content `{ "url": "...", "writtenAt": "...", "clusterId": "..." }`. Reader tolerates both plain-URL (fallback compatibility) and JSON. Adds a light staleness/wrong-cluster signal for future work without blocking this feature.

**Answer**: *Pending*

