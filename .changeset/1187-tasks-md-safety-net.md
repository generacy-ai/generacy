---
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy": patch
---

Add an engine-side `tasks.md` safety net for the implement→continue increment (#1187, `workflow:speckit-bugfix`).

The implement→continue increment previously fired only when the agent emitted a `SPECKIT_IMPLEMENT_PARTIAL` sentinel. When the agent stopped mid-tasklist without emitting it, `result.implementResult` was `undefined`, the re-loop was skipped, `completed:implement` was granted, and a substantially-unfinished tree advanced into review→remediate (which caps and stalls).

The fix adds an engine-side fallback: after a `success` implement phase with **no** sentinel, the engine reads the workflow's `tasks.md`, counts unchecked `- [ ]` tasks, and — when work remains — synthesizes a `result.implementResult` so the existing increment block (WIP commit/push, fresh session, no-progress guard, `i--; continue`) drives re-entry unchanged. The sentinel stays the fast path; `tasks.md` becomes the fallback source of truth. All changes are orchestrator-internal (`worker/` surface, not re-exported at the package public boundary); no new public exports and no new label vocabulary. A fully-checked or task-less `tasks.md` advances exactly as today, and an unreadable/ambiguous fallback source logs and advances (fail-open).

Also fixes a latent teardown hang in `@generacy-ai/generacy`'s cockpit doorbell `AnswersFileSource`: the `fs.watch` async iterator was awaited on `stop()` without an `AbortSignal`, so a pending `next()`/`return()` never settled once the watch loop was active (parent dir present), hanging teardown until the test timeout. An `AbortController` is now wired through the watcher and aborted before `stop()` awaits the iterator's `return()`.
