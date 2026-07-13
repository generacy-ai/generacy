---
"@generacy-ai/generacy": patch
---

Add a uniform `type` discriminator to every `cockpit watch` NDJSON line (#887).

The stream interleaved two disjoint schemas — per-issue transitions (keyed on
`event`, no `type`) and #885's synthetic aggregates (`type: 'phase-complete' |
'epic-complete'`, no `event`) — so any consumer keying on a field present in only
one shape silently dropped the other (a `grep '"type"'` reader dropped 16 of 17
lines during the auto-mode smoke test). Per-issue lines now carry
`"type":"issue-transition"` in addition to all pre-existing fields (`event`
untouched), the aggregates keep their `type` values, and `CockpitEventSchema`
becomes a single `z.discriminatedUnion('type', …)`. The change is additive and
backward-compatible; the full stream grammar is documented in one table in the
package README.
