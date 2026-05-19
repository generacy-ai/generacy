# Quickstart: Thread projectId into activation URL

**Feature**: #616 | **Date**: 2026-05-14

## What Changed

When the orchestrator prints the "Go to:" activation URL, it now includes:
- `?code=<user_code>` — always (auto-fills the code field)
- `&projectId=<uuid>` — when `GENERACY_PROJECT_ID` is set (pre-selects the project)

## Testing

### Launch flow (projectId present)

```bash
npx generacy launch --claim=<code>
```

Expected: Browser opens `https://app.generacy.ai/cluster-activate?code=XXXX-XXXX&projectId=<uuid>`.

### Direct compose flow (projectId absent)

```bash
cd my-cluster && docker compose up
```

Expected: Browser URL is `https://app.generacy.ai/cluster-activate?code=XXXX-XXXX` (no projectId param). No errors about missing env var.

### Deploy flow

```bash
npx generacy deploy ssh://user@host
```

Expected: Same behavior as launch — `projectId` appended if available from launch config.

## Verification Checklist

- [ ] `.generacy/.env` contains `GENERACY_PROJECT_ID=<uuid>` (already true from scaffolder)
- [ ] Orchestrator logs show `Go to: https://…/cluster-activate?code=…&projectId=…`
- [ ] CLI opens the full parameterized URL in browser
- [ ] Without `GENERACY_PROJECT_ID`, URL has only `?code=…`
- [ ] Unit tests pass: `pnpm --filter @generacy-ai/orchestrator test`
