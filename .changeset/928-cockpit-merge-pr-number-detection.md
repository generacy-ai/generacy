---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": minor
---

Detect PR-number input to `cockpit merge` and make the MCP merge tool
symmetric with the CLI verb (#928).

- `@generacy-ai/cockpit`: `PullRequestRefResolution` gains a `{ kind:
  'pr-number' }` arm, returned when the caller's `<issue>` argument is itself a
  PR node. Tier-1 resolution now runs a `__typename` classification query only
  when `gh issue view` fails with a "not an Issue"-shaped error, so the common
  input-is-an-issue path pays no extra round-trip. Only tier-1 classifies —
  tiers 2/3 never invent a `pr-number` signal.
- `@generacy-ai/generacy`: `cockpit merge <issue>` now emits a typed exit-2
  refusal with guidance when the ref is a PR (closes #906 on the CLI), and
  `RunMergeResult` carries the operated-on `prNumber`. The MCP `cockpit_merge`
  tool takes an `issue` ref (renamed from the old inverted `pr` field, with a
  redirection message when a non-numeric `pr` key is seen) plus an optional
  `pr: <number>` escape hatch mirroring the CLI's `--pr` — resolution is
  skipped but every safety precondition (linkage, `completed:validate`, checks
  green) still holds. The `pr-number` refusal maps to the envelope
  `class: 'wrong-kind'`.
