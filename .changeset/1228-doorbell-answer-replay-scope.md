---
"@generacy-ai/generacy": patch
"@generacy-ai/cockpit": patch
---

Scope cockpit doorbell gate-answer replay by epic ref set and persist the
consumed position (#1228).

The answers-file tailer (`AnswersFileSource`) now scopes gate answers by
membership in the bound epic's resolved ref set (epic + children, cross-repo
included) via a shared `EpicRefSetHolder`, replacing the owner/repo string
compare that silently dropped legitimate cross-repo epic children (closes
#1111). Unknown refs trigger a throttled re-resolve before being dropped.

The tailer also persists its consumed `{ino, offset}` per epic scope in a new
`AnswersCursorStore` (atomic tmp+rename, debounced), so a doorbell restart
resumes from the last consumed byte instead of replaying from byte 0. A missing
or stale cursor falls back to a byte-0 replay bounded by an `answeredAt` recency
window (default 24 h, override `COCKPIT_ANSWERS_REPLAY_WINDOW_MS`) and the
ref-set scope. Harness mode (no `gh`) keeps the legacy owner/repo compare.

Review follow-ups on the same change:

- An in-place truncation of the answers file (same inode) no longer strands the cursor at
  a stale, too-high offset: every replay branch now rewrites the cursor rather than
  relying on the monotonic-within-inode `advance()` guard.
- If the epic ref-set oracle has never resolved (a GitHub 403 / rate limit at startup),
  the scope test fails open to the legacy owner/repo compare instead of dropping every
  answer — including the bound epic's own — as "cross-epic".
- A ref-set miss inside a throttle window that was armed by a *failed* resolve now defers
  the line for a later retry instead of dropping it permanently.
- The cursor advances only past a line that was actually consumed: a rejected `onEvent`
  sink, or a `stop()` that races the emit, leaves the line for the next tick.
- `answerLineFixture()` (`@generacy-ai/cockpit`) now defaults `answeredAt` to call time.
  A hard-coded date silently ages past the new replay recency window and made every
  harness answer disappear with no assertion naming the cause.
