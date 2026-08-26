# Contract: `runActivation` options — `projectId` threading

Issue: [generacy-ai/generacy#1190](https://github.com/generacy-ai/generacy/issues/1190)

Internal contract (not a public package export). Pins the purity guarantee behind FR-003.

## Signature

```ts
export interface ActivateOptions {
  cloudUrl: string;
  logger: ActivationLogger;
  projectId?: string;        // NEW
  maxCycles?: number;
  maxRetries?: number;
}

export async function runActivation(options: ActivateOptions): Promise<ActivationResult>;
```

## Invariants

- **INV-1 (purity)**: `runActivation` MUST NOT read `process.env['GENERACY_PROJECT_ID']`
  (nor any ambient env for URL construction). The projectId used in the activation URL
  MUST come from `options.projectId`. Verified by SC-001/SC-002 (both pass regardless of
  the ambient variable).
- **INV-2 (URL byte-identity, NFR-001)**: For inputs `(verificationUri, userCode, projectId)`,
  the emitted URL is:
  - `projectId` truthy → `<verificationUri>?code=<userCode>&projectId=<projectId>`
  - `projectId` falsy/absent → `<verificationUri>?code=<userCode>`
  (query-param order per `URLSearchParams.set`: `code` then `projectId`.)
- **INV-3 (single ambient read)**: `process.env['GENERACY_PROJECT_ID']` is read exactly
  once, at `deploy/index.ts`, and forwarded as `options.projectId`.

## Caller obligation

`handleDeploy` (`deploy/index.ts`) resolves the ambient variable and passes it:

```ts
await runActivation({
  cloudUrl,
  logger,
  projectId: process.env['GENERACY_PROJECT_ID'],
});
```

## Test obligations

- One case with **no** `projectId` asserting `https://generacy.ai/activate?code=ABCD-1234`.
- One case with a fixed `projectId` asserting
  `https://generacy.ai/activate?code=ABCD-1234&projectId=<fixed>`.
- Neither case depends on ambient env. Any env stubbing added elsewhere pairs with
  `vi.unstubAllEnvs()` in `afterEach` (FR-004).
