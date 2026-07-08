---
"@generacy-ai/generacy": patch
"@generacy-ai/cockpit": patch
---

Fix `cockpit merge` conflating "no checks reported" with a check failure, which
prevented CI-less repos from ever merging.

`gh pr checks` exits non-zero for both "checks failed" and "no checks exist", so
the gh wrapper's fail-on-nonzero handling rejected repos with no CI configured.
Now `getPullRequestCheckRuns` recognizes gh's no-checks case (exit 1 + stderr
matching `no checks reported`) and returns an empty check-run list instead of
throwing; all other non-zero exits still throw. The merge decision evaluates the
empty list against the required-checks set: no required checks + none reported is
vacuously green and proceeds to squash (emitting an explicit note so the
condition is never silent), while a non-empty required set with contexts absent
is treated as red, naming the missing required contexts. status/watch rollups
render an empty list as the existing `none` value.
