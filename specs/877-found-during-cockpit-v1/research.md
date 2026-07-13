# Research: `wizard-credentials.env` trailing newline fix

## Technical Decisions

### D1 — Append `\n` inside `formatEnvFile()` (not at the callsite)

**Decision**: Terminate output in the pure formatter, not in `writeWizardEnvFile()`.

**Rationale**:
- `formatEnvFile()` is the abstraction that owns the env-file wire format. Its contract *is* "produce a valid POSIX env file"; a POSIX text file is defined by IEEE Std 1003.1 as a sequence of zero or more lines, each terminated by `\n`. The current output violates that contract for `entries.length > 0`.
- Regression test FR-004 pins the invariant at the formatter level, which is the smallest testable unit — no filesystem mocking required for the invariant test.
- Fixing at the callsite would leave the function's returned string still-broken for any future caller.

**Alternatives considered**:
- **Fix in `writeWizardEnvFile()` only** — rejected; leaks the invariant out of the abstraction. If a future writer reuses `formatEnvFile()`, the bug reappears.
- **Change `.join('\n')` to `.map(...).join('') + entries.map(e => …+'\n').join('')`** — rejected; ugly, no net benefit over `+ '\n'` on the final joined string.

### D2 — Keep `formatEnvFile([])` returning `''` (not `'\n'`)

**Decision**: Empty-entry case still returns empty string.

**Rationale**:
- Spec FR-002 explicitly permits either behaviour ("MAY return an empty string OR a single `\n` — either is safe").
- Minimal diff: existing empty-string test at `wizard-env-writer.test.ts:364` stays untouched.
- Empty file is unambiguously "no vars"; a lone `\n` would be equivalent but is a gratuitous diff.

**Alternative**: Always emit `\n` for consistency. Rejected on diff-minimality grounds.

### D3 — Regression test naive-append via `fs.appendFile` (not string concatenation in memory)

**Decision**: FR-005 regression test uses `fs.appendFile` against a real temp file.

**Rationale**:
- The bug shape observed in production (`echo "NEW=value" >> /var/lib/generacy/wizard-credentials.env`) is a filesystem-level append. Testing against the actual write path gives higher signal than testing the pure string.
- The existing test file already uses temp directories (`fs.mkdtemp`) for `writeWizardEnvFile()` tests — no new infrastructure.

**Alternative**: String-level test (`formatEnvFile(entries) + 'NEW=v\n'` then parse). Rejected — doesn't cover the actual filesystem write.

### D4 — Parse assertion by manual split (not by `dotenv` or shell-source subprocess)

**Decision**: In the regression test, split on `\n` and `=` in-process; no `dotenv` dep, no `bash -c 'source'`.

**Rationale**:
- Zero new dependencies (aligns with CLAUDE.md scope discipline).
- The test's job is to prove keys are *distinct and parseable* — a hand-written 4-line split does exactly that without pulling in a parser whose quirks (multiline strings, quoted values, `export` prefixes) aren't relevant here.
- Shell subprocess would tie the test to the CI runner having bash, complicate cross-platform runs, and add latency.

**Alternative**: Spawn `bash -c 'source file && env'` and diff env keys. Rejected — heavier and less deterministic.

## Implementation Pattern

**Pattern**: One-line invariant fix + regression test lock-in.

Matches the pattern used for other one-line control-plane fixes in the codebase — e.g., #628 (git identity extraction), #600 (EventMessage wire-shape fix). Both landed as narrow scope changes with targeted vitest coverage in the corresponding `__tests__/services/` file.

## Key References

- IEEE Std 1003.1-2017, §3.206 "Line" and §3.397 "Text File" — POSIX definition of a text file requiring `\n` termination.
- `packages/control-plane/src/services/wizard-env-writer.ts:83-86` — the defect.
- `packages/control-plane/__tests__/services/wizard-env-writer.test.ts:362-374` — the existing `formatEnvFile` test block that will be updated in place.
- CLAUDE.md `## Wizard Credentials Env Bridge (#589, #592, #628)` — history of prior modifications to `wizard-env-writer.ts`; establishes the file's scope and consumer chain.
- Spec `Out of Scope` section — confirms `CLUSTER_ACTING_LOGIN` env-var plumbing is superseded by #878 and not part of this fix.
