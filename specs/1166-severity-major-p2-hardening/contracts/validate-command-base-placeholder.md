# Contract: `<base>` placeholder substitution + doc fix

Covers FR-010, SC-006; clarification Q4=A (code substitution, not doc-only).

## Substitution (`computeEffectiveValidateCommand`, `phase-loop.ts`)

For a **custom** (non-built-in-default) `validateCommand`, substitute `<base>`
with the bare resolved base branch before returning:

```
if (!isBuiltInDefault) {
  return validateCommand.replace(/<base>/g, base);
}
```

where `base = baseRef.replace(/^origin\//, '')`, mirroring the existing
merge-conflict `<base>`/`<branch>` substitution already present in
`phase-loop.ts`.

**Guarantees**:
- A custom command with no `<base>` is byte-identical to today (no-op replace).
- A custom command using `"...[origin/<base>]"` resolves the filter against the
  repo's actual base branch — works on both `develop`- and `main`-based repos.
- The built-in-default path is unaffected (it builds its own
  `"...[origin/${base}]"` filter and never sees the placeholder).

## Diff-resolution-failure path

`resolveTargetedValidate` resolves `base` (bare base branch) BEFORE the diff
computation so that, even on the early-return fallback (diff resolution threw),
the returned command has `<base>` substituted. A custom `validateCommand`
containing `<base>` is never emitted with the literal placeholder unsubstituted.

## Doc fix (`docs/docs/reference/bugfix-profile-config.md`)

- Replace the hardcoded `origin/develop` in the `validateCommand` example with
  `origin/<base>` (both `--filter` occurrences), and update the surrounding
  comment/table text from "resolved against origin/develop" to explain the
  `<base>` placeholder substitution.
- The documented example must produce a working targeted filter on both
  `develop`- and `main`-based repos.

## Tests (SC-006)

- Custom `validateCommand` with `<base>` on a `develop` repo → filter reads
  `origin/develop`.
- Same command on a `main` repo → filter reads `origin/main`.
- Custom command without `<base>` → unchanged (byte-identical).
- Doc review: no remaining hardcoded `origin/develop` in the example.
