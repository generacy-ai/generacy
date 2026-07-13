---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": minor
---

Cockpit dynamic scope — live task-list membership, `scope add` verb, single-issue queue, and non-epic tracking issues as scope (#935).

Reframes "scope" as any task-list-bearing issue, so both mid-epic ad-hoc work
and epic-less stabilization runs drive the same file→process→merge loop.

- `@generacy-ai/cockpit`: `resolveEpic` and the resolver accept a plain
  task-list-bearing tracking issue as the scope ref (no epic marker required).
  The per-poll re-resolution is pinned as a contract: a ref appended to the
  scope issue's task list mid-subscription joins the monitored set within one
  poll cycle and emits an observable first-sight `issue-transition` event
  (rather than a silent snapshot join); removing a ref stops monitoring and
  emits nothing retroactive. Registry isolation (distinct scope refs → distinct
  event buses, no cross-delivery) is made load-bearing with a test.
- `@generacy-ai/generacy`: adds `cockpit scope add <scope-ref> <issue-ref>`
  (CLI verb + `cockpit_scope_add` MCP tool, with a matching `cockpit_scope_remove`)
  — a concurrency-safe task-list append (re-read + append + verify) that keeps
  body-format knowledge engine-side and returns a typed result. `cockpit queue`
  gains an issue-level form (`--issue <issue-ref>` / MCP param) that assigns the
  cluster account and applies the `process:<workflow>` label for a single issue
  with no phase membership required.
