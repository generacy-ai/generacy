---
sidebar_position: 5
---

# Review / Remediate Dogfood Runbook

An in-repo runbook for exercising the review ⇄ remediate flow end-to-end on a live
cluster. This is a **post-merge operator step** — an automated worker cannot
restart clusters or drive live stories, so this PR does not block on the run. Tick
the boxes below as you complete each step and link the results back to the epic,
[generacy-ai/generacy#1120](https://github.com/generacy-ai/generacy/issues/1120).

Replace `<CANARY-REPO>` with the repository you dogfood on.

## Prerequisites

- [ ] A cluster tracking the channel the new packages were published to, rolled
      out per the [rollout checklist](./review-remediate-rollout.md).
- [ ] `WORKER_REVIEW_PHASE_ENABLED=true` on that cluster.
- [ ] `WORKER_CI_MERGE_GATE_ENABLED=true` if dogfooding the CI merge gate.
- [ ] `<CANARY-REPO>` has `ready_for_review` in its `ci.yml` `pull_request` types.

## Feature story

Drive one `speckit-feature` story on `<CANARY-REPO>` through the full loop:

- [ ] Kick off a feature story and let it reach `implement`.
- [ ] Confirm the `review` phase runs after `implement` and posts a COMMENT-event
      review carrying the `generacy-engine-review` marker.
- [ ] If the review returns `changes-required`, confirm `remediate` runs and a
      subsequent review round re-evaluates the delta.
- [ ] Confirm a `clean` verdict flips the PR from draft to ready for review.
- [ ] Confirm `validate` runs and, with the CI gate on, the run waits for CI to go
      green (or pauses on `waiting-for:ci` at timeout).
- [ ] Confirm the relocated `implementation-review` gate fires; approve with
      `completed:implementation-review`.
- [ ] Confirm the PR merges.
- [ ] Record findings (rounds taken, any surprises) and link them to
      [#1120](https://github.com/generacy-ai/generacy/issues/1120).

## Bugfix story

Drive one `speckit-bugfix` story on `<CANARY-REPO>` through the same loop under
the bugfix profile:

- [ ] Configure `<CANARY-REPO>` per the
      [bugfix profile](../../reference/bugfix-profile-config.md) (verification
      charter, targeted validate, `failThenPass: true`).
- [ ] Kick off a bugfix story and let it reach `implement`.
- [ ] Confirm the `review` phase uses the **verification** charter (fix-proving,
      not open-ended).
- [ ] If `failThenPass` is on, confirm the regression test fails on the base ref
      and passes on the branch.
- [ ] Confirm the remediation cap is `2` and that hitting it pauses on
      `waiting-for:remediation-limit`; resume with `completed:remediation-limit`
      and confirm the counter resets.
- [ ] Confirm the PR merges.
- [ ] Record findings and link them to
      [#1120](https://github.com/generacy-ai/generacy/issues/1120).
