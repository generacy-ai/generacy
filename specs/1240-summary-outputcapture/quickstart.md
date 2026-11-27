# Quickstart: Detect SPECKIT_IMPLEMENT sentinels inside stream-json envelopes

**Issue**: #1240 | **Branch**: `1240-summary-outputcapture`

## Setup

```bash
pnpm install
# Cross-package imports resolve to built dist/ — build deps before testing orchestrator:
pnpm --filter @generacy-ai/orchestrator... build
```

## Run the relevant tests

```bash
# New envelope-sentinel tests + existing regression suites
pnpm --filter @generacy-ai/orchestrator test -- output-capture

# Full package suite (SC-002)
pnpm --filter @generacy-ai/orchestrator test
```

## Behavior at a glance

`OutputCapture` now detects implement sentinels in three places:

1. **Raw stdout line** (pre-existing): line starts with the sentinel prefix.
2. **Assistant text blocks** (new): any `\n`-split, trimmed line of a
   `message.content[].text` string that starts with the prefix.
3. **Result string** (new): same scan over a `result` event's `result` string.

All three feed the same parse/validate/last-wins logic; `implementResult` is exposed
unchanged via the `implementResult` getter and consumed by the phase-loop increment path.

### Quick manual check

```ts
import { OutputCapture } from './src/worker/output-capture.js';

const cap = new OutputCapture('wf-1', logger);
cap.processChunk(JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'done for now\nSPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":10,"tasks_remaining":44,"tasks_total":54}' }] },
}) + '\n');
console.log(cap.implementResult); // { partial: true, tasks_completed: 10, ... }
```

## Troubleshooting

- **`implementResult` undefined despite sentinel in transcript** — check the sentinel
  opens its own line inside the text block (mid-line occurrences deliberately don't
  match), and that the payload is valid JSON (malformed payloads are warned + ignored:
  grep worker logs for `Malformed SPECKIT_IMPLEMENT_`).
- **Spurious type errors when testing** — rebuild dependency packages first (see Setup);
  stale `dist/` causes "no exported member" noise.
- **Changeset gate fails on the PR** — this change touches
  `packages/orchestrator/src/`, so the PR must add `.changeset/1240-stream-json-sentinels.md`
  (`@generacy-ai/orchestrator: patch`).
