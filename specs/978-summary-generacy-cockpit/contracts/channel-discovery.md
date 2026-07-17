# Contract: `discoverChannelUrl`

Pure async function that resolves the smee.io channel URL for the doorbell
process to consume.

## Signature

```ts
export async function discoverChannelUrl(
  input: ChannelDiscoveryInput,
): Promise<ChannelDiscoveryResult | null>;
```

## Precedence

1. `env.COCKPIT_DOORBELL_SMEE_URL` — if present.
2. `fs.readFile(input.channelFilePath, 'utf-8')` — trim.

First tier that yields a `SMEE_URL_PATTERN`-matching URL wins. Non-matching
values in tier 1 log a warning and fall through to tier 2. Non-matching values
in tier 2 log a warning and return `null`. ENOENT in tier 2 is silent
(the common case on webhook-less clusters).

## Return shape

| tier | env has valid URL | file exists | file has valid URL | result | warn? |
|---|---|---|---|---|---|
| — | no (unset) | no (ENOENT) | — | `null` | no |
| env | yes | irrelevant | irrelevant | `{ url, source: 'env' }` | no |
| env | invalid | ENOENT | — | `null` | env only |
| env | invalid | valid file | yes | `{ url, source: 'file' }` | env only |
| file | no (unset) | yes | yes | `{ url, source: 'file' }` | no |
| file | no (unset) | yes | no | `null` | file |

## Validation regex

`SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`

Copied verbatim from
`packages/orchestrator/src/services/smee-channel-resolver.ts` to avoid an
orchestrator import in the CLI.

## Test cases

- `env='https://smee.io/abc123', file=ENOENT` → `{ url: 'https://smee.io/abc123', source: 'env' }`.
- `env=unset, file='https://smee.io/xyz789\n'` → `{ url: 'https://smee.io/xyz789', source: 'file' }` (trim).
- `env=unset, file=ENOENT` → `null`, zero warn calls.
- `env='not-a-url', file='https://smee.io/xyz789'` → `{ url: 'https://smee.io/xyz789', source: 'file' }`, one warn.
- `env=unset, file='malformed content'` → `null`, one warn.
- `env=unset, file='https://not-smee.example.com/foo'` → `null`, one warn.
- `env='https://smee.io/abc123 '` (trailing whitespace, regex doesn't allow) → `null`, one warn, no fall-through (env was explicitly set).

## Failure behavior

Never throws. All I/O errors caught internally and folded into `null` +
optional `warn`.
