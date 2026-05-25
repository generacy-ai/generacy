# Contract: Activation poll body extension

**Module**: `packages/activation-client/src/client.ts`, `packages/activation-client/src/types.ts`, `packages/activation-client/src/poller.ts`
**Issue**: [#716](https://github.com/generacy-ai/generacy/issues/716)

## Wire format

### Request

`POST /api/clusters/device-code/poll`

```json
{
  "device_code": "<string>",
  "workers": 4
}
```

Where `workers` is an OPTIONAL positive integer.

Schema:

```ts
// packages/activation-client/src/types.ts (NEW export)
export const PollRequestSchema = z.object({
  device_code: z.string().min(1),
  workers: z.number().int().min(1).optional(),
});
export type PollRequest = z.infer<typeof PollRequestSchema>;
```

### Response

Unchanged — same discriminated union (`authorization_pending` | `slow_down` | `expired` | `approved`).

## Client signature change

```ts
// packages/activation-client/src/client.ts

/**
 * Single-shot poll request (no retry).
 *
 * @param cloudUrl   Base cloud URL.
 * @param deviceCode Device code from initial /device-code response.
 * @param httpClient Injected HTTP client.
 * @param workers    OPTIONAL — when set, included in the request body so the
 *                   cloud can set `targetWorkers` on the cluster doc once
 *                   the activation transitions to `approved`.
 */
export async function pollDeviceCode(
  cloudUrl: string,
  deviceCode: string,
  httpClient: HttpClient,
  workers?: number,
): Promise<PollResponse> {
  const url = `${cloudUrl}/api/clusters/device-code/poll`;
  const body: PollRequest = workers != null
    ? { device_code: deviceCode, workers }
    : { device_code: deviceCode };
  const response = await httpClient.post<unknown>(url, body);
  // … existing PollResponseSchema parse + ActivationError flow unchanged …
}
```

**Note**: The optional argument is appended at the end of the parameter list — existing callers that don't pass `workers` continue to work unchanged.

## Poller signature change

```ts
// packages/activation-client/src/poller.ts

export interface PollOptions {
  cloudUrl: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  httpClient: HttpClient;
  logger: ActivationLogger;
  workers?: number;            // NEW — forwarded to every pollDeviceCode call
}

export async function pollForApproval(options: PollOptions): Promise<PollResponse> {
  const { cloudUrl, deviceCode, expiresIn, httpClient, logger, workers } = options;
  // …
  const response = await pollDeviceCode(cloudUrl, deviceCode, httpClient, workers);
  // … remaining loop unchanged …
}
```

Same value is sent on every poll within an activation cycle. The cloud only acts on it once (when the cycle transitions to `approved`), so re-sending is idempotent and acceptable.

## Orchestrator integration

```ts
// packages/orchestrator/src/activation/index.ts

const pollResult = await pollForApproval({
  cloudUrl,
  deviceCode: deviceCode.device_code,
  interval: deviceCode.interval,
  expiresIn: deviceCode.expires_in,
  httpClient,
  logger,
  workers: options.initialWorkers,    // NEW — from ActivationOptions
});
```

```ts
// packages/orchestrator/src/server.ts (call site)

const initialWorkersRaw = process.env['GENERACY_INITIAL_WORKERS'];
let initialWorkers: number | undefined;
if (initialWorkersRaw != null) {
  const parsed = Number.parseInt(initialWorkersRaw, 10);
  if (Number.isInteger(parsed) && parsed >= 1) {
    initialWorkers = parsed;
  } else {
    logger.warn(`GENERACY_INITIAL_WORKERS="${initialWorkersRaw}" is not a positive integer; ignoring`);
  }
}

const activationResult = await activate({
  cloudUrl,
  keyFilePath,
  clusterJsonPath,
  logger,
  initialWorkers,
});
```

## Backward / forward compatibility

| Cloud state                  | CLI sends `workers`? | Cloud reads `workers`? | Behavior                                              |
|------------------------------|----------------------|------------------------|-------------------------------------------------------|
| Pre-companion (#696)         | yes                  | no                     | Extra field ignored. `targetWorkers` not set on doc.  |
| Post-companion (#696)        | yes                  | yes                    | `targetWorkers` set once on `approved`.               |
| Pre-companion (#696)         | no (existing key)    | n/a                    | Re-activation path skips polls entirely.              |
| Post-companion (#696)        | no (env unset)       | yes (but absent)       | `targetWorkers` stays unset; cloud uses its default.  |

No breakage in any quadrant. Adding the optional field to the wire format is a non-breaking change on both sides.

## Tests

### `packages/activation-client/tests/client.test.ts` (extend existing)

```ts
describe('pollDeviceCode', () => {
  it('omits workers from body when undefined', async () => {
    const stub = mockHttpClient({ status: 200, data: { status: 'authorization_pending' } });
    await pollDeviceCode('https://cloud', 'dev-code', stub);
    expect(stub.lastBody).toEqual({ device_code: 'dev-code' });
  });

  it('includes workers in body when provided', async () => {
    const stub = mockHttpClient({ status: 200, data: { status: 'authorization_pending' } });
    await pollDeviceCode('https://cloud', 'dev-code', stub, 4);
    expect(stub.lastBody).toEqual({ device_code: 'dev-code', workers: 4 });
  });
});
```

### `packages/orchestrator/tests/unit/activation/index.test.ts` (extend existing)

```ts
it('threads initialWorkers through to the poller', async () => {
  const pollSpy = vi.fn().mockResolvedValue({ status: 'approved', /* … */ });
  // … fixture setup …
  await activate({ …, initialWorkers: 4 });
  expect(pollSpy).toHaveBeenCalledWith(
    expect.objectContaining({ workers: 4 })
  );
});
```
