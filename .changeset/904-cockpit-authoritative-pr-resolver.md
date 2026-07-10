---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": patch
---

Make the shared issue→PR resolver authoritative and loud, so `merge` never targets a draft sibling or a coincidentally-mentioned PR (#904).

Surfaced by the cockpit v1.5 auto-mode smoke test: `cockpit merge` resolved an
issue to a **draft sibling PR** (via a `pr-body` mention scan across P3 bodies
that cross-reference sibling issues), then failed downstream with a nameless
`gh pr merge failed: still a draft`.

`@generacy-ai/cockpit` replaces the old `resolveIssueToPR` shape with
`resolveIssueToPRRef`, returning a discriminated `PullRequestRefResolution`
(`resolved` | `ambiguous` | `pr-is-draft` | `unresolved`) and exporting the new
`PullRequestRefResolution`, `LinkMethod`, and `PrCandidate` types. Resolution is
deterministic precedence — `closing-refs` (GitHub's authoritative Development
link) → `branch-name` (`NNN-*`) → `pr-body` mention scan — with drafts excluded
from every tier and >1 surviving non-draft candidate yielding `ambiguous` rather
than a guess. The invariants are codified in the type doc (I-1…I-5). Because the
fix lives in the shared resolver, `PrFeedbackMonitorService` inherits the same
guarantees and can no longer attach feedback to the wrong sibling PR.

The `@generacy-ai/generacy` `merge`, `queue`, and `context` verbs consume the new
result and now always print/emit `resolved PR #N via <linkMethod>` (or the
ambiguous/draft candidate list) on both success and failure paths — an operator
never has to reverse-engineer the target from a second run. Merge exits non-zero
without touching GitHub on any ambiguous or draft-only outcome.
