# Quickstart: Pin the PrSnapshot read-through path (#1113)

Test-only regression coverage. No install or config changes.

## Where the change lands

Single file:
`packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source.integration.test.ts`
— add dedicated `it` block(s). All helpers (`startFakeSmee`, `checkRunFrame`, `issueFrame`,
`fakePrSnapshot`, `setPrev`, `waitFor`, `snapshotKey`) already exist in the file.

## Run the new + existing tests (SC-001)

```bash
pnpm --filter @generacy-ai/generacy test smee-source
```

Expected: green, including the four new casing-drift assertions.

## Mutation-verify (SC-002)

Confirm the read-mixed direction actually kills the target mutation:

1. Edit `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts:375`, replacing:
   ```ts
   const snap = this.prev.get(snapshotKey(ev.repo, 'pr', ev.number));
   ```
   with the inlined, un-normalized key:
   ```ts
   const snap = this.prev.get(`${ev.repo}#pr#${ev.number}`);
   ```
2. Re-run:
   ```bash
   pnpm --filter @generacy-ai/generacy test smee-source
   ```
   Expected: **red** — the read-mixed rows (payload `O/R`, write key `o/r#pr#42`) now miss and
   emit `checks: undefined`.
3. Revert the edit; confirm green again.

## Verify test-only scope (SC-003)

```bash
git diff --stat
```

Expected: only `__tests__/smee-source.integration.test.ts` changed. No `.changeset/*.md` is
required (test-only changeset-gate exemption per CLAUDE.md).

## What the new tests assert

Four assertions = {write-mixed, read-mixed} × {`pr-checks`, `completed:validate`}, each with a
`success` rollup expecting wire `checks === 'green'`:

- Write key built via `snapshotKey(writeRepo, 'pr', 42)` (never inlined).
- Read frame carries the opposite casing (`O/R` vs `o/r`).
- Assert `ev.checks === 'green'` (not `undefined`).

The read-mixed rows are the mutation-killers; the write-mixed rows also pin the pure
`snapshotKey`-at-write invariant.

## Troubleshooting

- **`waitFor` times out (no event emitted)**: the payload repo lowercased must equal the mocked
  watched repo `o/r`. Use `O`/`R` or `o`/`r` owner/repo only — never `Painworth/Doc-Intel`
  (it is not in the mocked `FAKE_RESOLVED` ref set and gets dropped upstream).
- **`checks` is `undefined` on unmutated code**: the write key was probably built inline instead
  of via `snapshotKey`, or the rollup isn't `success`. Build the key with `snapshotKey` and use
  `fakePrSnapshot(writeRepo, 42, 'success')`.
