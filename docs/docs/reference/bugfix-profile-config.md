---
sidebar_position: 5
---

# Bugfix Profile Configuration

A copy-pasteable per-repo `.generacy/config.yaml` that opts a repository's
`speckit-bugfix` runs into the Phase-4 bugfix profile: a **verification** review
charter, a **targeted** validate command, a capped remediation budget, the
opt-in fail-then-pass regression proof, and a cheaper review model.

Everything here lives under `orchestrator.workflows.speckit-bugfix` (per-workflow
overrides) and `orchestrator.agents.workflows.speckit-bugfix` (per-workflow agent
selection). `speckit-feature` runs are unaffected — they keep the built-in
defaults unless you add a sibling `speckit-feature` block.

## `.generacy/config.yaml`

```yaml title=".generacy/config.yaml"
repos:
  dev: your-org/your-repo

orchestrator:
  workflows:
    speckit-bugfix:
      # Targeted validate: build + test only the packages affected by the diff
      # (and their dependents), resolved against origin/develop. Strictly fewer
      # suites run than a full-workspace `pnpm build && pnpm test`.
      validateCommand: 'pnpm --filter "...[origin/develop]" build && pnpm --filter "...[origin/develop]" test'
      # Cap remediation cycles. On the bugfix profile the built-in default is
      # already 2; pin it explicitly so the example is self-documenting.
      maxRemediations: 2
      review:
        # Verification charter — the review agent proves the fix, e.g. that a
        # regression test was added, rather than doing an open-ended code review.
        profile: verification
        # Only critical findings block the gate; major/minor are advisory.
        blockingSeverity: critical
        # Opt-in regression proof: execute the changed test against the BASE ref
        # (must fail) and the branch (must pass). Off by default — turn on for
        # repos where "the test actually reproduces the bug" is load-bearing.
        failThenPass: true

  agents:
    workflows:
      speckit-bugfix:
        phases:
          # Run the review phase on a cheaper/faster model — review is a
          # read-and-judge pass, not code authoring, so it rarely needs the
          # top-tier model the implement phase uses.
          review:
            model: claude-haiku-4-5-20251001
            effort: low
```

## What each knob does

| Key | Effect |
| --- | --- |
| `workflows.speckit-bugfix.validateCommand` | Targeted `--filter "...[origin/develop]"` build+test. Narrowed automatically only when it is the built-in default; setting it explicitly here pins the targeted command for this repo. |
| `workflows.speckit-bugfix.maxRemediations` | Remediation cycle cap. The gate pauses with `waiting-for:remediation-limit` if the count is reached. |
| `workflows.speckit-bugfix.review.profile` | `verification` selects the fix-proving charter instead of the `standard` open-ended review. |
| `workflows.speckit-bugfix.review.blockingSeverity` | Lowest severity that blocks the review gate. `critical` lets major/minor findings through as advisory. |
| `workflows.speckit-bugfix.review.failThenPass` | Opt-in fail-on-base / pass-on-branch regression proof. Adds one extra base-ref suite execution when on. |
| `agents.workflows.speckit-bugfix.phases.review` | Per-phase agent selection — run review on a cheaper model/effort than implement. |

## Precedence

Per-workflow settings resolve **workflow → repo → cluster default**
(`resolveWorkflowOverrides`). A key omitted here falls through to the repo-level
`orchestrator.validateCommand` (if set), then the cluster default. The review
sub-fields (`profile` / `blockingSeverity` / `failThenPass`) each resolve
independently against the built-in review baseline, so you can override just one.
