---
"@generacy-ai/cockpit": patch
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy": patch
---

fix(cockpit): conform the gate wire contract to the frozen spec (#1034).

The `packages/cockpit/src/gates/` module previously shipped an invented gate
wire envelope (`kind`-discriminated, `scope`-wrapped, with a `gate-ack`
sub-event and a nested-`answer` down-path) that matched **neither** the frozen
authoritative contract in
`tetrad-development/docs/cockpit-remote-gates-plan.md § "Wire contracts"` **nor**
the generacy-cloud receiver (`gates-wire.md` Shapes 1/2/3), which dispatches on
`data.type` and log-drops any unknown subtype. Net effect: the orchestrator's
own `GateOpenSchema` rejected the plugin's `cockpit_gate_open` call, and even a
patched frame would have been silently dropped cloud-side (`data.type ===
undefined`) — no gate ever reached the operator inbox. This supersedes the
envelope portions of #1032/#1033 (gate-open `scope`) and the gate-ack work
(#1035), which refined the wrong shape.

Now conformant to the frozen contract (the cloud is the authoritative
receiver/sender; these schemas mirror it field-for-field):

- **Schema module** (`packages/cockpit/src/gates/`): `GateOpenSchema`
  (`type:'gate-open'`, flat — `gateKey`, `gateType` enum, `title`/`body`/
  `options`/`allowFreeText`/`sessionId`/`askedAt`, 24-hex `gateId`),
  `GateOutcomeSchema` (`type:'gate-outcome'` — THE ACK, replaces `GateAckSchema`),
  `GateAnswerSchema` (down-path `type:'gate-answer'`, flat `optionId`/`freeText`/
  `actor`, both `freeText` and `actor.email`/`actor.displayName` **nullable** to
  match what the cloud sends). Adds `deriveGateKey`/`deriveGateId`
  (`sha256(gateKey)[:24]`). Removes the dead `GateAckSchema` /
  `GateAnswerEnvelopeSchema`.
- **Orchestrator** (`routes/cockpit-gates.ts`, `routes/cockpit-answers.ts`): the
  `/ack` route now stamps `type:'gate-outcome'` (path-authoritative `gateId`,
  defaulted `at`) instead of emitting a `gate-ack`; the emitted relay `data`
  carries `type` as the cloud sub-event discriminator; `/cockpit/answers`
  validates the frozen flat `GateAnswerSchema` (24-hex `gateId`) before append.
- **MCP tools**: `cockpit_gate_open` now **derives** `gateKey`+`gateId` in TS
  and self-validates the assembled frozen record before POSTing (the plugin/LLM
  never hand-builds a sha256); `cockpit_gate_ack` assembles a `gate-outcome`.
- **Doorbell**: the answers tailer parses the frozen flat down-path line
  (`type`/`gateKey`/flat `optionId`/`freeText`/`actor`); repo-scope filter keys
  on the `gateKey` issue-ref (owner/repo, child-issue numbers pass).

Known follow-up: cross-repo child-issue answers are dropped by the tailer's
owner/repo scope filter (documented inline; cross-repo remote gates are not yet
exercised). Pairs with the `@generacy-ai/claude-plugin-cockpit` change that
emits the frozen record shape.
