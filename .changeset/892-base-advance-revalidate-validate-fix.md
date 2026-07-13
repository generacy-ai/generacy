---
"@generacy-ai/orchestrator": minor
"@generacy-ai/workflow-engine": minor
"@generacy-ai/generacy-plugin-claude-code": minor
---

Re-validate on base advance and add a bounded validate-fix cycle (#892).

Two red classes were stranding issues at `failed:validate` with no recovery, so
an auto run could never reach `epic-complete`:

- **Stale integration reds (a).** A new base-advance monitor polls each PR's base
  branch head SHA on the existing ~60s cadence; when it advances (a sibling PR
  merges, an external PR merges, or a direct push lands), every open speckit
  issue sitting at `failed:validate` against that base is re-armed via `cockpit
  resume`. Dependency-ordered merges unlock dependents one at a time with no
  membership machinery; `(issue, new base SHA)` is the natural re-arm key and the
  #879 in-flight dedupe collapses storms. `getRefHeadSha` is added to the
  workflow-engine GitHub client for the SHA poll.
- **Genuine code reds (b).** A red that persists on a fresh merge-preview gets one
  autonomous `ValidateFixHandler` attempt on the branch — a new
  `ValidateFixIntent` in the claude-code plugin, sharing the PrFeedbackHandler
  spawn→commit→push→re-check plumbing with the #883 termination discipline (the
  attempt must change the tree or stop). Attempt identity is a SHA-256 evidence
  hash over the normalized failing-test/module set + first error line (ANSI,
  timestamps, absolute paths, and per-run identifiers stripped), so the same red
  never triggers a second autonomous attempt — further attempts only via the
  escalation gate. Still red after the attempt → `failed:validate` + alert.
