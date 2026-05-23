# Feature Specification: ## Problem

The CLI's [\`reconcileWorkerCount()\`](https://github

**Branch**: `712-problem-cli-s` | **Date**: 2026-05-23 | **Status**: Draft

## Summary

## Problem

The CLI's [\`reconcileWorkerCount()\`](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts) — added by [#708](https://github.com/generacy-ai/generacy/pull/710), called by both \`npx generacy up\` and \`npx generacy update\` — has two related issues that together make the worker-scale story broken end-to-end:

### Bug 1: reads only \`cluster.yaml\`, ignores \`cluster.local.yaml\`

[worker-count-deriver.ts:32-44](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts#L32-L44) hard-codes:
\`\`\`ts
const yamlPath = join(generacyDir, 'cluster.yaml');
if (!existsSync(yamlPath)) { ... }
content = readFileSync(yamlPath, 'utf-8');
\`\`\`

But [#709](https://github.com/generacy-ai/generacy/pull/711) moved the runtime worker-count source of truth into \`cluster.local.yaml\` (worker-scaler writes only there now). The CLI's deriver never reads it, so:

1. User clicks +/+/+/+ in the cloud UI → orchestrator writes \`cluster.local.yaml: workers: 5\` and \`.env: WORKER_COUNT=5\`. Scale works.
2. User later runs \`npx generacy update\` (image refresh, channel switch, etc.) → \`reconcileWorkerCount\` reads only \`cluster.yaml\` (still \`workers: 1\` because that's the template default) → rewrites \`.env\` to \`WORKER_COUNT=1\` → \`docker compose up -d\` scales workers back to 1, destroying the 4 extras.

This **regresses the exact bug #708 was filed to fix**. The two PRs were merged in order (#710 then #711, with a rebase) but the CLI deriver was not updated to use \`readMergedClusterConfig\` during the rebase.

### Bug 2: rewrites \`cluster.yaml\` in fallback paths — directly violates #709

[worker-count-deriver.ts:156-181](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts#L156-L181):
\`\`\`ts
if (derived.source !== 'cluster.yaml') {
  const yamlPath = join(generacyDir, 'cluster.yaml');
  ...
  doc.workers = derived.workerCount;
  atomicWriteSync(yamlPath, stringifyYaml(doc));
  logger.info(\`Reconciled cluster.yaml workers to \${derived.workerCount}\`);
}
\`\`\`

When the deriver falls back (missing key, malformed value, clamped from 0), the CLI **writes back to \`cluster.yaml\`** — exactly the git-tracked-file mutation that [#709](https://github.com/generacy-ai/generacy/issues/709) was filed to eliminate. Every \`npx generacy up\` on a project with a missing/malformed \`workers\` field produces an uncommitted \`cluster.yaml\` diff in the user's working tree.

## Verified

- [worker-count-deriver.ts:32-44](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts#L32-L44) — read of \`cluster.yaml\` only
- [worker-count-deriver.ts:156-181](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts#L156-L181) — write to \`cluster.yaml\`
- [worker-scaler.ts:466-470](https://github.com/generacy-ai/generacy/blob/develop/packages/control-plane/src/services/worker-scaler.ts#L466-L470) — writes to \`cluster.local.yaml\`, not \`cluster.yaml\`
- [packages/config/src/cluster-config.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/config/src/cluster-config.ts) — the merged-read helper that the deriver should use exists, but isn't imported

The orchestrator-side readers (\`relay-bridge.ts\`, \`app-config.ts\`) correctly use \`readMergedClusterConfig\` after #709. Only the CLI was missed.

## Fix

1. **\`deriveWorkerCount\`** reads the merged config, with a degraded fallback when the local overlay is corrupt:

\`\`\`ts
import { readMergedClusterConfig } from '@generacy-ai/config';

export async function deriveWorkerCount(generacyDir: string, _logger: Logger): Promise<DeriveResult> {
  let merged;
  let source: DeriveResult['source'] = 'cluster.yaml';
  const warnings: string[] = [];
  try {
    const result = await readMergedClusterConfig(generacyDir);
    merged = result.merged;
    // source: 'cluster.local.yaml' if local supplied workers, else 'cluster.yaml'
  } catch (err) {
    // Q1=C degraded path: fall back to a cluster.yaml-only read, ignoring the broken local overlay.
    warnings.push('cluster.local.yaml unreadable; using cluster.yaml value');
    merged = await readCanonicalOnly(generacyDir); // existing malformed-YAML handling below
    source = 'cluster.yaml';
  }
  const workers: unknown = merged?.workers;
  // existing integer/clamping logic continues from here
}
\`\`\`

Notes:
- Function becomes async. Callers (\`reconcileWorkerCount\`, \`up\`, \`update\`) update accordingly.
- \`DeriveResult.source\` extended to \`'cluster.yaml' | 'cluster.local.yaml' | 'clamped' | 'default'\` (Q2=B). The degraded-read path reuses \`'cluster.yaml'\`; the warning log signals the local-corruption case.
- When \`cluster.yaml\` is absent but \`cluster.local.yaml\` provides a valid \`workers\`, the CLI uses the local value with \`source: 'cluster.local.yaml'\` and logs a warning recommending \`npx generacy init\` (Q3=B).

2. **Remove the write-back-to-cluster.yaml branch** in \`reconcileWorkerCount\`. Drop lines 156-181 entirely. If the user has \`workers: 0\` or a malformed value, the deriver returns the clamped/default value, the warning is logged, and \`.env\` gets updated — but \`cluster.yaml\` stays untouched. If the user wants to fix their hand-edit, they edit \`cluster.yaml\` themselves; the CLI shouldn't silently rewrite it.

3. **Tests**: existing tests in \`worker-count-deriver.test.ts\` need updating for async + merged-config paths. Coverage matrix (see [clarifications.md](./clarifications.md)):

   | canonical | local | result | source | warnings |
   |---|---|---|---|---|
   | present, valid | absent | canonical value | \`cluster.yaml\` | — |
   | present, valid | present, valid | local value (local wins) | \`cluster.local.yaml\` | — |
   | present, valid | present, malformed | canonical value (degraded) | \`cluster.yaml\` | local-corrupted |
   | absent | present, valid | local value | \`cluster.local.yaml\` | canonical-missing |
   | absent | absent | 1 | \`default\` | both-missing |
   | present, malformed | absent | 1 | \`default\` | canonical-malformed |
   | present, malformed | present, valid | local value | \`cluster.local.yaml\` | canonical-malformed |
   | any | any (workers: 0 or invalid) | 1 (clamped) | \`clamped\` | clamp-warning |

## Clarifications (resolved 2026-05-23)

- **Q1 → C**: When \`readMergedClusterConfig\` throws on a corrupt \`cluster.local.yaml\`, the deriver catches, falls back to a \`cluster.yaml\`-only read, and warns. Lifecycle commands keep working; the canonical value is preserved.
- **Q2 → B**: \`DeriveResult.source\` is extended with \`'cluster.local.yaml'\`. Logs and tests can accurately report local-wins.
- **Q3 → B**: When \`cluster.yaml\` is missing but \`cluster.local.yaml\` has a valid \`workers\`, use the local value and log a warning recommending \`npx generacy init\` to restore the canonical file.

## Why this needs to land before any further worker-scale testing

The current \`develop\` state has a foot-gun: scaling via the cloud UI works once, then any subsequent \`npx generacy update\` (a very common operation) silently destroys the scaled state. End-to-end testing of the worker-scale feature on a real cluster will produce confusing intermittent failures until this lands.

## Related

- [#708](https://github.com/generacy-ai/generacy/issues/708) — original \`.env\` sync issue. The worker-scaler-side fix landed correctly; the CLI-side fix has the bugs above.
- [#709](https://github.com/generacy-ai/generacy/issues/709) — \`cluster.local.yaml\` separation. The orchestrator-side migration landed correctly; the CLI deriver wasn't migrated.
- [#706](https://github.com/generacy-ai/generacy/issues/706) — the Engine-API refactor that this whole thread builds on.

## Acceptance

- \`reconcileWorkerCount\` reads \`cluster.local.yaml\` via \`readMergedClusterConfig\` and respects local-wins semantics.
- \`reconcileWorkerCount\` never writes to \`cluster.yaml\` (any path).
- \`git status\` after \`npx generacy up\` on a project with missing/malformed \`workers\` is clean.
- Regression test: scale via UI then run \`npx generacy update\` — worker count stays at the scaled value, not reset to the template default.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
