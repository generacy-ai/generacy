# Clarifications — #952

## Batch 1 — 2026-07-16

### Q1: Provisioning HTTP timeout
**Context**: FR-003 requires a bounded timeout for `POST https://smee.io/new` so startup cannot hang, but the concrete value is explicitly deferred to this round. The choice sets the worst-case first-boot startup delay when smee.io is slow/unreachable, and it interacts with the "fail-open and continue" semantics in FR-006 / US3.
**Question**: What connect+response timeout (in seconds) should the provisioning `POST /new` request use?
**Options**:
- A: 2 seconds (aggressive — prioritises fast boot on flaky networks; higher chance of a false negative provision when smee.io is briefly slow)
- B: 5 seconds (moderate — comfortable margin over typical smee.io latency; still trivial vs. normal boot)
- C: 10 seconds (conservative — matches existing HTTP-timeout convention elsewhere in the orchestrator; noticeable if it hits)

**Answer**: *Pending*

### Q2: Startup ordering — blocking vs. background
**Context**: The spec is silent on *when* during orchestrator startup provisioning runs. Options range from synchronous (server construction blocks on provisioning before `server.listen()`) to fully async (fire-and-forget after listen so `/health` responds immediately). This determines whether a slow smee.io affects the readiness signal that CLI/cloud paths poll on, and whether webhook wiring is guaranteed by the time the first GitHub event could arrive.
**Question**: Should smee provisioning block orchestrator startup, or run asynchronously in the background?
**Options**:
- A: Synchronous before `server.listen()` — cluster is not "ready" until channel is resolved and (if applicable) `ensureWebhooks` has run; a hung timeout can delay listen by the FR-003 timeout budget.
- B: Synchronous after `server.listen()` but before wizard/activation completes — `/health` responds immediately; smee resolves before any real workload begins.
- C: Fully async fire-and-forget — startup never waits; smee wires up whenever it wires up; first webhook events after boot may fall back to polling until it lands.

**Answer**: *Pending*

### Q3: Corrupt or invalid persisted-file content
**Context**: FR-005 says "if the persisted file exists and contains a non-empty URL, it is used". It does not say what "URL" means (any non-empty string? URL-shape? must be a smee.io host?), nor what to do when the file is present but malformed (e.g. truncated write from a prior crash, hand-edited garbage, or a stale non-smee URL). Treating anything non-empty as authoritative could wire the receiver against nonsense; failing loud on any oddity could brick clusters on trivially recoverable corruption.
**Question**: When the persisted file exists but its content is not a well-formed `https://smee.io/<id>` URL, what should the orchestrator do?
**Options**:
- A: Re-provision — treat malformed content as "no valid persistence", mint a fresh channel, overwrite the file, log a warn line. (Recovers automatically; risk of silently orphaning a webhook that was pointing at the old contents.)
- B: Fail-open without re-provisioning — log warn, do not use file, do not mint, continue startup webhook-less until the next restart or manual fix.
- C: Fail-loud — refuse to start; operator must delete/fix the file. (Safest against orphan accumulation; worst blast radius if the file is corrupted in the field.)

**Answer**: *Pending*

### Q4: Retry policy within a single boot
**Context**: FR-006 mandates non-fatal degradation on provisioning failure, and US3-AC3 covers recovery on *the next restart*. The spec is silent on whether a single boot should retry a transient smee.io failure before giving up (e.g. DNS blip, momentary 5xx). Retrying multiplies the worst-case startup impact by the retry count × timeout; not retrying loses easily-recoverable transient failures.
**Question**: How many provisioning attempts should the orchestrator make within a single boot before degrading to polling?
**Options**:
- A: 1 attempt, no retries — simplest, tightest startup budget, next restart is the recovery path.
- B: 2 attempts with a short fixed delay (e.g. 1s) — cheap protection against a single transient blip.
- C: 3 attempts with exponential backoff (e.g. 1s, 2s) — matches the pattern used in `activation/` for cloud calls; slowest worst-case.

**Answer**: *Pending*

### Q5: Provisioning succeeds but persistence write fails
**Context**: FR-004 requires atomic write of the newly-provisioned channel URL. What happens when the `POST /new` succeeds (channel exists on smee.io, `ensureWebhooks` could create a GitHub webhook against it) but the local write fails (disk full, permission surprise, volume not mounted rw despite the assumption)? Using the channel-in-memory would wire GitHub webhooks against a URL we cannot reproduce on next boot, guaranteeing an orphaned webhook per restart — the exact failure mode the persistence-mandatory design is meant to prevent.
**Question**: If provisioning succeeds but persistence to `/var/lib/generacy/smee-channel` fails, how should the orchestrator proceed?
**Options**:
- A: Do not use the channel — log error at warn level, drop the in-memory URL, skip `SmeeWebhookReceiver` and `ensureWebhooks`, continue startup webhook-less. Prevents orphan accumulation across restarts.
- B: Use the channel this boot but skip `ensureWebhooks` — connect the receiver for local event flow but do not register a GitHub webhook (avoids orphan on next restart while keeping partial function).
- C: Use the channel and register the webhook — accept the orphan-per-restart risk on the theory that persistence-write failures are rare enough that partial function beats none.

**Answer**: *Pending*
