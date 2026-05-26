# Research: Handle `tier-limit-exceeded` PollResponse Variant

**Issue**: [#726](https://github.com/generacy-ai/generacy/issues/726)
**Branch**: `726-problem-generacy-cloud-700`

Each decision below cross-references a clarification (Q1–Q5) from `clarifications.md` or a structural constraint that fell out of the codebase audit.

## Decision 1 — Surface at both orchestrator and deploy callers (resolves Q1)

**Decision**: Branch on `pollResult.status === 'tier-limit-exceeded'` in **both** real consumers of `pollForApproval`:
1. `packages/orchestrator/src/activation/index.ts` (primary path; runs inside the orchestrator container during boot).
2. `packages/generacy/src/cli/commands/deploy/activation.ts` (`generacy deploy ssh://…` BYO-VM path; runs on the user's host).

The orchestrator throws `ActivationError(formatTierLimitError(...), 'TIER_LIMIT_EXCEEDED')`; the deploy command emits `console.error(formatTierLimitError(...))` and `process.exit(1)`.

**Rationale**:
- Q1 resolved A. `pollForApproval` is not called from `launch/` directly — `launch` runs `docker compose up` and tails logs, so its surface is the orchestrator log stream, which already inherits the orchestrator branch's `ActivationError` via the existing relay error-status path.
- The deploy command currently only branches on `pollResult.status === 'approved'`. Without the new branch, deploy would silently retry until `DEVICE_CODE_EXPIRED` because `tier-limit-exceeded` falls through the existing `if` and the loop iterates again with a fresh device code — the same tier-cap error would keep firing forever on bypassed-gate launches. A terminal-status branch is required to break the loop.
- Adding a `launch`-side sentinel (Q1 option D) is real UX value but out of scope per the spec's "Out of Scope" section — sibling #699's pre-poll `worker-count-resolver` gate already catches the common case before `docker compose` starts. The residual is narrow enough to file as a follow-up if reported.

**Alternatives considered**:
- B (orchestrator only): leaves deploy's poll loop in an infinite-retry-until-expired pattern when the cloud rejects on tier — broken UX.
- C (deploy only): users who run `generacy launch` (the documented happy path) would never see the cleaned-up message at all.
- D (launch-side log scanning): out of scope per spec; can be revisited if anyone reports hitting the bypass path.

**Sources**:
- `packages/orchestrator/src/activation/index.ts:79-87` — current `pollForApproval` call site (primary path).
- `packages/generacy/src/cli/commands/deploy/activation.ts:59-66` — current `pollForApproval` call site (deploy path).
- `clarifications.md` Q1.

## Decision 2 — Throw `ActivationError` with a new `TIER_LIMIT_EXCEEDED` code (resolves Q2)

**Decision**: Extend the existing `ActivationErrorCode` union in `packages/activation-client/src/errors.ts` to include `'TIER_LIMIT_EXCEEDED'`. The orchestrator branch throws `new ActivationError(formatTierLimitError(...), 'TIER_LIMIT_EXCEEDED')`, which the existing try/catch in `packages/orchestrator/src/server.ts` already catches and forwards as an `error` status via the relay (same flow as `CONTROL_PLANE_WAIT_TIMEOUT`).

**Rationale**:
- Q2 resolved A. The existing `'DEVICE_CODE_EXPIRED'` is the same shape one severity level higher — a known terminal failure mode with a clear user message and a discriminable code for downstream handlers.
- Discriminable codes matter for the relay/wizard: SC-003 requires `ActivationError.code === 'TIER_LIMIT_EXCEEDED'` so future cloud-side wizard pages can differentiate "device-code expired, retry" from "tier limit hit, upgrade or lower workers" without re-parsing the message text.
- Option B (discriminated `ActivationResult` shape with `{ kind: 'approved', ... } | { kind: 'tier-limit-exceeded', ... }`) touches every `ActivationResult` consumer across orchestrator startup — too much blast radius for one new failure mode. The current callers all expect a thrown error for non-`approved` terminal states; matching that pattern keeps the surface area small.
- Option C (generic `ActivationError` with no new code) loses programmatic discriminability for the relay/wizard. Future fix would re-introduce the code anyway.

**Alternatives considered**:
- B (return-shape change): see above.
- C (no new code, message-only): blocks SC-003.

**Sources**:
- `packages/activation-client/src/errors.ts:1-14` — `ActivationErrorCode` union.
- `packages/orchestrator/src/activation/index.ts:118-121` — existing `DEVICE_CODE_EXPIRED` throw site.
- `clarifications.md` Q2.

## Decision 3 — Title-case tier name on the cluster side (resolves Q3)

**Decision**: The formatter title-cases the first character of `tier` (`tier.charAt(0).toUpperCase() + tier.slice(1)`) before interpolation. No mapping table. No cloud-side dependency on capitalization convention.

**Rationale**:
- Q3 resolved B. The cloud's `tier: z.string()` field carries lowercase identifiers (`basic`, `pro`, `enterprise`, etc.) by convention — that's the schema in `generacy-cloud`. Inserting verbatim would yield `exceeds your basic plan limit`, which reads poorly.
- A title-case rule covers all current tiers (`basic` → `Basic`, `pro` → `Pro`, `enterprise` → `Enterprise`, `team` → `Team`) without the maintenance burden of an enumerated mapping.
- Edge cases (multi-word like `pro-plus`) still degrade gracefully to `Pro-plus`, which is acceptable and recoverable if the cloud later sends different casing — the formatter is internal to `activation-client` and can evolve.
- Implementation lives inside the shared formatter (Decision 5) so callers don't repeat the casing logic.

**Alternatives considered**:
- A (verbatim): cosmetic regression; reads poorly.
- C (mapping table): premature; rejected explicitly per spec "Out of Scope".

**Sources**:
- Existing tier conventions across `generacy-cloud` (`basic`/`pro`/etc.).
- `clarifications.md` Q3.

## Decision 4 — Spec's friendlier wording at all sites (resolves Q4)

**Decision**: Use the spec's wording at all three rejection sites:

```
Worker count of <N> exceeds your <Tier> plan limit of <M>. Upgrade your plan or retry with --workers=<M>.
```

Refactor the existing inline `throw new Error('--workers=N exceeds tier cap of M…')` in `worker-count-resolver.ts:47-52` to call the same shared formatter. Update the resolver's existing tests to assert the new message body.

**Rationale**:
- Q4 resolved C. The pre-poll resolver gate (host-side, `generacy launch`) and the cloud-side poll reject are the same conceptual error in the same workflow; users hitting them in different scenarios shouldn't see different wording.
- The spec's text is more user-friendly than the resolver's existing inline text (`--workers=N exceeds tier cap of M. Upgrade your tier or reduce --workers.`):
  - "Worker count of N" reads as plain language; `--workers=N` reads as a CLI invocation echo (fine for a CLI gate, less so when surfaced in orchestrator logs or relay error events).
  - "plan limit of M" maps to billing terminology the user already knows; "tier cap" is internal jargon.
  - "retry with --workers=M" gives an actionable remediation; "reduce --workers" is vaguer.
- The wording change does break one existing test assertion in `worker-count-resolver.test.ts` (the `--workers=100` over-cap case). That test's assertion is updated in the same PR — same change, same scope.

**Drift caveat**: the resolver's existing message also contained a context-dependent suffix when the cap came from the CLI fallback (`(CLI fallback cap; real cap will be available after the cloud companion ships)`). After the refactor, that suffix is dropped — the message becomes uniform across fallback and real-cap paths. Acceptable because:
1. The companion cloud field (`tierCap` in launch-config) has already shipped via #702, so the fallback path is increasingly rare.
2. The fallback warning text is still emitted separately via `WorkerCountResolution.warnings` (set by the resolver before the throw), so users still see the "fallback in use" context — just on a separate line rather than appended to the rejection.

**Alternatives considered**:
- A (spec text only at new site, keep resolver's existing text): preserves the wording drift the spec explicitly wants to eliminate.
- B (resolver's existing text everywhere): drops the friendlier wording and the actionable remediation. Also leaks "tier cap" jargon into orchestrator logs.

**Sources**:
- `packages/generacy/src/cli/commands/launch/worker-count-resolver.ts:42-60` — existing throw site.
- `clarifications.md` Q4.

## Decision 5 — Shared formatter location: `packages/activation-client/src/format-tier-limit-error.ts` (resolves Q4 implementation)

**Decision**: The formatter lives in `@generacy-ai/activation-client` as a new module `src/format-tier-limit-error.ts`, exported from `index.ts`. Both consumer surfaces import from the package — the orchestrator already does, and the CLI's `generacy` workspace package gains it as a `dependencies` entry in `packages/generacy/package.json`.

**Rationale**:
- The `activation-client` package is the natural home: it owns the wire-format schema and is the only existing module where every involved caller (orchestrator activate path, deploy CLI activation, `launch` CLI's resolver) can converge without introducing a new shared package.
- The `generacy` CLI workspace package already has access to `@generacy-ai/activation-client` indirectly (the deploy command imports `pollForApproval` from it). Promoting it to an explicit `dependencies` declaration is a one-line `package.json` edit — no circular-dep concerns, same monorepo workspace.
- Putting the formatter inside `activation-client` keeps the title-casing rule (Q3) and the message body (Q4) in one place, defended by a focused unit test.

**Alternatives considered**:
- Adding a new `@generacy-ai/errors` package: overkill for a 6-line pure function and one error code.
- Adding it to `@generacy-ai/config`: wrong domain — that package owns project/cluster config schemas, not activation protocol surfaces.
- Inlining at each call site: defeats the whole point of the refactor (eliminate wording drift).

**Sources**:
- `packages/activation-client/src/index.ts:1-21` — current public surface; `formatTierLimitError` joins it.
- `packages/generacy/package.json` — already lists workspace deps; adding `@generacy-ai/activation-client` is non-disruptive.
- `clarifications.md` Q4.

## Decision 6 — Poller stays silent on `tier-limit-exceeded` (resolves Q5)

**Decision**: `pollForApproval`'s new switch case is `case 'tier-limit-exceeded': return response;` — bare pass-through, no log. JSDoc updated to enumerate `'tier-limit-exceeded'` alongside `'approved'` and `'expired'` as terminal statuses. Callers (orchestrator's `ActivationLogger`, deploy's `console.error`) do the user-facing surfacing.

**Rationale**:
- Q5 resolved A. Matches the existing convention: the poller is silent on `approved` and `expired` too — both are terminal states the caller is expected to handle.
- The double-log noise of option B (`logger.warn('Activation rejected: tier limit exceeded…')` *plus* the caller's user-facing message) is operationally annoying for support: two log lines for one event, with the second containing strictly more info than the first.
- Option C (poller logs, caller is silent) inverts the convention and makes the poller responsible for user-facing wording — which is exactly what the shared formatter exists to centralize at the caller level.

**Alternatives considered**:
- B (poller logs + caller logs): noisy; rejected per Q5.
- C (poller logs, caller silent): inverts existing pattern; rejected per Q5.

**Sources**:
- `packages/activation-client/src/poller.ts:21-23` — existing JSDoc (currently mentions only `approved` and `expired`).
- `packages/activation-client/src/poller.ts:40-52` — existing switch (silent on terminal states).
- `clarifications.md` Q5.

## Decision 7 — Test file lives at existing convention `tests/unit/`, not `__tests__/`

**Decision**: Extend tests in the existing `packages/activation-client/tests/unit/` layout (`poller.test.ts`, `types.test.ts`, plus new `format-tier-limit-error.test.ts`). Do not introduce a parallel `__tests__/` root.

**Rationale**:
- FR-008 in the spec says `packages/activation-client/__tests__/poller.test.ts`. The actual package uses `tests/unit/` per the existing tree (`tests/unit/client.test.ts`, `tests/unit/poller.test.ts`, `tests/unit/types.test.ts`). Following the existing convention avoids splitting the test directory.
- The spec's path was a minor specification-time error; the tests it requires still land — just at the canonical existing location.

**Sources**:
- `packages/activation-client/tests/unit/` — existing test files.
- `spec.md` FR-008.

## Decision 8 — `pollResult.status === 'tier-limit-exceeded'` branch lands **before** the `approved` branch at both consumers

**Decision**: At both orchestrator (`activation/index.ts`) and deploy (`deploy/activation.ts`), the tier-limit branch sits between `pollForApproval` and the existing `if (pollResult.status === 'approved')` check:

```ts
const pollResult = await pollForApproval({ ... });

if (pollResult.status === 'tier-limit-exceeded') {
  // throw or exit
}

if (pollResult.status === 'approved') {
  // existing handling
}
```

**Rationale**:
- The `approved` branch's body is several lines (writes key file, builds the result object); guarding tier-limit before it keeps the error path's read order natural (handle terminal failures first, then proceed to success-side).
- Both branches end in non-fall-through (throw or return), so ordering is purely a readability question — but matching the existing `expired` flow (which is implicitly handled by falling through to the cycle retry / `DEVICE_CODE_EXPIRED` throw) means tier-limit interrupts the cycle loop without polluting the existing retry logic.

**Sources**:
- `packages/orchestrator/src/activation/index.ts:79-122` — existing structure.
- `packages/generacy/src/cli/commands/deploy/activation.ts:59-87` — existing structure.

## Decision 9 — Deploy's existing `DeployError` wrapping is bypassed for `TIER_LIMIT_EXCEEDED`

**Decision**: In `packages/generacy/src/cli/commands/deploy/activation.ts`, the tier-limit branch emits `console.error(formatTierLimitError(...))` and calls `process.exit(1)` directly — it does **not** throw an `ActivationError` for the existing try/catch to wrap into a `DeployError`.

**Rationale**:
- The existing `catch` block wraps `ActivationError` into `DeployError(..., 'ACTIVATION_FAILED', error)`. That wrapping is appropriate for `DEVICE_CODE_EXPIRED` (deploy's outer error reporter prints the wrapped message) but would re-wrap the formatted tier-limit message inside a layer of `Activation failed: ...` prefixing — the user would see `Activation failed: Worker count of N exceeds your Basic plan limit of M. Upgrade your plan or retry with --workers=M.` instead of the bare message.
- Direct `console.error` + `process.exit(1)` matches the spec's exact wording: "the deploy command's activation-polling code branches on `tier-limit-exceeded` and prints the formatted message to stderr… Process exits with code 1."
- The orchestrator path does the opposite (throws `ActivationError`) because its outer handler in `server.ts` is the *intended* surface (relay error-status push); deploy's outer handler is `DeployError` wrapping intended for cycle-level activation failures, not for cleanly-rejected user inputs.

**Alternatives considered**:
- Throw `ActivationError('TIER_LIMIT_EXCEEDED')` at deploy and let the catch wrap it: produces the double-prefix issue above.
- Add a `TIER_LIMIT_EXCEEDED` discriminator in the deploy catch block: works but duplicates the formatting logic the throw-site already did; net more code.

**Sources**:
- `packages/generacy/src/cli/commands/deploy/activation.ts:88-103` — existing catch block wrapping.

## Decision 10 — No tests for the orchestrator `server.ts` catch path or the relay error-status push

**Decision**: The PR includes unit tests for:
1. `PollResponseSchema` parses the new variant.
2. `pollForApproval` returns the variant without re-polling and without logging.
3. `formatTierLimitError` produces the exact expected message body with title-cased tier.
4. The orchestrator throws `ActivationError('TIER_LIMIT_EXCEEDED')` when the poll returns the variant.
5. The deploy command exits 1 and writes to stderr.
6. `worker-count-resolver`'s over-cap rejection uses `formatTierLimitError` (assertion against the new message text).

It does **not** include an integration test for `server.ts`'s catch path pushing an `error` status via the relay.

**Rationale**:
- That catch path is already exercised by `CONTROL_PLANE_WAIT_TIMEOUT` and `DEVICE_CODE_EXPIRED` integration tests — adding the same shape for `TIER_LIMIT_EXCEEDED` would test framework wiring, not new logic.
- The relay error-status push is structural (catch block forwards every `ActivationError` regardless of code). New code goes through unchanged paths.

**Sources**:
- `packages/orchestrator/src/server.ts` — existing try/catch around `activate()`.

## Decision 11 — Companion clients (older CLIs against new cloud) work without changes

**Decision**: No backwards-compat or shim work in this PR.

**Rationale**:
- Old clusters running pre-#726 `activation-client` will still throw `ZodError` when the new cloud emits `tier-limit-exceeded` — that's the pre-existing bug this PR fixes for current and future clusters.
- New clusters running post-#726 `activation-client` against pre-#700 clouds (which never emit the variant) work unchanged: the new union variant is additive on the parse side and the new switch case is unreachable in practice.
- No version-gated parsing, no feature flag, no graceful-degradation logic. The schema is the contract; the consumer side absorbs the existing risk.

**Sources**:
- `spec.md` "Assumptions" section.
