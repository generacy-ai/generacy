# Quickstart: verify #1080

Documentation-and-test-only change. Two verification passes: (1) prose greps to confirm the stale refine language is gone; (2) test suite to confirm behavior is preserved and both guards fire.

## 1. Post-fix prose gates (SC-001, SC-002)

```bash
# SC-001: zero stale refine claims anywhere under the cockpit MCP tree.
# MUST return 0 matches after the fix.
grep -rniE "runId requires generation|would 400|would produce a 400|RFC-7807" \
  packages/generacy/src/cli/commands/cockpit/

# SC-002: the rewritten handler comment names both load-bearing tokens.
# MUST return >=1 match for each token.
grep -c "agency#471"        packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts
grep -c "generacy-cloud#894" packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts
```

**Discipline note (per Q5 answer)**: do NOT grep for prose shapes (e.g. sentence fragments, `startup-sweep`, `run-agnostic`). A grep for a phrase fails the first time someone improves the wording, which trains people to weaken the check or not improve comments. Grep for identifier tokens that must be true.

## 2. Behavior-preservation tests (SC-003, SC-004)

```bash
cd packages/generacy
pnpm vitest run src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts
```

Expected: all existing tests pass unchanged (SC-004 — behavior byte-identical). The renamed wire-level test at `:234-247` (now clearly framed as a wire-level guard) plus the new client-seam test in the same `describe('#1067 — CockpitGateListInputSchema runId widening', ...)` block both pass.

## 3. Full package guard (SC-005)

```bash
cd packages/generacy
pnpm build
pnpm typecheck
pnpm vitest run
```

Expected: every existing test still green. No new failures. No production code path changed.

## 4. Diff sanity check (SC-005)

```bash
git diff develop -- packages/generacy/src/ | grep -E "^[-+][^-+]" | grep -vE "^[+-]\s*(//|\*)" | grep -vE "^\+\+\+|^---"
```

Expected: **empty output** for non-test files. Any hit outside of test files means production code changed unintentionally — investigate and revert unless the change is a comment-block boundary shift. Test files are permitted to show non-comment diff (the new `it` block and the existing test's description rename).

## 5. Manual acceptance walk (US1, US2, US3)

Read the three sites in this order and confirm each passes its "future maintainer" test:

1. Open `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts:50-59`. As a maintainer who has never seen this issue, does the comment make it obvious *why* the drop happens? Does it mention `agency#471` and `generacy-cloud#894` explicitly? Does it not claim the cloud would 400?

2. Open `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:65-75`. Is the docblock a single-line fact-plus-cross-link? Does it tell the reader the handler drops the field (so they don't infer "the schema accepts it, so it must reach the cloud")?

3. Open `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts` at the `#1067 — CockpitGateListInputSchema runId widening` describe block. Does the wire-level test's name state that it's a wire-level guard? Does the new adjacent test spy at `client.listGates` and assert the argument object has no `runId` property? Does either test's description reference the vanished 400 rationale?

If all three read cleanly and answer yes / no as noted, the spec's user stories are satisfied.

## Troubleshooting

- **`vi.mock` not intercepting `createGateQueryClient`**: check hoisting. Vitest requires either a top-of-file `vi.mock('../gates/query-client.js', ...)` call (which hoists automatically) OR a `vi.hoisted(() => ...)` factory for the spy so the spy is defined before the mock is bound. Reference pattern: any test that uses `vi.mock` with a factory in this repo.
- **Wire-level test fails with `runId=<value>` appearing in URL**: means the handler strip was accidentally removed. This is the FR-004 regression and MUST fail the PR.
- **Client-seam test fails with `runId` in spy arg**: same regression, different seam. If only the client-seam test fails and the wire-level test passes, the handler forwarded `runId` but `buildListUrl` silently dropped it — investigate `buildListUrl` at `query-client.ts:112-116`.
- **Grep for `runId requires generation` returns hits post-fix**: an occurrence was missed. Check the three declared sites (handler comment, schema docblock, test) and any file added since /plan.
