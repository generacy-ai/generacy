---
"@generacy-ai/cockpit": patch
---

Fix `cockpit status` / `cockpit watch` listings: pass each `gh search issues`
term as a separate argument. The query was passed as a single positional arg,
so gh folded trailing qualifiers into the first one's quoted value (e.g.
`repo:"o/r is:open"`), producing an invalid query that failed every repo- and
epic-scoped listing.
