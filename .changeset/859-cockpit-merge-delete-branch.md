---
"@generacy-ai/generacy": patch
"@generacy-ai/cockpit": patch
---

`cockpit merge` now deletes the head branch after a successful squash-merge, so
stale speckit branches (one per child issue) no longer accumulate on an epic.

The deletion is handled gracefully and never fails the verb: a branch already
gone (repo-level auto-delete enabled) and cross-fork PRs where the head ref
can't be deleted are both logged as info and skipped. The merge result line
reports the outcome ("merged and branch deleted") so the deletion is visible.
Retroactive cleanup of existing stale branches and flipping the repo-level
auto-delete setting remain out of scope.
