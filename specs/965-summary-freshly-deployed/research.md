# Research: smee.io provisioner fix (#965)

## Live smee.io `/new` behavior (verified 2026-07-16)

Verified live from the affected cluster's network:

| Request | Result |
|---|---|
| `POST https://smee.io/new` (what we do today) | **200**, `content-length: 0`, **no `Location`** — a no-op |
| `GET  https://smee.io/new` | **307** → `location: https://smee.io/<channel>` |
| `HEAD https://smee.io/new` | **307** → `location: https://smee.io/<channel>` |

Both `GET` and `HEAD` mint a valid channel. Returned URLs (e.g. `https://smee.io/3dCinhK6djyd2yK`) match the existing `SMEE_URL_PATTERN` regex. `POST` is silently no-op.

## History of the failing code path

- **Introduced**: #952, commit `d0bafbcd`, 2026-07-15. `SmeeChannelResolver.provision()` was written from the start with `method: 'POST'` + `if (response.status !== 302)`. There is no earlier commit with `redirect: 'follow'`; this is not a regression from a follow-vs-manual flip. `POST`+`302` was smee.io's contract at the time #952 landed.
- **Discovered**: 2026-07-16, one day after landing. Fresh preview-channel cluster boot logs:
  ```
  {"level":40,"attempts":2,"lastError":"unexpected status 200","msg":"Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling"}
  {"level":40,"remediation":["SMEE_CHANNEL_URL","orchestrator.smeeChannelUrl"],"msg":"No smee channel configured; polling fallback active"}
  {"level":30,"intervalMs":10000,"reason":"webhooks-not-configured","msg":"Webhooks appear unhealthy, increasing poll frequency"}
  ```
- **Test gap**: `smee-channel-resolver.test.ts:10-15` defines `make302(location)` and every provisioning test uses it. No test ever constructed a real-shaped response from a live probe; the failing branch (`response.status !== 302` in the wild) was never exercised.

## Decisions

### D1 — Acceptance predicate: broad 3xx range

**Decision**: `response.status >= 300 && response.status < 400`.

**Rationale** (clarification Q1 → B):
- Smee.io has already silently flipped once on both axes (`302 → 307`, `POST → GET`); a strict `[301, 302, 307, 308]` set gains us nothing when the next flip could as easily land on `303 See Other` or a re-introduction of `302`.
- The `Location` re-validation against `SMEE_URL_PATTERN` degrades safely for the corner-case statuses inside the broad range (`304`/`305`/`306`) — they carry no valid smee `Location` and fail the pattern check anyway, falling through to the same `Location does not match SMEE_URL_PATTERN` branch that already exists.
- Two lines of defense (status + `Location` pattern) hedges the failure mode we actually care about (silent upstream flip) while keeping the second gate honest (malicious/malformed `Location` still rejected).

**Alternatives considered**:
- **A**: Explicit set `[301, 302, 307, 308]`. Rejected because it re-introduces the exact tight coupling that broke us. Any future flip lands us back at "unexpected status" and another emergency PR.
- **C**: Explicit set widened to `[301, 302, 303, 307, 308]`. Rejected because it's redundant under B (`303` is inside `>= 300 && < 400`) and inconsistent with the spec's stated hedge.

### D2 — HTTP method: GET

**Decision**: `method: 'GET'`.

**Rationale** (clarification Q2 → A):
- Empirically verified: `GET https://smee.io/new` returns `307` with a valid `Location`. This is the path we tested against the live endpoint.
- Universal support — no known intermediary (corporate proxy, mitmproxy dev tooling, service mesh) mangles `GET`.
- Matches manual curl-in-terminal debugging conventions; a developer reproducing the bug locally will `curl https://smee.io/new` and see the exact behavior the resolver invokes.

**Alternatives considered**:
- **B**: `HEAD`. Rejected because `HEAD`'s only advantage (no response body, ~66 bytes saved) is negligible against `GET`'s universal support and lower exposure to intermediary/proxy `HEAD`-handling quirks. Some intermediaries drop `HEAD` support entirely or normalize `HEAD` to `GET`, either of which could mask a smee.io behavior change locally.

### D3 — Preserve `redirect: 'manual'` (not `follow`)

**Decision**: Keep `redirect: 'manual'`. Do not switch to `redirect: 'follow'`.

**Rationale** (spec §Out of Scope):
- `redirect: 'manual'` preserves the `SMEE_URL_PATTERN` validation on the raw `Location` header. With `follow`, we'd validate the final resolved URL after fetch traverses the redirect — this requires trusting the intermediate chain (any 30x could redirect elsewhere) and gains us nothing since the smee.io redirect is a single hop to a self-hosted URL we control.
- Smaller change footprint. The three edits stay inline in `provision()` without touching the request lifecycle.

