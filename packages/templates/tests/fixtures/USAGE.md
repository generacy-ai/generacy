# Fixture Usage Quick Reference

## Importing Fixtures in Tests

```typescript
// Valid contexts
import singleRepoContext from './fixtures/single-repo-context.json';
import multiRepoContext from './fixtures/multi-repo-context.json';
import minimalContext from './fixtures/minimal-single-repo-context.json';
import largeContext from './fixtures/large-multi-repo-context.json';

// Invalid contexts
import invalidContexts from './fixtures/invalid-contexts.json';

// Extensions.json
import existingExtensions from './fixtures/existing-extensions.json';
```

## Common Test Patterns

### Testing Template Rendering

```typescript
import { renderProject } from '../../src/index.js';
import singleRepoContext from './fixtures/single-repo-context.json';

test('renders single-repo project', async () => {
  const files = await renderProject(singleRepoContext);

  expect(files.size).toBe(5);
  expect(files.has('.generacy/config.yaml')).toBe(true);
});
```

### Testing Validation Errors

```typescript
import { validateContext } from '../../src/validators.js';
import invalidContexts from './fixtures/invalid-contexts.json';

test('rejects missing project ID', () => {
  const testCase = invalidContexts.missingProjectId;

  expect(() => validateContext(testCase.context))
    .toThrow(/project\.id/);
});
```

### Testing Extensions.json Merge

```typescript
import { renderExtensionsJson } from '../../src/renderer.js';
import { readFileSync } from 'fs';
import multiRepoContext from './fixtures/multi-repo-context.json';

test('merges extensions without duplicates', async () => {
  const existing = readFileSync(
    './fixtures/existing-extensions.json',
    'utf-8'
  );

  const result = await renderExtensionsJson(
    multiRepoContext,
    existing
  );

  const parsed = JSON.parse(result);
  expect(parsed.recommendations).toContain('generacy-ai.agency');
  expect(parsed.recommendations).toContain('dbaeumer.vscode-eslint');
});
```

## When to Use Each Fixture

| Fixture | Use Case |
|---------|----------|
| `single-repo-context.json` | Standard single-repo rendering |
| `multi-repo-context.json` | Standard multi-repo rendering |
| `minimal-single-repo-context.json` | Testing default value application |
| `large-multi-repo-context.json` | Testing performance with many repos |
| `preview-release-context.json` | Testing preview release stream |
| `custom-base-image-context.json` | Testing language-specific images |
| `invalid-contexts.json` | Testing validation error messages |
| `existing-extensions.json` | Testing merge with existing file |
| `existing-extensions-with-generacy.json` | Testing deduplication |
| `empty-extensions.json` | Testing merge with empty file |

## Modifying Fixtures

If you need to modify a fixture for a specific test:

```typescript
import singleRepoContext from './fixtures/single-repo-context.json';

test('custom worker count', async () => {
  const customContext = {
    ...singleRepoContext,
    orchestrator: {
      ...singleRepoContext.orchestrator,
      workerCount: 5,
    },
  };

  // Use customContext in test
});
```

## Adding New Fixtures

1. Create the fixture JSON file
2. Add validation test in `fixture-validation.test.ts`
3. Document in `README.md`
4. Update this usage guide

## Fixture Validation

Run validation tests to ensure fixtures are valid:

```bash
pnpm test tests/fixtures/fixture-validation.test.ts
```
