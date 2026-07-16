# Feature Specification: auto.md request-changes postcondition legs can't pass against GitHub's real API shapes

**Branch**: `961-summary-auto-md-request` | **Date**: 2026-07-16 | **Status**: Draft

## Summary

The `auto.md` request-changes guardrail (D.2 / `contracts/postcondition-check.md`) verifies a
posted review with two "legs." As written, **both legs compare against fields/values that GitHub's
real API does not return in the compared shape**, so a *literal* implementation fails the
postcondition on every successful `request-changes` POST — triggering an unnecessary retry
(posting a duplicate review) and then re-presenting the G.2 verdict gate with a spurious
`postcondition failed after retry` notice, even though the review landed perfectly.

Observed while posting the review-changes on `christrudelpw/snappoll#2`, `#7`, `#8`, and `#13`
during the snappoll `/cockpit:auto` run; each POST genuinely succeeded, and the postcondition had
to be verified against *different* fields than the contract specifies. The double-post did not
occur only because those runs were verified by hand against the correct fields — following the
contract verbatim would have double-posted every one of them.

## The two mismatches

### Leg 1 — `response.comments.length` does not exist

The contract compares `response.comments.length == bundle.comments.length` against the POST
response of `POST /repos/{o}/{r}/pulls/{n}/reviews`. That response object has **no `comments`
field**. Its keys (observed): `_links, author_association, body, commit_id, html_url, id, node_id,
pull_request_url, state, submitted_at, user`. A literal read of `response.comments` is `undefined`,
so `undefined.length` throws or the comparison fails.

**Actual source of truth**: the inline comments must be read from a *separate* endpoint —
`GET /repos/{o}/{r}/pulls/{n}/comments` — filtered to `pull_request_review_id == response.id`.
Verified on `snappoll#2`: bundle had 1 comment, the POST response reported no `comments` field,
and `GET …/pulls/2/comments` showed exactly 1 comment with `pull_request_review_id` matching the
returned review `id`.

### Leg 2 — bot login suffix differs between REST and GraphQL

The contract filters `reviewThreads` to `comments.nodes[0].author.login == <acting-bot-login>`,
where `<acting-bot-login>` is taken from `gh api graphql '{ viewer { login } }'`. But the acting
identity renders **differently across APIs**: REST reports `generacy-ai[bot]` while the GraphQL
`Bot` type reports `generacy-ai` (no `[bot]` suffix). Whichever string the contract binds
`<acting-bot-login>` to, a strict `==` against the other API's rendering fails.

Verified on `snappoll#2`: REST `pulls/{n}/comments[].user.login` = `generacy-ai[bot]`; GraphQL
`reviewThreads…author.login` = `generacy-ai`. Same actor, two strings.

## Impact

On **every** successful `request-changes` review executed against the contract verbatim:

1. Leg 1 reads `undefined` → postcondition "fails" → the guardrail sleeps 2000 ms and retries
   the POST once (posting a **second, duplicate** review), then "fails" again → re-presents the
   G.2 gate with a spurious `postcondition failed after retry` notice.
2. Even if Leg 1 were fixed, Leg 2's `==` on the bot login fails for the same reason.

So the guardrail as literally specified is a no-op-to-harmful wrapper: it never confirms a real
success, and it double-posts reviews. The snappoll runs escaped the double-post only because they
were verified by hand against the correct fields — nothing about the contract as written prevented
it.

## Proposed fix

Two documents change together in the same PR:

- `specs/422-summary-auto-md-s/contracts/postcondition-check.md` — Leg 1 and Leg 2 rules.
- `packages/claude-plugin-cockpit/commands/auto.md` — D.2 four-step guardrail step 4 prose (points
  at the contract; the mismatched shape references in the prose are corrected in lockstep).

Both files live in the **agency** repo (`/workspaces/agency`). This spec branch lives in generacy;
the implementation PR targets agency. Cross-repo tracking is out of scope for this spec — the
mechanic for it is #899 territory.

### Leg 1 fix

Verify inline comments via `GET /repos/{o}/{r}/pulls/{n}/comments`, filtered client-side to
`pull_request_review_id == response.id`, and compare **that** count to `bundle.comments.length`.
Do not read `response.comments`. Ledger and retry semantics unchanged.

### Leg 2 fix

Compare the thread author to the acting identity using a **suffix-insensitive match**: strip a
trailing `[bot]` from the REST login (or, symmetrically, allow the GraphQL `login` to match a REST
login with `[bot]` removed). The canonical rule (rendered in the contract): compare
`stripBotSuffix(threadAuthorLogin)` to `stripBotSuffix(actingLogin)`, where
`stripBotSuffix(s) = s.replace(/\[bot\]$/, '')`.