### D4 — Rejection message wording: ship in this PR

**Decision**: Change `` `unexpected status ${response.status}` `` → `` `expected 3xx with Location, got ${response.status}` `` in the same edit.

**Rationale** (clarification Q3 → A):
- The line being edited (`lastError = ...`) is the same line targeted by FR-002. Incremental cost is effectively zero.
- Deferring would leave FR-007 of this issue unimplemented — spec/impl drift.
- The improved wording is the diagnostic that would surface the next upstream drift from logs alone. On a `200`-empty response, the log line becomes `expected 3xx with Location, got 200` — an operator sees at a glance that smee.io is no longer returning a redirect.

**Alternatives considered**:
- **B**: Defer to a follow-up PR. Rejected because it drops the exact diagnostic we need to detect the next flip, and forces a second PR that touches the same line.

### D5 — Test file shape

**Decision**: Generalize `make302(location)` at `smee-channel-resolver.test.ts:10-15` into `makeRedirect(status, location)`. Add three new tests that share it.

**Rationale**:
- The current mock is the root cause of shipping this bug uncaught — it hand-builds `Response(status: 302)` for every provisioning case, so the failing branch was never exercised against a real-shaped response.
- SC-002 demands three specific fixtures (`307`-with-`Location`, `200`-empty, `3xx`-with-invalid-`Location`) — a shared `makeRedirect(status, location)` helper is the smallest change that unblocks all three without duplicating 5 lines of `Response`-building.
- Existing tests using `make302` continue to pass unchanged — either by keeping `make302` as a thin wrapper (`makeRedirect(302, location)`) or by mechanically updating the ~10 call sites to `makeRedirect(302, location)`. Either shape is fine; the file convention already tolerates helper renames.

**Alternatives considered**:
- Add per-test inline `new Response(null, { status, headers })` boilerplate. Rejected — three new tests × ~5 lines of `Response`-building is worse than one helper rename.
- Snapshot the live smee.io response and replay via nock/undici mocking. Rejected — heavy dependency for a resolver that already injects `fetch` via `SmeeChannelResolverOptions.fetch`.

### D6 — No changes to retry envelope

**Decision**: `MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 1000`, `HTTP_TIMEOUT_MS = 5000` all unchanged (FR-006).

**Rationale**:
- The retry envelope was correct behavior all along — the failure was in the predicate the envelope wrapped, not in the envelope itself. A working provisioner will typically succeed on attempt 1; the 2-attempt budget with 1s backoff is enough for transient network hiccups without stalling boot.
- Changing retry policy would broaden the PR scope and invite regression in a working code path (spec §Out of Scope).

## Implementation patterns

### Fetch injection

`SmeeChannelResolverOptions.fetch` is already the injection seam for tests (see resolver ctor `this.fetchImpl = options.fetch ?? globalThis.fetch`). New tests use the same `vi.fn().mockResolvedValue(makeRedirect(...))` pattern already established at `smee-channel-resolver.test.ts:109` etc.

### Response construction

`new Response(null, { status, headers: new Headers({ Location: location }) })` is the DOM-standard shape used throughout the existing test file. A `null` body is fine — `redirect: 'manual'` means the resolver never reads the body.

### Fastify/Pino logger shape

The resolver's `Logger` interface (`smee-channel-resolver.ts:17-24`) is compatible with the existing test `mockLogger` pattern in `smee-channel-resolver.test.ts`. No new fields, no new methods.

## Key sources / references

- **Root file**: `packages/orchestrator/src/services/smee-channel-resolver.ts:132-168` — the `provision()` method being fixed.
- **Test file**: `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts` — where the three new tests land.
- **Introducing PR**: #952 (commit `d0bafbcd`, 2026-07-15) — added `SmeeChannelResolver` with the `POST`+`302` assumptions.
- **Sibling test files** (unchanged): `server-smee-provisioning.test.ts`, `server-smee-fallback-warning.test.ts`, `server-smee-opt-out-info.test.ts` — server-level integration tests exercising the resolver through `createServer()` wiring. Confirmed via `grep POST` / `grep method:` that none of these assert on the request method, so the `POST`→`GET` flip is transparent.
- **Spec**: `specs/965-summary-freshly-deployed/spec.md`.
- **Clarifications**: `specs/965-summary-freshly-deployed/clarifications.md` — Q1 (broad 3xx range), Q2 (GET not HEAD), Q3 (ship FR-007 in this PR).
- **Smee.io observed behavior**: verified live 2026-07-16 from the affected cluster's network. See spec §Root cause for the request/result table.
