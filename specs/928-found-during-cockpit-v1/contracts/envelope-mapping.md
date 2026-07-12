# Contract: `toMcpResult` — CLI-to-MCP envelope mapping

## Location

`packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` (extend existing file — see `mapCockpitExitToToolError` at `errors.ts:41` for the sibling helper).

## Signature

```ts
export function toMcpResult<T>(
  cliJsonStdout: string,
  exitCode: number,
): ToolResult<T>;
```

## Purpose

This helper *is* the wire contract between CLI transport and MCP transport (Q4 → B). Every parity test in `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-*.test.ts` uses it to assert that
`toMcpResult(cliRun.stdout, cliRun.exitCode)` deep-equals the `ToolResult` produced by the MCP tool for the same input.

## Mapping table

The table is the contract. Any change to it is a contract change and must be reflected in `envelope-mapping.test.ts` in the same PR.

| `exitCode` | Parsed `stdout.reason` | Returns                                                          |
|------------|------------------------|------------------------------------------------------------------|
| 0          | (any / none)           | `{ status: 'ok', data: parsed }`                                 |
| 2          | `'pr-number'`          | `{ status: 'error', class: 'wrong-kind', detail, hint }`         |
| 2          | `'unresolved'`         | `{ status: 'error', class: 'gate-refusal', detail }`             |
| 2          | `'ambiguous-resolution'` | `{ status: 'error', class: 'gate-refusal', detail }`           |
| 2          | `'pr-is-draft'`        | `{ status: 'error', class: 'gate-refusal', detail }`             |
| 2          | `'checks-failing'`     | `{ status: 'error', class: 'gate-refusal', detail }`             |
| 2          | (other or missing)     | `{ status: 'error', class: 'invalid-args', detail }`             |
| 3          | (any)                  | `{ status: 'error', class: 'gate-refusal', detail }`             |
| 1          | (any)                  | `{ status: 'error', class: 'transport', detail }`                |
| ≥4         | (any)                  | `{ status: 'error', class: 'internal', detail }`                 |

## `detail` and `hint` construction

- `detail`:
  - On `exit=0`: N/A (result is `status: 'ok'`).
  - On `exit≥1`: prefer `parsed.detail` if present; else `parsed.reason` if a human-readable phrase; else the first line of `cliJsonStdout`; else `'unknown error'`.
- `hint`: emitted **only** when the mapped `class` is `'wrong-kind'`. Source: `parsed.hint` verbatim (the CLI writes it — see `runMerge` `pr-number` branch).

## Failure modes

- **Non-JSON `cliJsonStdout`**: return `{ status: 'error', class: 'internal', detail: 'CLI produced non-JSON stdout' }`. Log the first 500 chars of stdout at DEBUG for diagnosis; do not include it in the tool result.
- **Zod-invalid parsed payload**: same as above (`class: 'internal'`) — the CLI's contract has drifted from the mapper's table. Add a test case in `envelope-mapping.test.ts` for the drift.
- **`exitCode < 0`**: treated as `≥4` → `class: 'internal'`. This shouldn't happen (POSIX guarantees non-negative) but is defended.

## Test coverage

`packages/generacy/src/cli/commands/cockpit/mcp/__tests__/envelope-mapping.test.ts` (NEW):

- One `it()` per row of the mapping table.
- One `it()` per failure mode above.
- One `it()` that iterates all `reason` values known to `runMerge` and asserts none map to a class outside `{ wrong-kind, gate-refusal, invalid-args }` — guardrail against silent addition of a `reason` that ends up in `invalid-args` by omission.

## Sibling helper

`mapCockpitExitToToolError(exit: CockpitExit)` at `errors.ts:41` remains — it handles the `throw` path (when a CLI verb throws `CockpitExit` inside a wrapped handler). The two helpers are complementary:

- `mapCockpitExitToToolError`: for `throw` paths from CLI verbs called *directly* by an MCP handler (e.g. `cockpit_advance`, which calls `runAdvance` that throws).
- `toMcpResult`: for `return` paths from CLI verbs that return `{ exitCode, stdout }` shape (e.g. `runMerge`).

Both live in `errors.ts`; both share the exit-code interpretation. If you ever find yourself changing exit codes, both helpers must update in lockstep.
