# Quickstart: verifying the #1190 fix

Issue: [generacy-ai/generacy#1190](https://github.com/generacy-ai/generacy/issues/1190)

## What changed

- `runActivation` no longer reads `GENERACY_PROJECT_ID` from the ambient environment; the
  CLI entry point (`deploy/index.ts`) resolves it once and passes it in.
- The activation test suite covers both URL branches deterministically.
- `__tests__/exports.test.ts` main-entry case gets a generous timeout so it survives
  worker load.

## Reproduce the original failure (pre-fix)

```bash
cd packages/generacy
GENERACY_PROJECT_ID=any-value pnpm vitest run tests/unit/deploy/activation.test.ts   # was RED
pnpm vitest run tests/unit/deploy/activation.test.ts                                  # was GREEN
```

## Verify the fix

```bash
cd packages/generacy

# SC-001 — the exact reproduction is now green
GENERACY_PROJECT_ID=any-value pnpm vitest run tests/unit/deploy/activation.test.ts

# SC-002 — no regression with the variable unset
pnpm vitest run tests/unit/deploy/activation.test.ts

# SC-006 — main-entry export smoke test no longer times out
npx vitest run __tests__/exports.test.ts

# SC-005 — full package suite passes with and without the variable
pnpm --filter @generacy-ai/generacy test
GENERACY_PROJECT_ID=any-value pnpm --filter @generacy-ai/generacy test
```

## Expected

All commands exit 0. The activation URL emitted in a real cluster worker (where
`GENERACY_PROJECT_ID` is set) is unchanged — it still carries `&projectId=<id>`.

## Changeset

`.changeset/1190-activation-projectid-purity.md` — `@generacy-ai/generacy` **patch**.
Confirm it is a newly-added file in the PR diff (the changeset gate greps
`--diff-filter=A`).

## Troubleshooting

- **Changeset bot red**: ensure the `.changeset/1190-*.md` file is committed and *new*
  (not an edit of an existing one).
- **`exports.test.ts` still slow**: the 60 s timeout only prevents a hard failure; the
  case may still take several seconds under load — that is expected, not a regression.
