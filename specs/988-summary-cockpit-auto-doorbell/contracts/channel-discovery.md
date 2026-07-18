# Contract: `channel-discovery.ts` — webhook-config stage (FR-001, FR-002, FR-004…FR-010)

**Module**: `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts`

**Public API** (extended, backwards-compatible):

```ts
export async function discoverChannelUrl(
  input: ChannelDiscoveryInput,
): Promise<ChannelDiscoveryResult | null>;

export function pickSmeeHook(hooks: SmeeHook[]): SmeeHook | null;

export type ChannelSource =
  | 'env'
  | 'webhook-config'   // NEW
  | 'workspace-walkup'
  | 'workspace-absolute'
  | 'file';
```

See `data-model.md` for `ChannelDiscoveryInput`, `SmeeHook`, `ChannelDiscoveryResult`.

## Lookup order (FR-004)

The function returns on the first stage that yields a URL matching
`SMEE_URL_PATTERN` (`/^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`).

1. **`env[COCKPIT_DOORBELL_SMEE_URL]`** — unchanged.
2. **`webhook-config` stage** — NEW. Runs when `input.runner != null` **and**
   `input.targets != null && input.targets.length > 0`. Otherwise, silently
   skipped (no warn) and discovery advances to walk-up.

   Per-target loop, primary-first (FR-008):
   - Invoke:
     ```
     runner('gh', ['api', `/repos/${owner}/${repo}/hooks`], {
       timeoutMs: input.webhookConfigTimeoutMs ?? 5_000,
     })
     ```
   - `exitCode !== 0` (including `124` timeout signal): warn one line
     `cockpit doorbell: webhook-config stage failed for <owner>/<repo>: exit=<code>` and advance.
   - `stdout` fails `JSON.parse`: warn one line
     `cockpit doorbell: webhook-config stage: malformed JSON for <owner>/<repo>` and advance.
   - Zod parse via `z.array(SmeeHookSchema)`: on failure, warn one line
     `cockpit doorbell: webhook-config stage: unexpected /hooks shape for <owner>/<repo>` and advance.
   - `pickSmeeHook(parsed) == null`: **silent** (no warn — zero-match is a routine "no hook here, try next repo" outcome per FR-006), advance.
   - `pickSmeeHook(parsed) != null`: return `{ url: hook.config.url, source: 'webhook-config' }` immediately.

   After exhausting all targets, fall through to walk-up.

3. **Walk-up scan** — unchanged.
4. **Absolute `workspaceMirrorPath`** — unchanged.
5. **Cluster-internal `channelFilePath`** — unchanged.

## `pickSmeeHook` — tie-break (FR-005)

Pure function. Given `SmeeHook[]`:

1. Filter to `hook.active === true`.
2. Filter to `SMEE_URL_PATTERN.test(hook.config.url)`.
3. Sort by `Date.parse(hook.updated_at)` desc; entries where the parse yields
   `NaN` sort last (treated as `-Infinity`).
4. Return `sorted[0] ?? null`.

Deterministic. Zero I/O. No side effects.

## Timeout behavior (FR-009)

- The runner's `timeoutMs` option bounds the underlying `gh` invocation.
  `nodeChildProcessRunner` returns `exitCode: 124` on timeout — the stage
  treats this identically to any other non-zero exit and falls through.
- Default: `5_000ms`. Overridable via `input.webhookConfigTimeoutMs` for tests.
- Timeout emits one warn line (per SC-005 — bounded startup latency is
  observable to the operator).

## Cost budget (FR-007, SC-002)

- Exactly one `gh api …/hooks` invocation per target repo per doorbell
  startup.
- At most `targets.length` invocations (typically 1 — orchestrator registers
  the same channel across every watched repo, so the primary usually
  resolves in one call).
- Zero invocations after startup.

## Guarantees

- **Never throws.** All errors fold into either a next-target attempt, a
  next-stage attempt, or a `null` return.
- **No `cwd` mutation.**
- **Backwards compatible.** Callers omitting `targets`/`runner` see identical
  behavior to today.

## Warn-line surface

- `cockpit doorbell: webhook-config stage failed for <owner>/<repo>: exit=<code>`
- `cockpit doorbell: webhook-config stage: malformed JSON for <owner>/<repo>`
- `cockpit doorbell: webhook-config stage: unexpected /hooks shape for <owner>/<repo>`
- (Existing warn lines from stages 3–5 unchanged.)

**No warn line** for zero-match (routine).

## Test scaffolding

Vitest specs in `__tests__/channel-discovery.test.ts`. Adds 7 cases on top of the existing 9:

1. **W1 — webhook-config hit, primary target**: `runner` returns a
   `[{ id:1, active:true, config:{ url:'https://smee.io/abc' }, updated_at:'…' }]`
   payload for the primary repo; expect
   `{ url: 'https://smee.io/abc', source: 'webhook-config' }`.
2. **W2 — stale + fresh tie-break**: two active smee hooks with distinct
   `updated_at`; expect the newer `updated_at` wins (regression for SC-004).
3. **W3 — multi-repo primary-first**: `targets = [{primary}, {sibling}]`; primary
   has a smee hook; expect the primary's URL and exactly **one** runner call.
4. **W4 — multi-repo fallback to sibling**: primary has no smee hook (empty array
   or non-smee-only), sibling has one; expect the sibling's URL and exactly
   **two** runner calls.
5. **W5 — 403 fall-through**: runner returns `exitCode: 1` with stderr
   containing `HTTP 403`; expect fall-through to walk-up + one warn line.
6. **W6 — timeout fall-through**: runner returns `exitCode: 124`; expect
   fall-through to walk-up + one warn line.
7. **W7 — no-runner no-op**: `runner` omitted, `targets` provided; expect the
   webhook-config stage to be a silent no-op and discovery to reach walk-up
   without any warn line.

Additional case in `doorbell-source-branch.test.ts` (regression for SC-001):

- **B1**: Stub a runner that returns a smee-pattern hook and no env/FS setup;
  assert the `SourceSelector` stderr line reads `source=smee reason=startup-smee-selected`.

## Deferred / out of scope

- Mid-run re-read of hooks (spec §"Out of Scope" — one call at startup is
  authoritative for the session).
- Aggregate multi-repo channel-divergence detection (rejected in Q2).
- New `gh` scope grants (spec §"Out of Scope").
