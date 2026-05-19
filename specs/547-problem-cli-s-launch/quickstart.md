# Quickstart: Differentiated 4xx Error Messages

## What Changed

`generacy launch` and `generacy deploy` now show specific, actionable error messages instead of the generic "Claim code is invalid or expired" for all HTTP 4xx responses.

## Error Messages by Scenario

### 400 — Claim format rejected
```
Failed to fetch launch configuration: The cloud rejected the claim format
(400: Claim code contains invalid characters from https://api.generacy.ai/api/clusters/launch-config?claim=<redacted>).
Generate a fresh claim from your project page.
```

### 401/403 — Auth misconfiguration
```
Failed to fetch launch configuration: The cloud rejected this request as
unauthenticated (401 from https://api.generacy.ai/api/clusters/launch-config?claim=<redacted>).
The claim endpoint should be public — this likely means the cloud is misconfigured.
Report this with the URL above.
```

### 404 — Wrong cloud environment
```
Failed to fetch launch configuration: The claim was not found at
https://api.generacy.ai/api/clusters/launch-config?claim=<redacted>.
Did you mint the claim in a different environment?
Set GENERACY_CLOUD_URL to the cloud where the claim was minted.
```

### 410 — Claim consumed or expired
```
Failed to fetch launch configuration: Claim has been consumed or expired
(one-time-use, 10-min TTL). Generate a fresh claim from your project page.
```

### 429 — Rate limited
```
Failed to fetch launch configuration: Rate-limited by the cloud
(Retry-After: 30). Wait and retry.
```

## Programmatic Error Handling

Callers can now branch on the error type:

```typescript
import { CloudError } from './cloud-error.js';

try {
  const config = await fetchLaunchConfig(cloudUrl, claimCode);
} catch (error) {
  if (error instanceof CloudError) {
    console.log(error.statusCode); // 404
    console.log(error.url);        // redacted URL
    console.log(error.detail);     // RFC 7807 detail from cloud
    console.log(error.retryAfter); // "30" (for 429s)
  }
}
```

## Testing

```bash
cd packages/generacy
pnpm test -- --grep "cloud-client"
pnpm test -- --grep "cloud-error"
```

## Troubleshooting

**Q: I still see the old "Claim code is invalid or expired" message.**
A: Make sure you're running the updated CLI version. Check with `npx generacy --version`.

**Q: The error says "claim was not found" but I just generated it.**
A: You likely minted the claim in a different cloud environment. Set `GENERACY_CLOUD_URL` to match (e.g., `https://staging.generacy.ai`).

**Q: The error mentions "unauthenticated" — do I need to log in?**
A: No. The launch endpoint is public. This indicates a cloud-side misconfiguration. Report it to the team with the URL shown in the error.
