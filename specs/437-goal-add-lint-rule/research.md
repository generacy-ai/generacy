# Research: Lint Rule for child_process Restriction

## Technology Decision

**Chosen**: ESLint built-in `no-restricted-imports` rule with `overrides` for allow-listing

### Alternatives Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **`no-restricted-imports` + overrides** | Zero custom code, built-in ESLint rule, well-documented, no dependencies | Forbids entire module (not per-export), overrides turn off whole rule for allowed files | **Selected** — simplest, sufficient for requirements |
| **Custom ESLint plugin** | Per-function granularity, custom error messages per violation, could detect `require()` | Maintenance burden, needs test suite, registration complexity, overkill for this use case | Rejected — unnecessary complexity |
| **`no-restricted-globals`** | Could catch bare `spawn` references | Doesn't catch `import` statements; `spawn` is too generic a name (conflicts with other APIs) | Rejected — wrong tool |
| **`@typescript-eslint/no-restricted-imports`** | TypeScript-aware, handles `import type` | Identical behavior to core rule for runtime imports; `child_process` types are rarely imported standalone | Rejected — no benefit over core rule |
| **Custom script (not ESLint)** | Full control, can use AST or regex | Doesn't integrate with `pnpm lint`, separate CI step, no IDE feedback | Rejected — poor DX |

## Key Design Decisions

### 1. Forbid the module, not individual exports

The `no-restricted-imports` rule forbids importing the module by name. We don't restrict specific named exports (`spawn`, `exec`, etc.) individually — instead we block the entire `child_process` module.

**Rationale**: There's no legitimate reason to import `child_process` in a non-allowed file. Blocking at the module level is simpler and more comprehensive (catches future Node.js additions to the module automatically).

### 2. File-path allow-listing via `overrides`, not inline comments

ESLint `overrides` match files by glob pattern. This means:
- New files are forbidden by default (no opt-in required)
- Allow-listing is centralized in `.eslintrc.json` (auditable in one place)
- No `eslint-disable` comments scattered through the codebase

### 3. Two override groups: sanctioned + grandfathered, and tests

Separating tests into their own override keeps the allow-list clean. Test files use glob patterns (`**/__tests__/**`, `**/*.test.ts`); production files are listed explicitly.

### 4. Both `child_process` and `node:child_process` paths

Node.js supports both bare (`child_process`) and namespaced (`node:child_process`) import specifiers. Both must be restricted. The codebase uses a mix — older files use `child_process`, newer files use `node:child_process`.

### 5. `require()` calls not separately handled

The `no-restricted-imports` rule only catches `import` statements, not `require()`. However:
- The codebase uses ES module `import` syntax throughout (TypeScript with `sourceType: "module"`)
- No `require('child_process')` patterns found in non-test source files
- If needed in the future, `no-restricted-modules` (deprecated) or a custom rule could be added

## Implementation Pattern

```
.eslintrc.json
├── rules
│   └── no-restricted-imports: ["error", { paths: [...] }]
└── overrides
    ├── [0] sanctioned + grandfathered files → rule: "off"
    └── [1] test file globs → rule: "off"
```

## References

- [ESLint `no-restricted-imports` docs](https://eslint.org/docs/latest/rules/no-restricted-imports)
- [ESLint `overrides` configuration](https://eslint.org/docs/latest/use/configure/configuration-files#how-do-overrides-work)
- Issue #437, parent tracking #423
- Clarifications: Q1 (sync variants covered by module-level block), Q2 (launcher excluded), Q3 (root-level with grandfathered list)
