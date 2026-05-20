# Research: Extract Orchestrator Types Package

**Feature**: #672 — Decouple CLI from orchestrator server deps
**Date**: 2026-05-20

## Technology Decisions

### 1. Package Extraction Strategy

**Decision**: New `@generacy-ai/orchestrator-types` package with TypeScript interfaces only.

**Alternatives Considered**:

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| A: Types package (selected) | Zero runtime deps, clean separation | Maintenance of parallel interface | Best fit — types are stable |
| B: `optionalDependencies` | No new package | npm 7+ installs optional deps by default — doesn't reduce install size | Rejected per clarification |
| C: `peerDependencies` | Semantic correctness | Also auto-installed by npm 7+ | Rejected per clarification |
| D: Conditional dynamic import only | No new package | Doesn't reduce `npm install` size — npm resolves entire dep tree regardless of runtime branching | Rejected — core goal is install size |

### 2. Type Definition Approach

**Decision**: Hand-written TypeScript interfaces, not re-exported Zod-inferred types.

**Rationale**:
- `OrchestratorConfig` is `z.infer<typeof OrchestratorConfigSchema>` in the orchestrator — re-exporting requires the Zod schema and all 20+ sub-schemas
- The CLI's `subprocess.ts` uses `AgentLauncher` purely as a type annotation — it never calls `.launch()` or `.registerPlugin()` at runtime
- The CLI's `orchestrator.ts` uses `OrchestratorConfig` for a single type annotation on a variable that gets its value from `loadConfig()` (runtime import)
- Hand-written interfaces are more maintainable for 3 types than an extraction pipeline

### 3. Dynamic Import Pattern

```typescript
// packages/generacy/src/cli/commands/orchestrator.ts
async function loadOrchestratorModule() {
  try {
    return await import('@generacy-ai/orchestrator');
  } catch {
    console.error(
      'The orchestrator package is not installed.\n\n' +
      'Install it with:\n' +
      '  npm install @generacy-ai/orchestrator\n\n' +
      'Or run directly:\n' +
      '  npx -y @generacy-ai/orchestrator'
    );
    process.exit(1);
  }
}
```

**Key considerations**:
- Dynamic `import()` is natively supported in ESM (Node 22)
- Error must distinguish "module not found" from other import errors
- TypeScript needs `// @ts-expect-error` or a type assertion for the dynamic import if the module isn't in deps

### 4. Monorepo Wiring

**pnpm workspace protocol**: `workspace:^` for all internal deps (matches existing convention).

**Build order**: `orchestrator-types` → `orchestrator` → `generacy` (types package has no internal deps, builds first).

**tsconfig**: Standard project config matching other packages:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

## Implementation Patterns

### Interface-Class Alignment

The types package defines the interface:
```typescript
// orchestrator-types
export interface AgentLauncher {
  launch(request: LaunchRequest): Promise<LaunchHandle>;
  registerPlugin(plugin: AgentLaunchPlugin): void;
}
```

The orchestrator class implements it:
```typescript
// orchestrator
import type { AgentLauncher as IAgentLauncher } from '@generacy-ai/orchestrator-types';

export class AgentLauncher implements IAgentLauncher {
  // existing implementation unchanged
}
```

This pattern ensures nominal type compatibility — the interface is the source of truth, and TypeScript enforces the class conforms.

### Dependent Type Extraction

`LaunchHandle` depends on `ChildProcessHandle`, `OutputParser`, and metadata shape. Two options:

1. **Inline the dependent types** in the types package (copy minimal definitions)
2. **Use structural typing** with `unknown` for deep dependencies

Decision: Option 1 — inline minimal definitions. The types are small and stable:

```typescript
export interface ChildProcessHandle {
  readonly pid: number | undefined;
  readonly exitPromise: Promise<number | null>;
  kill(signal?: string): boolean;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
}
```

### Test File Strategy

Test files stay unchanged — they import from `@generacy-ai/orchestrator` (now a devDependency):

- `subprocess.test.ts` — type-only imports, works regardless
- `subprocess-snapshot.test.ts` — runtime imports of `AgentLauncher` class, `GenericSubprocessPlugin`, test-utils → satisfied by devDep
- `orchestrator-repos.test.ts` — `vi.mock('@generacy-ai/orchestrator')` → works with devDep

## Key Sources

- npm docs on [optional dependencies](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#optionaldependencies): "If a dependency can be used, but you would like npm to proceed if it cannot be found..."  — they ARE installed by default
- npm 7+ auto-installs peer deps: [RFC 0025](https://github.com/npm/rfcs/blob/main/implemented/0025-install-peer-deps.md)
- pnpm workspace protocol: [docs](https://pnpm.io/workspaces#workspace-protocol-workspace)
- TypeScript handbook on [declaration files](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)