**Alternative considered and preferred as a secondary key**: key Leg 2 off
`pull_request_review_id` (as in Leg 1) rather than author login at all. This removes the identity
question from Leg 2 entirely — the review threads GitHub returns are guaranteed to carry a
`pull_request_review_id` matching the POST response's `.id`. This is stricter *and* simpler, and
we adopt it as the primary rule; the suffix-insensitive login match remains as a fallback for the
handful of thread shapes where `pull_request_review_id` is not populated on the first-comment node
(none observed, defensive).

## User Stories

### US1: A successful request-changes POST passes the postcondition on the first attempt (P1)

**As a** cluster operator running `/cockpit:auto` on a PR that needs review-changes,
**I want** the postcondition to confirm the POST landed against the fields GitHub actually
returns,
**So that** the guardrail does not re-post duplicate reviews or re-present G.2 with a spurious
"postcondition failed" notice on every successful review.

**Acceptance Criteria**:
- [ ] A single-comment `request-changes` POST against a real PR passes the postcondition on the
      first attempt — no retry, no re-present, no ledger `postcondition-failed` line.
- [ ] Leg 1 reads `GET /repos/{o}/{r}/pulls/{n}/comments` filtered to
      `pull_request_review_id == response.id`; it never dereferences `response.comments`.
- [ ] The 2000 ms retry backoff (single-shot) remains unchanged and only fires on a genuine
      failure.
- [ ] The G.2 re-present notice text is unchanged; only the trigger changes (from "always" to
      "genuine failure only").

### US2: The bot login is recognized as the same identity across REST and GraphQL (P1)

**As a** cluster operator,
**I want** the postcondition's Leg 2 filter to treat `generacy-ai` and `generacy-ai[bot]` as the
same actor,
**So that** Leg 2 does not fail on every successful POST because of a suffix rendering
difference between the two APIs.

**Acceptance Criteria**:
- [ ] Leg 2's primary rule keys on `pull_request_review_id == response.id`, mirroring Leg 1's
      source of truth.
- [ ] The suffix-insensitive login match (`stripBotSuffix`) is defined as the fallback for
      thread nodes without a populated `pull_request_review_id`.
- [ ] The rule renders identically whether the acting login was captured via REST or GraphQL
      (round-trip test: swap the source, same verdict).
- [ ] The `first: 50` page size and `≥ bundle.comments.length` bound are unchanged.

### US3: A regression test asserts the postcondition passes for a known-good POST and fails for a genuine drop (P2)

**As a** future maintainer of D.2 / `postcondition-check.md`,
**I want** a regression test that pins the postcondition to real API shapes,
**So that** a contract-only refactor cannot silently drift back to the broken shapes without
being caught.

**Acceptance Criteria**:
- [ ] The regression test asserts the postcondition passes on a fixture representing a known-good
      POST (Leg 1 count matches; Leg 2 filtered count meets `≥` bound; `pull_request_review_id`
      matches).
