# Quickstart: Orchestrator Types Extraction

## After Implementation

### For CLI users (no change)

```bash
# Launch flow — installs faster, no orchestrator deps
npx -y @generacy-ai/generacy@stable launch --claim=ABC123

# Orchestrator subcommand — shows clear error if not installed
generacy orchestrator
# Error: The orchestrator package is not installed.
# Install it with: npm install @generacy-ai/orchestrator
```

### For developers

```bash
# Install all workspace deps (including devDeps)
pnpm install

# Build types package (built automatically by pnpm workspace)
pnpm --filter @generacy-ai/orchestrator-types build

# Build everything
pnpm build

# Run CLI tests (orchestrator available as devDep)
pnpm --filter @generacy-ai/generacy test
```

### Using the types package

```typescript
// Import types only (no runtime cost)
import type { AgentLauncher, LaunchHandle } from '@generacy-ai/orchestrator-types';

// In orchestrator — class implements the interface
import type { AgentLauncher as IAgentLauncher } from '@generacy-ai/orchestrator-types';

export class AgentLauncher implements IAgentLauncher {
  // ...
}
```

### Verifying the fix

```bash
# Before: check install size
cd /tmp && mkdir test-before && cd test-before
npm init -y && npm install @generacy-ai/generacy
du -sh node_modules  # ~50-100 MB with orchestrator

# After: check install size
cd /tmp && mkdir test-after && cd test-after
npm init -y && npm install @generacy-ai/generacy
du -sh node_modules  # Significantly smaller — no Fastify/ioredis/prom-client
```

## Troubleshooting

### "The orchestrator package is not installed"

This is expected when running `generacy orchestrator` without the orchestrator package. Install it:

```bash
npm install @generacy-ai/orchestrator
```

### Type errors after update

If you see type mismatches between `orchestrator-types` and `orchestrator`, ensure both are on compatible versions. The orchestrator class implements the types package interface, so they should stay in sync.

### pnpm workspace build order

The types package must build before the orchestrator. pnpm handles this automatically via workspace dependency resolution. If you get build errors, try:

```bash
pnpm --filter @generacy-ai/orchestrator-types build
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/generacy build
```
