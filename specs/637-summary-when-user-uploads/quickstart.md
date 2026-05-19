# Quickstart: Boot-render uploaded file blobs

**Feature**: #637 | **Date**: 2026-05-16

## What Changed

Three files modified in `packages/control-plane/`:

1. **`src/services/app-config-file-store.ts`** — New `renderAll()` method + `atomicWriteFile()` helper
2. **`src/routes/app-config.ts`** — Export `isPathDenied()` and `readManifest()`
3. **`bin/control-plane.ts`** — Call `appConfigFileStore.renderAll()` at boot

## Verification

### Unit Tests

```bash
cd packages/control-plane
pnpm test -- --grep "renderAll"
```

Expected test cases:
- Renders all files from metadata to their manifest mountPaths
- Skips files not in current manifest (orphaned blob)
- Skips files with denylisted mountPath
- Skips files with missing backend blob (no crash)
- Handles EACCES on mountPath directory
- Returns empty result when store is disabled
- Returns empty result when no files in metadata

### Manual Testing

1. Start a cluster and upload a file via Settings:
   ```bash
   # Upload a GCP SA JSON via the UI, or directly:
   curl --unix-socket /run/generacy-control-plane/control.sock \
     -X POST http://localhost/app-config/files/gcp-sa-json \
     -H 'Content-Type: application/json' \
     -H 'x-generacy-actor-user-id: test' \
     -d '{"data":"'$(base64 -w0 sa.json)'"}'
   ```

2. Verify the file exists:
   ```bash
   docker exec <container> ls -la /home/node/.config/gcloud/secrets/sa.json
   ```

3. Restart the container:
   ```bash
   docker compose down && docker compose up -d
   ```

4. Verify the file was re-rendered:
   ```bash
   docker exec <container> ls -la /home/node/.config/gcloud/secrets/sa.json
   # Should exist with same size as before
   ```

5. Check logs for structured event:
   ```bash
   docker compose logs orchestrator 2>&1 | grep files-rendered
   # Expected: {"event":"files-rendered","count":1,"skipped":0}
   ```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| File missing after restart | `renderAll()` not called | Check `bin/control-plane.ts` wiring |
| `files-rendered` count=0 | No files in `values.yaml` metadata | Verify file was uploaded (check `/app-config/values`) |
| File in `skipped` | Manifest changed or path denylisted | Check `cluster.yaml` for current `mountPath` |
| EACCES warning in logs | Parent dir not writable | Check container volume mounts / permissions |
