---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": patch
---

Add `remediation-limit` (#1120) and `ci` (#1133) to the cockpit gate-type wire
enum (`GateTypeSchema`) in both in-repo mirrors — the canonical
`@generacy-ai/cockpit` enum (`packages/cockpit/src/gates/schema.ts`) and the
MCP-boundary mirror (`packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`).
Both engine-raisable operator gates were previously `.strict()`-rejected as
`invalid-args` under `/cockpit:auto --gates=ui`. The two members are appended
after `scope-drained`; the existing 8 values are neither reordered nor renamed.
The four exhaustive `Record<GateType, …>` fixture maps in
`packages/cockpit/src/gates/fixtures.ts` gain plain-string generations for the
new types (no new derivation helper). Cluster-side only; the cloud
`cockpitGateTypeEnum` mirror is coordinated separately.
