---
"@generacy-ai/generacy": patch
---

Render phase grouping in `cockpit status` (#828).

`cockpit status <epic-ref>` previously iterated the flat deduped ref set and
emitted every child under a single `epic owner/repo#N` header, discarding the
phase structure that `resolveEpic` already returns. Rows are now grouped under
their epic-body `### <phase>` headings (a `— P1 — Foundation —` separator row per
phase), matching the command catalog and mirroring the queue-round mental model
used when driving an epic. Phase membership is included in each `--json` envelope
row, a child appearing under multiple phases renders once per phase, and any ref
under no phase falls into an implicit trailing `— (no phase) —` group.
