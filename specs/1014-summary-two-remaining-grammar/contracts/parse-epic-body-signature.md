# Contract: `parseEpicBody` TypeScript signature

Type-level contract for the public export from `@generacy-ai/cockpit`.

## Exported types

```typescript
// packages/cockpit/src/resolver/types.ts

export interface ParseEpicBodyOptions {
  defaultRepo?: string;
}
```

Re-exported from `packages/cockpit/src/index.ts` alongside existing type exports:

```typescript
export type {
  IssueRef,
  ParsedPhase,
  ParsedEpicBody,
  ResolvedEpic,
  ResolveEpicOptions,
  ParseEpicBodyOptions,   // NEW
} from './resolver/types.js';
```

## Function signature

```typescript
// packages/cockpit/src/resolver/parse-epic-body.ts

export function parseEpicBody(
  body: string,
  options?: ParseEpicBodyOptions,
): ParsedEpicBody;
```

## Backwards compatibility

All four calling shapes must compile and produce equivalent output:

```typescript
parseEpicBody(body);
parseEpicBody(body, undefined);
parseEpicBody(body, {});
parseEpicBody(body, { defaultRepo: undefined });
```

All four MUST behave identically to today's `parseEpicBody(body)`.

## Behavior matrix

| `options.defaultRepo` value | Bare `#N` in checkbox → | Warning emitted |
|-----------------------------|--------------------------|-----------------|
| `undefined` / omitted | rejected (existing #826 path) | `bare '#N'` warning |
| `""` | rejected (validation fails) | `invalid defaultRepo` warning (once), then bare-`#N` handling as if unset |
| `"owner"` (no slash) | rejected (validation fails) | `invalid defaultRepo` warning (once), then bare-`#N` handling as if unset |
| `"owner/repo"` | accepted → `{ repo: 'owner/repo', number: N }` | none (positive path) |
| `"owner/repo/extra"` | rejected (validation fails) | `invalid defaultRepo` warning (once), then bare-`#N` handling as if unset |
| `"OWNER-x/repo.y"` (dots/dashes) | accepted (per `OWNER_REPO` char class in `ref-shapes.ts:3`) | none |

## Type-narrowing test

The TypeScript compiler MUST accept:

```typescript
import { parseEpicBody, type ParseEpicBodyOptions } from '@generacy-ai/cockpit';

const opts: ParseEpicBodyOptions = { defaultRepo: 'owner/repo' };
const r1 = parseEpicBody('body');            // legacy
const r2 = parseEpicBody('body', opts);       // options
const r3 = parseEpicBody('body', {});         // empty
```

The compiler MUST reject:

```typescript
parseEpicBody('body', { defaultRepo: 123 });     // wrong type
parseEpicBody('body', { unknownField: 'x' });    // excess property check
```

## Semver classification

`minor` for `@generacy-ai/cockpit` — additive optional parameter and new exported type. No breaking change to existing signature.
