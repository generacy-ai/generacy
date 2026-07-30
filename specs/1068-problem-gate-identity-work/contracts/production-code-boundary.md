# Contract: Production-code boundary (FR-012)

**Feature**: #1068 | **Related FR**: FR-012 | **Enforcement**: `packages/orchestrator/src/__tests__/cockpit-gates/no-simulate-phase-in-src.test.ts` (NEW)

Load-bearing constraint per clarifications Q5=B: **no `SIMULATE_PHASE_*` environment variable, config flag, or code branch may exist in a shipped production code path.** All fault-injection logic lives in harness/fixture code only.

## Prohibited surface

Any identifier, string literal, environment variable, or config key matching the regular expression:

```
SIMULATE_PHASE_[A-Z]+
```

MUST NOT appear anywhere under:

- `packages/orchestrator/src/**` — EXCEPT `packages/orchestrator/src/__tests__/**`
- `packages/control-plane/src/**` — EXCEPT `packages/control-plane/src/__tests__/**`
- `packages/cluster-relay/src/**` — EXCEPT `packages/cluster-relay/tests/**`
- `packages/generacy/src/**` — EXCEPT `packages/generacy/src/**/__tests__/**`
- `packages/cockpit/src/**` — EXCEPT `packages/cockpit/src/__tests__/**`

Rationale (from clarifications.md § Q5): "A production binary carrying env-var-triggered 'behave like the broken version' branches is one misconfiguration away from being the broken version in a real cluster and inverts the meaning of every log line around it."

## Escape valve

If a specific verification item **cannot** be exercised without touching production code (i.e. the harness cannot revert Phase X's behaviour purely via fake-side configuration), that item drops to **manual attribution** per clarifications Q5:

> "If any of the seven items turns out to be un-revertable without touching production code, drop that item to A for that item and name it in the spec as manually attributed, rather than adding the production flag."

Currently, no such item exists — all three phase reverts are realizable as fake-side configuration (per `revert-scenarios.md`).

## Enforcement

### Automated (regression guard)

`packages/orchestrator/src/__tests__/cockpit-gates/no-simulate-phase-in-src.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// .../packages/orchestrator/src/__tests__/cockpit-gates → repo root (5 up)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

const TARGET_DIRS = [
  'packages/orchestrator/src',
  'packages/control-plane/src',
  'packages/cluster-relay/src',
  'packages/generacy/src',
  'packages/cockpit/src',
];

describe('FR-012 production-code boundary', () => {
  it('no SIMULATE_PHASE_* identifiers in shipped code', () => {
    // Guard against the vacuous pass: `|| true` swallows grep's "no such file"
    // exit, and execSync captures only stdout — so a wrong root or a renamed
    // package would make this assert `'' === ''` while grepping nothing.
    for (const dir of TARGET_DIRS) {
      expect(existsSync(resolve(REPO_ROOT, dir)), `grep target missing: ${dir}`).toBe(true);
    }
    // `|| true` prevents grep's exit-1 (no match) from failing execSync.
    const cmd = [
      "grep -rE 'SIMULATE_PHASE_[A-Z]+'",
      ...TARGET_DIRS,
      "--exclude-dir=__tests__ --exclude-dir=tests --exclude='*.test.ts' --exclude='*.spec.ts'",
      '|| true',
    ].join(' ');
    const output = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
    expect(output).toBe('');
  });
});
```

**Runs in the same test file group** as the FR verification items, so a rogue `SIMULATE_PHASE_A=1` env-var branch introduced in the same PR fails immediately.

### Review-time (checklist)

Reviewer confirms during PR review:
1. `git diff --stat develop..` shows no non-test files under the prohibited paths added by this PR.
2. The FR-012 grep test is present and passes.
3. Every "revert Phase X" test body uses fake-side configuration (`FakeCloudStoreOptions.persistGeneration: false`, or simply omitting `runId` in the input) — not a production knob.

## What the boundary does NOT prohibit

- **`process.env['NODE_ENV']` / `process.env['CI']` reads**: standard runtime environment probing; not phase-simulation.
- **Test-only branches inside `__tests__/`**: this whole document is about the `src/` boundary, not test code.
- **Feature flags for user-facing behaviour**: unrelated to Phase A/B/C simulation.
- **Debug logging that mentions "phase"**: e.g. `logger.info({ phase: 'implement' }, ...)` — this is workflow phase, not verification phase. The grep pattern requires the `SIMULATE_` prefix to trigger.

## Precedent

CLAUDE.md's `Development` guidance already reflects a general preference against production feature-flags where a code change can replace them. This contract makes it strict for the phase-verification simulation surface specifically.
