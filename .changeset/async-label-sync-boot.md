---
"@generacy-ai/orchestrator": patch
---

Run repo label sync fire-and-forget after `server.listen()` instead of blocking boot.

`LabelSyncService.syncAll` walks dozens of sequential GitHub label create/update
calls (~30s on a fresh repo creating ~68 labels) and was `await`ed before the
server started listening. On a wizard cluster's post-activation self-restart —
where the label monitor first becomes enabled with the repo present — that kept
the orchestrator, and therefore the relay and the cloud bootstrap UI, unreachable
for the entire sync. Label sync now runs in the onReady hook (like the existing
monitors), so the server becomes ready and reconnects the relay immediately;
labels sync in the background. Cuts ~30s off the onboarding restart window.
