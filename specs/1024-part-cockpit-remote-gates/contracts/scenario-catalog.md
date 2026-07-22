# Contract — 8-scenario catalog

**Purpose**: One-page reference mapping each scenario in the harness to its FR, its assertion shape, and the sibling P1 issue whose deliberate 1-line breakage should produce a failure in it (SC-003).

## Scenario table

| # | Scenario | FR(s) | Owning sibling | Deliberate-break example (SC-003) |
|---|----------|-------|----------------|-----------------------------------|
| S1a | Gate open → `cluster.cockpit` event byte-equal | FR-003 | #1021 (orchestrator routes + relay emit) | Delete the `client.send({...})` call in the gate-open handler → S1a `waitForEvent` times out |
| S1b | Retain-and-replay across disconnect | FR-004 | #1021 (retention branch in `internal-relay-events.ts`) | Skip the `if (!client.isConnected) setRetained...` branch for `cluster.cockpit` → S1b sees zero events post-reconnect |
| S2 | Answer down-path (file + stdout + bus) | FR-005 | All four siblings compose here | E.g. remove the doorbell's answers-file tail invocation → doorbell.waitForEvent times out |
| S3 | Ack → outcome relay event | FR-006 | #1021 (ack route + relay emit) + #1022 (MCP tool wiring) | Return early from the ack route → peer sees no outcome event |
| S4 | Restart replay of unacked answers exactly once | FR-007 | #1023 (doorbell restart-replay logic) | Doorbell keeps a stale in-memory ack set across restart → S4 sees two emits or zero |
| S5 | `deliveryId` dedup end-to-end (both layers) | FR-008 | #1021 (file writer dedup) + #1023 (doorbell in-process dedup) | Remove the writer's `if (seen.has(deliveryId)) return;` → S5 sees two file lines |
| F1 | Malformed answer NDJSON line skipped-and-logged | FR-013 | #1023 (doorbell resilience) | Doorbell crashes on `JSON.parse` throw → F1's follow-up wait fails because child exited |
| F2 | Invalid gate-open body → 4xx + no relay event | FR-014 | #1021 (route Zod validation) | Skip validation → F2 sees an unexpected `cluster.cockpit` event |
| F3 | Answers-file rotation preserves unacked lines | FR-015 | #1023 (doorbell tail tolerates rename) | Doorbell holds a raw fd instead of re-opening on rename → F3 misses the post-rotation entry |

## Assertion primitives

Each scenario uses at most these five primitives:

1. **`peer.waitForEvent(channel, matcher, timeoutMs)`** — polls `peer.received.events`; resolves on match, rejects on timeout.
2. **`peer.sendApiRequest(method, path, body, timeoutMs)`** — round-trips through the orchestrator's api_request handler; resolves with the `api_response` frame.
3. **`doorbell.waitForEvent(predicate, timeoutMs)`** — polls parsed NDJSON stdout lines.
4. **`fetch(orchestratorUrl + path, init)`** — direct HTTP against the orchestrator, bypassing the peer. Used by S1a (gate-open injection), S3 (ack injection), F2 (invalid body).
5. **`awaitCockpitEvents(sinceCursor)`** — direct in-process call into the MCP event-bus registry to drain the same events `cockpit_await_events` would.

## SC-003 verification protocol

For each of the four P1 siblings (#1020, #1021, #1022, #1023), during PR review:

1. Reviewer applies a **1-line breakage** in the sibling's code (see "Deliberate-break example" column above for candidates — actual break to be chosen by the PR author or reviewer).
2. Re-run the harness (`pnpm --filter @generacy-ai/orchestrator test -- cockpit-gates-integration`).
3. **Expected**: at least one scenario fails with a message attributable to the seam (not a generic timeout in an unrelated scenario).
4. Restore the code, re-run — expect green.
5. Attach the failure output to the PR description as evidence for SC-003.

**Note on #1020**: The contracts sibling (#1020) has no runtime behavior on its own — it's Zod schemas + fixture builders. A "1-line breakage" for #1020 looks like changing a required field to `.optional()` in a schema, which would cause the harness's `expect(event.data).toEqual(fixture)` to still pass (the fixture is the source of truth). To exercise SC-003 for #1020, the breakage should be **in the fixture builder**: e.g., `gateOpenFixture` omits a required field → the harness's POST returns 4xx from validation → S1a fails immediately. This is the correct signal (the fixture is a public contract).

## Scenario runtime budget

| Scenario | Est. wall-clock | Bottleneck |
|----------|-----------------|-----------|
| S1a | ~1.5 s | Orchestrator boot + WS handshake + waitForEvent |
| S1b | ~2.5 s | Adds disconnect + reconnect cycle |
| S2 | ~2.0 s | Adds file poll + doorbell wait |
| S3 | ~1.5 s | Similar to S1a |
| S4 | ~4.0 s | Adds doorbell SIGTERM + respawn cycle |
| S5 | ~2.5 s | Two sendApiRequest calls |
| F1 | ~2.0 s | File append + subsequent-line wait |
| F2 | ~1.0 s | HTTP only, no WS event to await (with grace window) |
| F3 | ~3.0 s | Rotation + doorbell tolerance check |
| **Total** | **~20 s** | Well under SC-006's 30 s median target |

If per-scenario `beforeEach` (fresh orchestrator + peer + doorbell) exceeds 2 s, consider a `describe.sequential` block sharing the orchestrator across scenarios that don't need isolation — but only if empirical runtime exceeds SC-006's 30 s median.
