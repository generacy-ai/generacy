# Test Fixtures

This directory contains test fixtures for the `@generacy-ai/templates` package.

## Template Context Fixtures

These JSON files contain valid `TemplateContext` objects used for testing template rendering.

### Valid Contexts

#### `single-repo-context.json`
A realistic single-repository project using TypeScript/Node.js base image.
- **Use for**: Testing single-repo template rendering
- **Features**: TypeScript base image, stable release stream, main branch

#### `multi-repo-context.json`
A realistic multi-repository platform with 3 dev repos and 2 clone repos.
- **Use for**: Testing multi-repo template rendering, docker-compose generation
- **Features**: 3 workers, develop base branch, cloud-generated context

#### `minimal-single-repo-context.json`
An edge case with absolute minimal configuration (all defaults applied).
- **Use for**: Testing default value application, minimal valid context
- **Features**: Simple user/org structure, all defaults

#### `large-multi-repo-context.json`
An edge case with many repositories (10 dev repos, 6 clone repos).
- **Use for**: Testing template rendering with large repo arrays, performance
- **Features**: 8 workers, preview release stream, enterprise scale

#### `preview-release-context.json`
Single-repo project using preview release stream.
- **Use for**: Testing `:preview` feature tag generation
- **Features**: Python base image, develop branch, preview stream

#### `custom-base-image-context.json`
Single-repo project with language-specific base image (Rust).
- **Use for**: Testing custom base image support
- **Features**: Rust devcontainer image, stable stream

## Invalid Context Fixtures

### `invalid-contexts.json`
A collection of invalid contexts for validation testing. Each entry includes:
- `description`: What makes this context invalid
- `context`: The invalid context object
- `expectedError`: The expected validation error message (partial match)

**Invalid cases included**:
1. **missingProjectId**: Missing required `project.id` field
2. **invalidRepoFormat**: Primary repo not in "owner/repo" format
3. **invalidFeatureTag**: Feature tag not `:1` or `:preview`
4. **negativeWorkerCount**: Worker count is negative
5. **invalidTimestamp**: Malformed ISO 8601 timestamp
6. **invalidVersionFormat**: Non-semver version string
7. **emptyProjectName**: Empty project name (fails min length)
8. **invalidDevRepoFormat**: Dev repo array contains invalid format
9. **zeroPollInterval**: Poll interval is 0 (must be positive)

**Usage in tests**:
```typescript
import invalidContexts from './fixtures/invalid-contexts.json';

test('validation rejects invalid contexts', () => {
  for (const [key, testCase] of Object.entries(invalidContexts)) {
    expect(() => validateContext(testCase.context))
      .toThrow(testCase.expectedError);
  }
});
```

## Extensions.json Fixtures

These fixtures test the `renderExtensionsJson` merge logic.

### `existing-extensions.json`
A typical VS Code extensions.json with ESLint, Prettier, and unwanted recommendations.
- **Use for**: Testing merge behavior, ensuring Generacy extensions are added
- **Expected result**: Generacy extensions appended, existing extensions preserved

### `existing-extensions-with-generacy.json`
Extensions.json that already includes one Generacy extension.
- **Use for**: Testing deduplication (should not add duplicates)
- **Expected result**: Missing Generacy extension added, no duplicates

### `empty-extensions.json`
Minimal extensions.json with empty recommendations array.
- **Use for**: Testing merge with empty file
- **Expected result**: Only Generacy extensions present

## Usage in Tests

### Loading Fixtures

```typescript
import singleRepoContext from './fixtures/single-repo-context.json';
import multiRepoContext from './fixtures/multi-repo-context.json';
import invalidContexts from './fixtures/invalid-contexts.json';

// Use in tests
const files = await renderProject(singleRepoContext);
```

### Testing with Fixtures

```typescript
import { describe, test, expect } from 'vitest';
import { renderProject, validateContext } from '../src/index.js';
import singleRepoContext from './fixtures/single-repo-context.json';

describe('renderProject', () => {
  test('renders single-repo project correctly', async () => {
    const files = await renderProject(singleRepoContext);

    expect(files.size).toBe(5); // config, env, gitignore, devcontainer, extensions
    expect(files.has('.generacy/config.yaml')).toBe(true);
    expect(files.has('.devcontainer/devcontainer.json')).toBe(true);
  });
});
```

## Maintenance

When updating the schema in `src/schema.ts`:
1. Update existing fixtures to match new schema requirements
2. Add new fixtures for new validation edge cases
3. Update `invalid-contexts.json` to test new validation rules
4. Run tests to ensure all fixtures are still valid: `pnpm test`

## Fixture Validation

All valid context fixtures should pass schema validation:

```typescript
import { validateContext } from '../src/validators.js';
import singleRepoContext from './fixtures/single-repo-context.json';

// This should not throw
const validated = validateContext(singleRepoContext);
```

To verify all fixtures are valid, run the fixture validation test:
```bash
pnpm test fixtures
```
