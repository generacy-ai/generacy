import type http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { type ActorContext, requireActor } from '../context.js';
import { LifecycleActionSchema, ClonePeerReposBodySchema, WorkerScaleBodySchema } from '../schemas.js';
import { ControlPlaneError } from '../errors.js';
import { getCodeServerManager } from '../services/code-server-manager.js';
import { getVsCodeTunnelManager } from '../services/vscode-tunnel-manager.js';
import { readBody } from '../util/read-body.js';
import { clonePeerRepos } from '../services/peer-repo-cloner.js';
import { scaleWorkers, PartialScaleError } from '../services/worker-scaler.js';
import { DockerDaemonUnavailableError } from '../services/docker-engine-types.js';
import { writeWizardEnvFile } from '../services/wizard-env-writer.js';
import { getRelayPushEvent } from '../relay-events.js';

export async function handlePostLifecycle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,
  params: Record<string, string>,
): Promise<void> {
  requireActor(actor);
  const action = params['action'] ?? '';
  const parsed = LifecycleActionSchema.safeParse(action);

  if (!parsed.success) {
    throw new ControlPlaneError('UNKNOWN_ACTION', `Unknown lifecycle action: ${action}`);
  }

  res.setHeader('Content-Type', 'application/json');

  if (parsed.data === 'code-server-start') {
    const manager = getCodeServerManager();
    let result;
    try {
      result = await manager.start();
    } catch (err) {
      throw new ControlPlaneError(
        'SERVICE_UNAVAILABLE',
        err instanceof Error ? err.message : 'Failed to start code-server',
      );
    }
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (parsed.data === 'code-server-stop') {
    const manager = getCodeServerManager();
    await manager.stop();
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: true, action: parsed.data }));
    return;
  }

  if (parsed.data === 'clone-peer-repos') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ControlPlaneError('INVALID_REQUEST', 'Invalid JSON body');
    }

    const bodyResult = ClonePeerReposBodySchema.safeParse(body);
    if (!bodyResult.success) {
      throw new ControlPlaneError('INVALID_REQUEST', 'Invalid clone-peer-repos body', {
        errors: bodyResult.error.issues.map((i) => i.message),
      });
    }

    await clonePeerRepos({ repos: bodyResult.data.repos, token: bodyResult.data.token });
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: true, action: parsed.data }));
    return;
  }

  if (parsed.data === 'vscode-tunnel-start') {
    const tunnelManager = getVsCodeTunnelManager();
    let result;
    try {
      result = await tunnelManager.start();
    } catch (err) {
      throw new ControlPlaneError(
        'SERVICE_UNAVAILABLE',
        err instanceof Error ? err.message : 'Failed to start VS Code tunnel',
      );
    }
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (parsed.data === 'vscode-tunnel-stop') {
    const tunnelManager = getVsCodeTunnelManager();
    await tunnelManager.stop();
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: true, action: parsed.data }));
    return;
  }

  if (parsed.data === 'vscode-tunnel-unregister') {
    // Releases Microsoft tunnel-service name so the cluster name is reclaimable
    // after `generacy destroy`. Failures surface via cluster.vscode-tunnel
    // relay events (FR-010), not 5xx — the unregister() implementation is
    // best-effort and never throws.
    const tunnelManager = getVsCodeTunnelManager();
    await tunnelManager.unregister();
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: true, action: parsed.data }));
    return;
  }

  if (parsed.data === 'prepare-workspace') {
    // Subset of bootstrap-complete: unseal whatever credentials are currently
    // stored (typically just GitHub after the wizard's GitHubAppInstall step)
    // and create the post-activation sentinel so the cluster clones the
    // workspace in the background. Deliberately skips code-server / tunnel
    // start — those wait for bootstrap-complete at the end of the wizard.
    //
    // Idempotent w.r.t. bootstrap-complete: both use the same sentinel path
    // and the same writeWizardEnvFile call (which writes whatever is sealed
    // at the moment). The sentinel is only written once the GitHub token is
    // actually sealed — otherwise the one-shot post-activation watcher fires
    // the deferred clone before GH_TOKEN exists, clones nothing, and never
    // re-runs when the token lands. When the token isn't ready yet we skip the
    // sentinel; bootstrap-complete (end of wizard, full credentials) fires it.
    const agencyDir = process.env.AGENCY_DIR ?? '/workspaces/.agency';
    const envFilePath = process.env.WIZARD_CREDS_PATH ?? '/var/lib/generacy/wizard-credentials.env';
    let hasGitHubToken = false;
    try {
      const envResult = await writeWizardEnvFile({ agencyDir, envFilePath });
      hasGitHubToken = envResult.hasGitHubToken;
      if (envResult.failed.length > 0) {
        const pushEvent = getRelayPushEvent();
        pushEvent?.('cluster.bootstrap', {
          warning: 'credential-unseal-partial',
          failed: envResult.failed,
          written: envResult.written,
        });
      }
    } catch {
      // Non-fatal: log and continue — post-activation will see missing env vars
    }

    const sentinel = process.env.POST_ACTIVATION_TRIGGER ?? '/tmp/generacy-bootstrap-complete';
    if (hasGitHubToken) {
      await writeFile(sentinel, '', { flag: 'w' });
    } else {
      // GitHub token not sealed yet — defer the clone to bootstrap-complete so
      // the one-shot post-activation hook runs with a usable GH_TOKEN.
      getRelayPushEvent()?.('cluster.bootstrap', {
        status: 'awaiting-credentials',
        reason: 'github-token-not-sealed',
      });
    }

    res.writeHead(200);
    res.end(
      JSON.stringify({
        accepted: true,
        action: parsed.data,
        sentinel: hasGitHubToken ? sentinel : null,
      }),
    );
    return;
  }

  if (parsed.data === 'bootstrap-complete') {
    // Unseal wizard credentials and write transient env file before sentinel
    const agencyDir = process.env.AGENCY_DIR ?? '/workspaces/.agency';
    const envFilePath = process.env.WIZARD_CREDS_PATH ?? '/var/lib/generacy/wizard-credentials.env';
    try {
      const envResult = await writeWizardEnvFile({ agencyDir, envFilePath });
      if (envResult.failed.length > 0) {
        const pushEvent = getRelayPushEvent();
        pushEvent?.('cluster.bootstrap', {
          warning: 'credential-unseal-partial',
          failed: envResult.failed,
          written: envResult.written,
        });
      }
    } catch {
      // Non-fatal: log and continue — post-activation will see missing env vars
    }

    const sentinel = process.env.POST_ACTIVATION_TRIGGER ?? '/tmp/generacy-bootstrap-complete';
    await writeFile(sentinel, '', { flag: 'w' });

    // Fire-and-forget: start code-server asynchronously (don't block the response)
    const manager = getCodeServerManager();
    manager.start().catch(() => {
      // code-server start failure is non-fatal; metadata will report codeServerReady: false
    });

    // Auto-start VS Code tunnel after bootstrap completes
    try {
      const tunnelManager = getVsCodeTunnelManager();
      await tunnelManager.start();
    } catch {
      // Best-effort: don't fail bootstrap-complete if tunnel start fails
    }

    res.writeHead(200);
    res.end(JSON.stringify({ accepted: true, action: parsed.data, sentinel }));
    return;
  }

  if (parsed.data === 'worker-scale') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ControlPlaneError('INVALID_REQUEST', 'Invalid JSON body');
    }

    const bodyResult = WorkerScaleBodySchema.safeParse(body);
    if (!bodyResult.success) {
      throw new ControlPlaneError('INVALID_REQUEST', 'Invalid worker-scale body', {
        errors: bodyResult.error.issues.map((i) => i.message),
      });
    }

    try {
      const result = await scaleWorkers({ count: bodyResult.data.count });
      res.writeHead(200);
      res.end(JSON.stringify({
        accepted: true,
        action: 'worker-scale',
        previousCount: result.previousCount,
        requestedCount: result.requestedCount,
        actualCount: result.actualCount,
      }));
    } catch (err) {
      // Partial-failure: 200 OK with partial: true (best-effort succeeded somewhat —
      // returning 5xx would mislead the cloud UI into showing a hard failure when
      // the cluster did make progress). cluster.yaml already reflects actualCount.
      if (err instanceof PartialScaleError || (err instanceof Error && err.name === 'PartialScaleError')) {
        const partialErr = err as PartialScaleError;
        res.writeHead(200);
        res.end(JSON.stringify({
          accepted: true,
          action: 'worker-scale',
          partial: true,
          previousCount: partialErr.previousCount,
          requestedCount: partialErr.requested,
          actualCount: partialErr.actual,
          error: {
            code: 'PARTIAL_SCALE',
            message: partialErr.message,
          },
        }));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // DockerDaemonUnavailableError sets message === 'DOCKER_DAEMON_UNAVAILABLE' for
      // backward-compat string-match. instanceof preferred but message works too.
      if (
        err instanceof DockerDaemonUnavailableError ||
        message === 'DOCKER_DAEMON_UNAVAILABLE'
      ) {
        const details = err instanceof DockerDaemonUnavailableError
          ? { socketPath: err.socketPath }
          : undefined;
        throw new ControlPlaneError(
          'DOCKER_DAEMON_UNAVAILABLE',
          'Docker daemon is not reachable',
          details,
        );
      }
      throw new ControlPlaneError('INTERNAL_ERROR', `Worker scale failed: ${message}`);
    }
    return;
  }

  // 'stop' — stub for v1.5
  res.writeHead(200);
  res.end(JSON.stringify({ accepted: true, action: parsed.data }));
}
