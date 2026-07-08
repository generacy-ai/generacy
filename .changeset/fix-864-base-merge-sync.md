---
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy": patch
---

Fix feature branches never syncing with their base, so validate ran on stale trees and conflicts surfaced only at merge (#864).

Nothing in the pipeline merged the base branch into a feature branch — not at
implement start, not before validate — so staleness and conflicts surfaced only
at merge time, after review and validate had already passed against a tree that
would not exist post-merge (vacuous green). The worker now performs a base-merge
of `origin/<base>` into the workspace (committed for implement, ephemeral for
pre-validate/validate) so validation tests the real post-merge tree; merge
conflicts fail loud with a merge-conflict evidence block and gate label listing
the conflicted paths. `cockpit queue` additionally warns when an implement
phase's plan.md declares a dependency on an issue whose PR is not yet merged.
