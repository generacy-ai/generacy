---
"@generacy-ai/generacy": patch
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
