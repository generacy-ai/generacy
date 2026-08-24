# Feature Specification: activation test reads ambient `GENERACY_PROJECT_ID` — validate red in every cluster worker

**Branch**: `1190-summary-packages-generacy` | **Date**: 2026-08-24 | **Status**: Draft
**Workflow**: `speckit-bugfix` | **Issue**: [generacy-ai/generacy#1190](https://github.com/generacy-ai/generacy/issues/1190)

## Summary

`packages/generacy/tests/unit/deploy/activation.test.ts` asserts the browser-open
URL produced by `runActivation` **without controlling the `GENERACY_PROJECT_ID`
environment variable**. The production call site
(`packages/generacy/src/cli/commands/deploy/activation.ts:52`) reads
`process.env['GENERACY_PROJECT_ID']` deep in the call stack at invocation time, and
the test's hard-coded expectation
(`expect(mockOpenUrl).toHaveBeenCalledWith('https://generacy.ai/activate?code=ABCD-1234')`,
`activation.test.ts:89`) only holds when that variable is unset.

Consequently the test **passes** on dev laptops and GitHub Actions (variable unset)
but **fails in every Generacy cluster worker**, where `GENERACY_PROJECT_ID` is always
set — the produced URL gains an `&projectId=<id>` suffix that the assertion does not
expect.

This makes `validate` unconditionally red for any speckit run whose targeted-validate
filter drags `packages/generacy` into scope as a dependent, regardless of whether that
run's diff touches `packages/generacy` at all.

## Root Cause

`packages/generacy/src/cli/commands/deploy/activation.ts`:

```ts
const activationUrl = buildActivationUrl(
  deviceCode.verification_uri,
  deviceCode.user_code,
  process.env['GENERACY_PROJECT_ID'],   // ← ambient env, read at call time (line 52)
);
```

`buildActivationUrl` appends `&projectId=<id>` whenever `projectId` is truthy
(`activation.ts:18-20`). The test's `beforeEach` (`activation.test.ts:51-54`) runs
only `vi.resetAllMocks()` and a `console.log` spy — no `vi.stubEnv`, no
`delete process.env.GENERACY_PROJECT_ID`, no `vi.unstubAllEnvs()`. The test's outcome
is therefore a function of the ambient environment rather than the code under test.

Two independent problems compose:

1. **Environment-dependent test** — the assertion at `activation.test.ts:89` is not
   deterministic across environments.
2. **Ambient env read deep in the call stack** — `runActivation` is impure with
   respect to `GENERACY_PROJECT_ID`; the value is resolved inside the function
   instead of being passed in by the caller.

## Evidence

Worker container has the variable set:

```
$ docker exec tetrad-development-worker-7 sh -c 'echo $GENERACY_PROJECT_ID'
Hz1px7fwK8goBqgvBn6q
```

Validate failure observed on #1187 — the received value is exactly that projectId:

```
FAIL tests/unit/deploy/activation.test.ts > runActivation > calls openUrl with the verification_uri
Received:
-   "https://generacy.ai/activate?code=ABCD-1234",
+   "https://generacy.ai/activate?code=ABCD-1234&projectId=Hz1px7fwK8goBqgvBn6q",
```

Reproduction:

```bash
cd packages/generacy
GENERACY_PROJECT_ID=any-value pnpm vitest run tests/unit/deploy/activation.test.ts   # fails
pnpm vitest run tests/unit/deploy/activation.test.ts                                  # passes
```

## Impact

- **Every** speckit run in `generacy` that touches a package `packages/generacy`
  depends on (e.g. `packages/orchestrator`) drags this test into targeted validate
  (`...[origin/develop]` includes dependents) and lands red at `validate`, regardless
  of correctness.
- Each occurrence silently consumes the bounded remediate budget before failing, so
  genuine findings later in the same run have less budget. A fixer cannot repair a test
  it does not own and whose diff did not break it.
- The failure is invisible to GitHub Actions (variable unset there), so `develop`
  looks green while cluster validation is systematically broken — the env divergence
  hides the defect from normal PR review.
- Operators see `agent:error` / `failed:validate` on issues whose own code is fine,
  eroding trust in the validate signal.

## User Scenarios

### Primary: speckit run inside a cluster worker no longer fails validate for unrelated diffs

- **Given** a speckit run whose diff does not modify `packages/generacy`,
- **And** `packages/generacy` is pulled into targeted validate as a dependent,
- **And** the worker container has `GENERACY_PROJECT_ID` set,
- **When** `validate` runs `pnpm --filter ... test`,
- **Then** `tests/unit/deploy/activation.test.ts` passes,
- **And** the run does not land on `agent:error` / `failed:validate` for this reason.

### Secondary: local and CI runs remain green

- **Given** a developer laptop or GitHub Actions where `GENERACY_PROJECT_ID` is unset,
- **When** the activation test suite runs,
- **Then** all cases pass identically to today (no regression).

### Tertiary: both branches of `buildActivationUrl` are covered deterministically

- **Given** the activation test suite,
- **When** it runs in any environment,
- **Then** there is one case asserting the URL **without** a projectId and one case
  asserting the URL **with** a fixed projectId, both independent of ambient env.

## Requirements

### Functional

- **FR-001**: The activation test suite MUST pass regardless of whether
  `GENERACY_PROJECT_ID` is set in the ambient environment. The test MUST control the
  variable it depends on (via `vi.stubEnv` / `delete` with corresponding cleanup, or by
  removing the production dependency on ambient env — see FR-003).
- **FR-002**: The activation test suite MUST include one deterministic case asserting
  the projectId-free URL AND one deterministic case asserting the URL with a fixed,
  test-controlled projectId, so both branches of `buildActivationUrl` are exercised.
- **FR-003** (preferred): `runActivation` SHOULD NOT read `process.env['GENERACY_PROJECT_ID']`
  internally. The `projectId` SHOULD be threaded in through `runActivation`'s options
  object, and `process.env['GENERACY_PROJECT_ID']` resolved once at the CLI entry point
  (`packages/generacy/src/cli/commands/deploy/index.ts`). This makes `runActivation`
  pure with respect to its inputs.
- **FR-004**: Any test added/modified MUST restore environment state after itself
  (e.g. `vi.unstubAllEnvs()` in `afterEach`) so it cannot leak into sibling tests.
- **FR-005**: A sibling audit MUST be performed: grep `packages/generacy` tests for
  assertions over values derived from `process.env` without `vi.stubEnv`/isolation, and
  fix any additional env-leak occurrences found. (The truncated second failure in the
  #1187 run — `exports.test.ts:17` — MUST be investigated; if it is env-leak class it
  is in scope, if it is a separate build/import concern it MUST be documented as
  out-of-scope with rationale.)

### Non-Functional / Constraints

- **NFR-001**: No production behavior change to the activation URL itself — the URL
  produced for a given `verificationUri` / `userCode` / `projectId` MUST remain
  byte-identical to today.
- **NFR-002**: Changeset — if only test files under `packages/generacy/**` change, the
  changeset gate is test-only exempt and no `.changeset/*.md` is required. If FR-003 is
  taken (production `src/` change in `activation.ts` + `index.ts`), a
  `.changeset/1190-*.md` MUST be added: `@generacy-ai/generacy` **patch**
  (`workflow:speckit-bugfix`; internal refactor, no public export change).

## Success Criteria

- **SC-001**: `GENERACY_PROJECT_ID=any-value pnpm vitest run tests/unit/deploy/activation.test.ts`
  passes (currently fails) — the exact reproduction from the issue is green.
- **SC-002**: `pnpm vitest run tests/unit/deploy/activation.test.ts` with the variable
  unset also passes (no regression).
- **SC-003**: The suite contains explicit, deterministic coverage of both the
  projectId-present and projectId-absent URL shapes.
- **SC-004**: No test in `packages/generacy` asserts over a `process.env`-derived value
  without isolating that variable (verified by the FR-005 audit).
- **SC-005**: `pnpm --filter @generacy-ai/generacy test` passes with and without
  `GENERACY_PROJECT_ID` set.

## Out of Scope

- Changing the cloud-side meaning or format of the `projectId` query parameter.
- Adding a CI job that runs the cluster's validate command with cluster-like env vars
  (issue suggestion #4) — a valuable divergence-surfacing follow-up, but broader than
  this defect fix. Recommend filing separately.
- Fixing `exports.test.ts:17` if it is determined to be a build/import concern rather
  than an env-leak (document the determination either way).

## Assumptions

- The `&projectId=<id>` suffix is a legitimate production behavior the cloud expects;
  the fix isolates the test, it does not remove the suffix.
- `GENERACY_PROJECT_ID` is reliably present in cluster workers (per the evidence) and
  reliably absent in CI/local (per the divergent pass/fail).
