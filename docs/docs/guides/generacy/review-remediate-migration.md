---
sidebar_position: 3
---

# Migrating to the Review / Remediate Flow

The engine-native **review ⇄ remediate** flow adds an automated review pass after
`implement`, a bounded remediation loop that fixes what the review finds, and a
CI-aware final merge gate. This guide covers what a repository has to change to
adopt it: the CI trigger, a slimmed `validateCommand`, per-workflow config, the
two feature flags, and the gate semantics you will see on issues and PRs.

Both flags are **OFF by default**, so adopting the flow is opt-in per cluster and
the pre-epic behavior is unchanged until you turn them on.

## 1. CI trigger — add `ready_for_review`

The engine opens work as a **draft** PR and only flips it to *ready for review*
once the review verdict is `clean`. If your repository's `ci.yml` only triggers
on `opened` / `synchronize`, CI never runs while the PR is a draft — and a run
that **never executed** reports as `skipped`, which naive status rollups read as
SUCCESS.

Add `ready_for_review` to the `pull_request` `types` so CI runs the moment the
engine promotes the PR:

```yaml title=".github/workflows/ci.yml"
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
```

The CI merge gate treats `skipped` and `neutral` runs as **not passed** — a PR is
green only if every non-skipped run for the head SHA succeeded **and** at least
one run actually succeeded. Without the `ready_for_review` trigger, the gate will
correctly refuse to treat a never-run suite as passing and will pause on
`waiting-for:ci` (see [Gate semantics](#5-gate-semantics)).

## 2. Slim `validateCommand` to fast checks

When your repository's `ci.yml` owns the full test suite, the engine's in-cluster
`validate` phase does not need to re-run it. Narrow `validateCommand` to fast
local checks — lint, format, typecheck, build — and let CI carry the heavy suites:

```yaml title=".generacy/config.yaml"
orchestrator:
  validateCommand: 'pnpm lint && pnpm format:check && pnpm typecheck && pnpm build'
```

### Guardrails when the default command is auto-narrowed

If you leave `validateCommand` at the built-in monorepo default
(`pnpm build && pnpm test`), the engine classifies each diff before narrowing it
to a targeted `--filter "...[origin/<base>]"` run. The classifier is ordered and
first-match-wins:

- **Root-config diff → full run, never narrowed.** If the diff touches a
  root-only lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`),
  `pnpm-workspace.yaml`, a root `tsconfig*.json`, or anything under
  `.github/workflows/`, the full-workspace command runs. A workspace-wide config
  change can affect any package, so narrowing would be unsound.
- **Single-package repo → plain command.** If there is no `pnpm-workspace.yaml`
  at the checkout root, the diff is not narrowed — the built-in command runs as
  written. `--filter` targeting only makes sense in a workspace.
- **Docs-only diff → tests skipped.** A diff of only `*.md` / `docs/**` runs the
  build but skips tests.
- **Test-only / targeted diffs → narrowed.** Otherwise the command is narrowed to
  the affected packages and their dependents.

Setting `validateCommand` explicitly (as in the snippet above) pins your command
verbatim and bypasses auto-narrowing entirely.

## 3. Per-workflow configuration

Review/remediate knobs live under `orchestrator.workflows.<name>`. Configure
`speckit-feature` and `speckit-bugfix` independently — a key omitted from a
workflow block falls through to the repo-level `orchestrator.*` value, then the
cluster default.

```yaml title=".generacy/config.yaml"
repos:
  dev: your-org/your-repo

orchestrator:
  workflows:
    speckit-feature:
      # Fast local checks; CI owns the full suite (see §2).
      validateCommand: 'pnpm lint && pnpm typecheck && pnpm build'
      # Review↔remediate cycle cap. Default for feature runs is 3.
      maxRemediations: 3
      review:
        # Open-ended code review.
        profile: standard
        # Only critical findings block the gate; major/minor are advisory.
        blockingSeverity: critical
      # Bounded wait for CI to go green before the final gate (default 15 min).
      ciWaitTimeoutMs: 900000

    speckit-bugfix:
      validateCommand: 'pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test'
      # Bugfix runs default to 2.
      maxRemediations: 2
      review:
        # Fix-proving charter instead of open-ended review.
        profile: verification
        blockingSeverity: critical
        # Opt-in fail-on-base / pass-on-branch regression proof.
        failThenPass: true
```

For the full bugfix profile — including per-phase agent selection (running review
on a cheaper model) — see
[Bugfix Profile Configuration](../../reference/bugfix-profile-config.md). This
guide does not duplicate it.

## 4. Feature flags (both default OFF)

| Env var | Config key | Default | Enables |
| --- | --- | --- | --- |
| `WORKER_REVIEW_PHASE_ENABLED` | `reviewPhaseEnabled` | `false` | The `review` phase and its remediation loop after `implement`. |
| `WORKER_CI_MERGE_GATE_ENABLED` | `ciMergeGateEnabled` | `false` | CI-aware merge readiness (skipped ≠ passed) and the relocated post-validate approval gate. |

With both OFF the run sequence and observable behavior are byte-identical to the
pre-epic flow. The two flags are independent — you can enable the review phase
without the CI merge gate, or vice versa.

## 5. Gate semantics

### `waiting-for:remediation-limit`

Fires when `remediationCount` reaches the workflow's `maxRemediations` cap while
the review verdict is still `changes-required`. The engine pauses with
`waiting-for:remediation-limit` + `agent:paused` and posts the surfaced open
findings as an issue comment.

- **Inspect** the surfaced findings on the issue.
- **Resume** by adding `completed:remediation-limit`. On resume the engine resets
  the remediation counter to `0` and clears the label so the gate re-arms.

This replaces the retired `blocked:stuck-feedback-loop` dead-end — that label
stranded a run permanently with no resume path. `waiting-for:remediation-limit`
is a resumable pause, not a terminal block.

### `implementation-review` (relocated)

The final human-approval gate. With the CI merge gate enabled it fires on
**`validate`** completion — but only once CI is confirmed green for the head SHA.
(With the flag off it stays on `implement` as before.) Approve by adding
`completed:implementation-review`.

### `waiting-for:ci`

When `validate` succeeds but CI has not yet gone green, the engine waits with a
bounded exponential backoff up to `ciWaitTimeoutMs`. If CI is still pending at the
timeout, it pauses with `waiting-for:ci` + `agent:paused` rather than treating a
pending or skipped run as passing. Resume by adding `completed:ci` once CI is
green (or once you have manually confirmed merge readiness).