- [ ] The regression test asserts the postcondition fails when the POST genuinely did not land
      (fixture: bundle has N comments, the `pulls/{n}/comments` filtered list has < N — the "off
      by one anchored-outside-a-hunk" failure interpretation from the contract).
- [ ] The regression test asserts the postcondition passes when the acting identity is captured
      as `generacy-ai` in one leg and `generacy-ai[bot]` in the other (suffix-insensitive
      fallback).
- [ ] The regression test lives in the same repo as the contract it guards
      (`/workspaces/agency`); no cross-repo test dependency is introduced.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Leg 1 reads inline-comment count from `GET /repos/{o}/{r}/pulls/{n}/comments`, filtered client-side to `pull_request_review_id == response.id`. `response.comments` MUST NOT be dereferenced anywhere in the guardrail. | P1 | Fixes the primary undefined-read failure. |
| FR-002 | Leg 2's primary matching key is `pull_request_review_id == response.id` on the review-thread's first-comment node. | P1 | Removes the identity question from Leg 2 entirely. |
| FR-003 | Leg 2's fallback rule (when `pull_request_review_id` is null on the first-comment node) is a suffix-insensitive login match: `stripBotSuffix(threadAuthorLogin) == stripBotSuffix(actingLogin)`, where `stripBotSuffix(s) = s.replace(/\[bot\]$/, '')`. | P1 | Defensive; not observed to fire in the snappoll run but retained for shape drift. |
| FR-004 | The `first: 50` page size, the `≥ bundle.comments.length` bound, the `isResolved == false` filter, and the `comments.nodes[0].createdAt >= response.submitted_at` freshness filter all remain unchanged. | P1 | Non-changes; called out because Leg 2's rewrite could tempt broader rewrites. |
| FR-005 | The 2000 ms single-shot retry backoff and its ledger lines (`postcondition-failed · attempt=1`, `review-post-retry · attempt=1 · backoff=2s`, `postcondition-failed · attempt=2 · re-present-gate`) remain unchanged in shape; only the *trigger* changes (fires on genuine failure only, not on every POST). | P1 | Preserves the ledger cheatsheet in `auto.md`. |
| FR-006 | The D.2 four-step guardrail prose in `auto.md` MUST NOT restate the fixed leg shapes verbatim; it MUST continue to reference `contracts/postcondition-check.md` as the single source of truth. | P2 | The prose currently references the contract by path; this rule prevents the shape from drifting between `auto.md` and the contract during the fix. |
| FR-007 | A regression test asserts the postcondition passes for a known-good POST and fails only when the review genuinely did not land. Test lives in `/workspaces/agency`, next to the contract. | P2 | Enforces the fix does not silently regress. |
| FR-008 | The `Feedback posted: N inline comment(s) on PR #<pull_number>` success line rendered by the guardrail on success (referenced from `auto.md` D.2 step 4.iv) MUST still fire when the postcondition passes on the first attempt against the corrected legs. | P2 | Downstream steps read that marker to confirm the POST landed. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | First-attempt postcondition pass rate on real PRs | 100% of successful `request-changes` POSTs pass on the first attempt (no retry, no re-present) when the POST genuinely landed | Replay a single-comment `request-changes` review against a real PR (or a recorded fixture of one) after the fix; assert no `postcondition-failed` ledger line is emitted. |
| SC-002 | Duplicate-review posting | 0 duplicate reviews on successful POSTs | Run the guardrail against a real PR; count `POST /repos/{o}/{r}/pulls/{n}/reviews` calls per operator-triggered `request-changes` verdict; expect exactly 1. |
| SC-003 | Undefined-field reads | 0 occurrences of `response.comments` read anywhere in the guardrail or contract | Grep the contract and the D.2 prose after the fix; assert zero matches for `response.comments`. |
| SC-004 | Identity-suffix match | The postcondition passes when the acting identity is captured as `generacy-ai` on one leg and `generacy-ai[bot]` on the other | Regression test with the two-string fixture. |
| SC-005 | Contract-prose drift guard | The D.2 prose in `auto.md` restates no leg-shape detail that could drift from `contracts/postcondition-check.md` | Manual review during the fix PR; enforceable by a `rg` check in future audits (`response.comments` / `stripBotSuffix` / `pull_request_review_id` should each appear in the contract but not in the prose beyond a reference by path). |

## Assumptions

- The `auto.md` skill and `contracts/postcondition-check.md` both live in the **agency** repo
  (`/workspaces/agency/packages/claude-plugin-cockpit/commands/auto.md` and
  `/workspaces/agency/specs/422-summary-auto-md-s/contracts/postcondition-check.md`). The
  implementation PR targets agency; this spec branch lives on generacy for triage reasons.
- The Generacy single-credential rule (`auto.md` D.3, verbatim: "the same account that opened the
  PR posts the review") still applies: `<acting-bot-login>` is the PR-author credential captured
  in the same session that issues the POST.
- The GitHub REST `pulls/{n}/comments` endpoint's `pull_request_review_id` field is populated on
  every review-authored inline comment. The suffix-insensitive login match (FR-003) is retained
  as a defensive fallback only.
- The Generacy GitHub App's REST login is `generacy-ai[bot]` and its GraphQL login is
  `generacy-ai` (verified on `snappoll#2`); the suffix pattern is `[bot]` for all bot accounts
  (GitHub-wide convention, not Generacy-specific).
- `PrFeedbackMonitorService` on the server side (generacy#861/#869/#878/#883 lineage) remains the
  authoritative applier of `waiting-for:address-pr-feedback` after a `request-changes` POST; the
  guardrail here is only concerned with confirming the POST landed, not with what happens next.

## Out of Scope

- Cross-repo automation between generacy and agency for spec-branch → PR routing. Tracked
  separately as #899.
- Rewriting the D.2 four-step guardrail (pre-validate anchors, compose bundle, POST, verify) for
  any concern other than the two-leg postcondition. Anchor pre-validation, bundle composition,
  and the POST call itself are untouched.
- Reducing the 2000 ms single-shot backoff or introducing exponential backoff. The contract's
  "deterministic, single shot" wording holds.
- Multi-round `request-changes` deduplication semantics. The `≥` bound in Leg 2 already
  accommodates threads from prior rounds; this fix does not alter that reasoning.
- Extending the postcondition to cover thread resolution state, reply comments, or non-first-page
  review threads (all called out as non-goals in the current contract; unchanged).
- Any change to the `waiting-for:address-pr-feedback` server-side flow.

---

*Generated by speckit*
