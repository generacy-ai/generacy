# Contract: Config resolution for the four wired keys

Behavioral contract each key must satisfy after this feature. Each row is an
acceptance assertion for the round-trip test that pins it (FR-008). "Reaches"
means the resolved value is the argument observed at the named runtime call site
for a job whose `workflowName` matches.

## `validateCommand` (FR-001 / FR-002 / SC-001)

- Given `orchestrator.workflows.speckit-feature.validateCommand = "X"`, a
  `speckit-feature` job's validate phase MUST spawn `"X"` (not the cluster
  default).
- Precedence: `workflows.<name>.validateCommand` → `settings.validateCommand`
  (repo) → `config.validateCommand` (cluster). First non-nullish wins.
- `speckit-bugfix`: the per-workflow override is honored **and** the existing
  `resolveTargetedValidate` narrowing still applies on top of the resolved
  command (targeted narrowing composes over the resolved base).
- Call site: `effectiveValidateCommand` seed at phase-loop.ts:696.

## `preValidateCommand` (FR-003 / FR-004 / SC-002)

- Given `workflows.<name>.preValidateCommand = "Y"`, the pre-validate install
  step MUST run `"Y"` for that workflow.
- Given `workflows.<name>.preValidateCommand = ""` (empty string), the install
  step MUST be **skipped** for that workflow (not fall back to the default).
- Given the key unset, repo then cluster defaults apply (fall-through).
- Empty (skip) vs unset (fall back) distinguished by `??` preserving `""` +
  the existing `if (cmd)` truthiness guard — no new branch.
- Call site: install guard at phase-loop.ts:662.

## `phases.review` / `phases.remediate` agent (FR-005 / SC-003)

- Given `agents.workflows.<name>.phases.review = { model: "M" }`, the review
  executor MUST resolve `model = "M"` while inheriting the **implement** agent's
  provider and effort (field-by-field fallback).
- Given `phases.review` unset, the review executor MUST resolve exactly the
  implement agent (no behavior change vs today).
- Given `phases.remediate` unset, the remediate executor MUST fall back to the
  **implement** agent — never to `phases.review` (Q3=A).
- Given `phases.remediate = { provider: "P" }`, the remediate executor MUST
  resolve `provider = "P"` with implement model/effort.
- Resolution function: `resolveReviewLikeAgent(config, workflowName, phase)`.
- Call sites: review-executor.ts:126, remediate-executor.ts:98.

## `ciWaitTimeoutMs` (FR-006 / SC-004)

- The documented per-workflow YAML
  `orchestrator.workflows.<name>.ciWaitTimeoutMs: <ms>` MUST parse
  (`WorkflowOverrideSchema` accepts it).
- An unknown key under `workflows.<name>` MUST still be rejected (`.strict()`
  preserved).
- Given `workflows.<name>.ciWaitTimeoutMs = N`, the CI-wait call for that
  workflow MUST use `N` (precedence: workflow → `config.ciWaitTimeoutMs`
  cluster base; no repo tier).
- A value `< 30_000` or non-integer MUST be rejected at parse time.
- Call site: `waitForCiGreen({ ciWaitTimeoutMs })` at phase-loop.ts:1333.

## Governing principle (FR-007 / SC-005)

No key named in this spec may be silently ignored: each either changes runtime
behavior (validateCommand, preValidateCommand, agent selection, ciWaitTimeoutMs
resolution) or is rejected at parse time (malformed `ciWaitTimeoutMs`, unknown
keys). Zero silent drops — pinned by the per-key round-trip tests.
