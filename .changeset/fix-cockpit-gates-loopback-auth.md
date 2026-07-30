---
"@generacy-ai/orchestrator": patch
---

fix(orchestrator): stop `/cockpit/gates` open/ack 401ing under `--gates=ui`. The co-located cockpit MCP POSTs gate open/ack over loopback with no API key by design, but the route was behind the global auth middleware and not exempt, so every remote gate 401'd and the plugin fell back to a local `AskUserQuestion` (fatal for headless UI-driven runs). Exempt `/cockpit/gates[/:id/ack]` from API-key auth **only** for a loopback TCP peer (`socket.remoteAddress`, not the spoofable `request.ip`), so the host-published `0.0.0.0` listener never exposes an unauthenticated, cloud-forwarding gate surface to the network.
