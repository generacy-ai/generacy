import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';

import { type OrchestratorConfig, loadConfig, createTestConfig } from './config/index.js';
import type { QueueManager } from './types/index.js';
import { correlationIdHook, correlationIdResponseHook, setupGracefulShutdown } from './utils/index.js';
import { setupErrorHandler } from './middleware/error-handler.js';
import { setupRateLimit } from './middleware/rate-limit.js';
import { requestStartHook, requestEndHook } from './middleware/request-logger.js';
import { createAuthMiddleware, InMemoryApiKeyStore } from './auth/index.js';
import { registerRoutes, InMemoryIntegrationRegistry, closeAllSSEConnections, setupHealthRoutes } from './routes/index.js';
import { getSSESubscriptionManager } from './sse/subscriptions.js';
import { WorkflowService, InMemoryWorkflowStore } from './services/workflow-service.js';
import { QueueService, InMemoryQueueStore } from './services/queue-service.js';
import { AgentRegistry } from './services/agent-registry.js';
import { LabelSyncService } from './services/label-sync-service.js';
import { LabelMonitorService } from './services/label-monitor-service.js';
import { PrFeedbackMonitorService } from './services/pr-feedback-monitor-service.js';
import { MergeConflictMonitorService } from './services/merge-conflict-monitor-service.js';
import { ClarificationAnswerMonitorService } from './services/clarification-answer-monitor-service.js';
import { BaseAdvanceMonitorService } from './services/base-advance-monitor-service.js';
import { PhaseTrackerService } from './services/phase-tracker-service.js';
import { RedisQueueAdapter } from './services/redis-queue-adapter.js';
import { InMemoryQueueAdapter } from './services/in-memory-queue-adapter.js';
import { WorkerDispatcher } from './services/worker-dispatcher.js';
import { SmeeWebhookReceiver } from './services/smee-receiver.js';
import { SmeeChannelResolver } from './services/smee-channel-resolver.js';
import { RelayBridge } from './services/relay-bridge.js';
import { LeaseManager } from './services/lease-manager.js';
import { WebhookSetupService } from './services/webhook-setup-service.js';
import {
  createJitGithubTokenProvider,
  resolveSocketPath,
} from './services/jit-github-token-provider.js';
import { clusterApiKeyExists } from './services/cluster-api-key-probe.js';
import { GitHubAuthHealthService } from './services/github-auth-health.js';
import {
  CredentialExpiryWatcher,
  readCredentialDescriptors,
} from './services/credential-expiry-watcher.js';
import { setupWebhookRoutes } from './routes/webhooks.js';
import { setupPrWebhookRoutes } from './routes/pr-webhooks.js';
import { setupDispatchRoutes } from './routes/dispatch.js';
import { createGitHubClient } from '@generacy-ai/workflow-engine';
import { resolveClusterIdentity } from './services/identity.js';
import { Redis as IORedis } from 'ioredis';
import { ClaudeCliWorker } from './worker/claude-cli-worker.js';
import { existsSync } from 'node:fs';
import { probeControlPlaneSocket } from './services/control-plane-probe.js';
import { ConversationManager } from './conversation/conversation-manager.js';
import { ConversationSpawner } from './conversation/conversation-spawner.js';
import { conversationProcessFactory } from './conversation/process-factory.js';
import { createAgentLauncher } from './launcher/launcher-setup.js';
import { CredhelperHttpClient } from './launcher/credhelper-client.js';
import { defaultProcessFactory } from './worker/claude-cli-worker.js';
import { setupConversationRoutes } from './routes/conversations.js';
import { setupSessionDetailRoutes } from './routes/sessions.js';
import { SessionService } from './services/session-service.js';
import { activate } from './activation/index.js';
import { StatusReporter } from './services/status-reporter.js';
import { runPostActivationBranch } from './services/post-activation-dispatch.js';
import { detectIdentitySplit } from './services/identity-split-detector.js';
import {
  TunnelHandler,
  getCodeServerManager,
  DockerEngineClient,
  createJitGitTokenClient,
} from '@generacy-ai/control-plane';
import { setupInternalRelayEventsRoute } from './routes/internal-relay-events.js';
import { setupInternalRefreshMetadataRoute } from './routes/internal-refresh-metadata.js';

/**
 * Server creation options
 */
export interface CreateServerOptions {
  /** Configuration (loads from file/env if not provided) */
  config?: OrchestratorConfig;
  /** Additional Fastify options */
  fastifyOptions?: FastifyServerOptions;
  /** Skip route registration (for testing individual routes) */
  skipRoutes?: boolean;
  /** Pre-configured API key store (creates a new one if not provided) */
  apiKeyStore?: InMemoryApiKeyStore;
}

/**
 * Create and configure the Fastify server
 */
export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  // Configure Fastify logger
  const loggerConfig =
    config.logging.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          },
        }
      : true;

  // Create Fastify instance
  const server = Fastify({
    logger: {
      level: config.logging.level,
      ...(typeof loggerConfig === 'object' ? loggerConfig : {}),
    },
    disableRequestLogging: true, // Custom request-logger hooks handle this
    ...options.fastifyOptions,
  });

  // Store config on server for access in routes
  server.decorate('config', config);

  // Add correlation ID hooks
  server.addHook('onRequest', correlationIdHook);
  server.addHook('onSend', correlationIdResponseHook);

  // Add request logging hooks
  server.addHook('onRequest', requestStartHook);
  server.addHook('onResponse', requestEndHook);

  // Register core plugins
  await server.register(cors, {
    origin: config.cors.origin,
    credentials: config.cors.credentials,
  });

  await server.register(helmet, {
    // Customize helmet for API server
    contentSecurityPolicy: false, // Not needed for API
  });

  // Register JWT plugin
  await server.register(jwt, {
    secret: config.auth.jwt.secret,
    sign: {
      expiresIn: config.auth.jwt.expiresIn,
    },
  });

  // Setup rate limiting
  await setupRateLimit(server, config.rateLimit);

  // Setup error handler
  setupErrorHandler(server);

  // Setup authentication middleware
  const apiKeyStore = options.apiKeyStore ?? new InMemoryApiKeyStore();
  const authMiddleware = createAuthMiddleware({
    apiKeyStore,
    enabled: config.auth.enabled,
    skipRoutes: ['/health', '/metrics', '/webhooks/github', '/webhooks/github/pr-review'],
  });
  server.addHook('preHandler', authMiddleware);

  // Resolve cluster identity for assignee-based issue filtering
  const clusterGithubUsername = await resolveClusterIdentity(
    config.monitor.clusterGithubUsername,
    server.log,
  );

  const isWorkerMode = config.mode === 'worker';

  // Resolve agency dir (matches credhelper-daemon convention). Used by the
  // GitHub auth health service to read credentials.yaml at startup and by the
  // expiry watcher's 60s tick. Safe to compute regardless of mode.
  const agencyDir =
    process.env['CREDHELPER_AGENCY_DIR'] ?? `${process.cwd()}/.agency`;

  // GitHub auth health service — single owner of `githubAuth` state. The
  // emitEvent closure captures relayClientRef declared below; safe because the
  // service does not emit until monitors call recordResult/maybeRequestRefresh,
  // which happens after server.listen() and (in wizard mode) after activation.
  let relayClientRef: import('./types/relay.js').ClusterRelayClient | null = null;
  // #972: StatusReporter ref populated by `initializeRelayBridge()` on both
  // wizard and existing-key paths. Read through by the WebhookSetupService
  // fail-loud triple's `pushStatus('degraded', ...)` call; safe because the
  // 403 fires from a network round-trip, so the ref is populated by the time
  // it dereferences.
  let statusReporterRef: StatusReporter | null = null;
  const githubAuthHealth = !isWorkerMode
    ? new GitHubAuthHealthService({
        emitEvent: (payload) => {
          const client = relayClientRef;
          if (!client || !client.isConnected) return;
          client.send({
            type: 'event',
            event: 'cluster.credentials',
            data: payload,
            timestamp: new Date().toISOString(),
          } as unknown as import('./types/relay.js').RelayMessage);
        },
        logger: server.log,
      })
    : null;

  // Resolve the github-app credentialId once at startup so monitors can pass
  // it through `health.recordResult(credentialId, ...)` and so the JIT token
  // provider has a credentialId to fetch under. The expiry watcher refreshes
  // this map on YAML mtime change. When no github-app credential is configured,
  // the value stays undefined and monitors call a no-op variant. Resolved in
  // BOTH modes — ClaudeCliWorker (worker mode) needs the credentialId for its
  // JIT token provider.
  let githubAppCredentialId: string | undefined;
  {
    const initialDescriptors = await readCredentialDescriptors(agencyDir);
    const ghapp = initialDescriptors.find((d) => d.type === 'github-app');
    githubAppCredentialId = ghapp?.credentialId;
    if (githubAuthHealth && initialDescriptors.length > 0) {
      githubAuthHealth.setCredentials(initialDescriptors);
    }
  }

  // JIT GitHub token provider — replaces the static wizard-creds-token-provider.
  // Resolves a fresh installation token per `gh` invocation via the control-plane
  // /git-token route. Constructed in both orchestrator and worker modes because
  // ClaudeCliWorker (worker mode) also needs it.
  //
  // Gating: built when the cluster-api-key file exists — same precondition the
  // working `git-credential-generacy` path relies on. Wizard-bootstrapped clusters
  // (no `github-app` descriptor in `.agency/credentials.yaml`) still get a
  // credential-less provider; `client.fetch()` is called with no argument and the
  // control-plane resolves the installation server-side from cluster identity.
  // Truly-unconfigured / offline clusters (no api-key file) keep the legacy
  // fallback — provider stays `undefined` and callers inherit ambient `GH_TOKEN`.
  const githubTokenProvider = clusterApiKeyExists()
    ? createJitGithubTokenProvider({
        client: createJitGitTokenClient({ socketPath: resolveSocketPath() }),
        credentialId: githubAppCredentialId,
        authHealth: githubAuthHealth ?? undefined,
        logger: server.log,
      })
    : undefined;

  // Sync labels for watched repositories (skip in worker mode)
  if (!isWorkerMode && config.repositories.length > 0) {
    const labelSyncService = new LabelSyncService(server.log, createGitHubClient, githubTokenProvider);
    try {
      const syncResult = await labelSyncService.syncAll(config.repositories);
      server.log.info(
        `Label sync complete: ${syncResult.successfulRepos}/${syncResult.totalRepos} repos succeeded`
      );
      if (syncResult.failedRepos > 0) {
        server.log.warn(`Label sync: ${syncResult.failedRepos} repo(s) failed`);
      }
    } catch (error) {
      server.log.warn(
        `Label sync failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Initialize Redis client (shared across services)
  let redisClient: IORedis | null = null;
  try {
    redisClient = new IORedis(config.redis.url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: () => null, // Don't retry — fall back to in-memory
    });
    // Test connection
    await redisClient.ping();
    server.log.info('Redis connected');
  } catch (error) {
    if (isWorkerMode) {
      // Workers MUST have Redis to coordinate with the orchestrator
      throw new Error(
        `Redis connection failed (required in worker mode): ${error instanceof Error ? error.message : String(error)}`
      );
    }
    server.log.warn(
      `Redis connection failed: ${error instanceof Error ? error.message : String(error)}. Phase tracker will operate without deduplication.`
    );
    redisClient = null;
  }

  // Initialize queue adapter: prefer Redis, fall back to in-memory
  let queueAdapter: QueueManager;
  if (redisClient) {
    queueAdapter = new RedisQueueAdapter(redisClient, server.log, {
      maxRetries: config.dispatch.maxRetries,
    });
  } else {
    queueAdapter = new InMemoryQueueAdapter(server.log, {
      maxRetries: config.dispatch.maxRetries,
    });
    server.log.info('Using in-memory queue adapter (Redis unavailable)');
  }

  // Create CLI worker and dispatcher (worker mode only)
  let workerDispatcher: WorkerDispatcher | null = null;
  let workerRelayClient: import('./types/relay.js').ClusterRelayClient | null = null;
  if (isWorkerMode) {
    // Create a lightweight relay client for job event emission (if API key is configured)
    let jobEventEmitter: import('./worker/types.js').JobEventEmitter | undefined;
    if (config.relay.apiKey) {
      try {
        const { ClusterRelayClient: RelayClientImpl } = await import('@generacy-ai/cluster-relay');
        // Cast: package's RelayMessage is a subset of local RelayMessage (lease types not in package yet — follow-up)
        workerRelayClient = new RelayClientImpl({
          apiKey: config.relay.apiKey,
          cloudUrl: config.relay.cloudUrl,
        }) as unknown as import('./types/relay.js').ClusterRelayClient;
        jobEventEmitter = (event: string, data: Record<string, unknown>) => {
          try {
            if (!workerRelayClient?.isConnected) return;
            workerRelayClient.send({
              type: 'event',
              event,
              data,
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            server.log.warn(
              { err: err instanceof Error ? err.message : String(err), event },
              'Failed to emit job event (non-fatal)',
            );
          }
        };
        server.log.info('Worker relay client configured for job event emission');
      } catch (error) {
        server.log.info(
          `Worker relay client not available: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // #892: PhaseTracker instance for the worker's ValidateFixHandler
    // (dedupe on validate-fix:<evidenceHash>). Redis is optional; when
    // absent the worker degrades gracefully to no fix cycle.
    const workerPhaseTracker = new PhaseTrackerService(server.log, redisClient);

    // #942: FailureFingerprintTracker — scans issue failure-alert comments to
    // count prior same-fingerprint failures. Construction is best-effort:
    // if it throws (should never happen for the GitHub-scan impl since it's a
    // pure ctor), we log and pass undefined so escalation degrades to a no-op.
    let workerFailureFingerprintTracker:
      | import('./services/failure-fingerprint-tracker.js').FailureFingerprintTracker
      | undefined;
    try {
      const { GitHubCommentFailureFingerprintTracker } = await import(
        './services/failure-fingerprint-tracker.js'
      );
      const trackerGithub = createGitHubClient();
      workerFailureFingerprintTracker = new GitHubCommentFailureFingerprintTracker(
        trackerGithub,
        server.log,
      );
    } catch (err) {
      server.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to construct FailureFingerprintTracker — repeat-failure escalation disabled',
      );
    }

    const cliWorker = new ClaudeCliWorker(config.worker, server.log, {
      jobEventEmitter,
      tokenProvider: githubTokenProvider,
      phaseTracker: workerPhaseTracker,
      ...(workerFailureFingerprintTracker
        ? { failureFingerprintTracker: workerFailureFingerprintTracker }
        : {}),
    });

    // #889: terminal-failure recovery handler. On WorkerResult.failed-terminal:
    //   (a) best-effort agent:error label add via a fresh LabelManager;
    //   (b) post the stage: 'label-op' failure alert via StageCommentManager.
    // All steps swallowed independently so a downstream failure never releases.
    const terminalFailureHandler = async (
      item: import('./types/index.js').QueueItem,
      failureMetadata: import('./worker/worker-result.js').FailureMetadata,
    ): Promise<void> => {
      const { LabelManager } = await import('./worker/label-manager.js');
      const { StageCommentManager } = await import('./worker/stage-comment-manager.js');
      const github = createGitHubClient();

      try {
        const labelManager = new LabelManager(
          github,
          item.owner,
          item.repo,
          item.issueNumber,
          server.log,
        );
        // Best-effort: fire agent:error via onError('implement') as a stand-in
        // — the site is already in failureMetadata; we're not repeating the
        // phase, just applying agent:error.
        await labelManager.onError('implement');
      } catch (err) {
        server.log.warn(
          { err, owner: item.owner, repo: item.repo, issue: item.issueNumber },
          'Best-effort agent:error label add failed on terminal failure (non-fatal)',
        );
      }

      try {
        const stageCommentManager = new StageCommentManager(
          github,
          item.owner,
          item.repo,
          item.issueNumber,
          server.log,
        );
        const { computeFailureFingerprint } = await import('./worker/failure-fingerprint.js');
        const runId = crypto.randomUUID();
        const evidence = {
          command: `gh (${failureMetadata.labelOp})`,
          exitDescriptor: 'exited 1',
          // #890 renamed CommandExitEvidence.stderrTail → outputTail.
          outputTail: failureMetadata.ghStderr,
        };
        // #942: label-op alerts still get a fingerprint marker so the comment
        // renders consistently. No history lookup — we're outside the phase
        // loop, occurrence is always 1.
        const fingerprint = computeFailureFingerprint({ phase: failureMetadata.site, evidence });
        await stageCommentManager.postFailureAlert({
          stage: 'label-op',
          runId,
          phase: failureMetadata.site,
          labelOp: failureMetadata.labelOp,
          evidence,
          fingerprint,
          occurrence: 1,
        });
      } catch (err) {
        server.log.error(
          {
            err,
            site: failureMetadata.site,
            labelOp: failureMetadata.labelOp,
            ghStderr: failureMetadata.ghStderr,
            owner: item.owner,
            repo: item.repo,
            issue: item.issueNumber,
          },
          'Failed to post label-op failure alert comment',
        );
      }
    };

    workerDispatcher = new WorkerDispatcher(
      queueAdapter,
      redisClient,
      server.log,
      config.dispatch,
      cliWorker.handle.bind(cliWorker),
      undefined,
      terminalFailureHandler,
    );

    // Wire lease manager into dispatcher (if relay client is available)
    if (workerRelayClient) {
      const workerLeaseManager = new LeaseManager(workerRelayClient, server.log, config.lease);
      workerDispatcher.setLeaseManager(workerLeaseManager);
    }
  }

  // Initialize label monitor service (full mode only)
  let labelMonitorService: LabelMonitorService | null = null;
  let prFeedbackMonitorService: PrFeedbackMonitorService | null = null;
  let mergeConflictMonitorService: MergeConflictMonitorService | null = null;
  let clarificationAnswerMonitorService: ClarificationAnswerMonitorService | null = null;
  let baseAdvanceMonitorService: BaseAdvanceMonitorService | null = null;
  let smeeReceiver: SmeeWebhookReceiver | null = null;
  if (!isWorkerMode && config.labelMonitor && config.repositories.length > 0) {
    const phaseTracker = new PhaseTrackerService(server.log, redisClient);

    // When Smee is configured, use its fallback poll interval and disable adaptive polling
    // (Smee provides real-time events, polling is only a safety net)
    const monitorConfig = config.smee.channelUrl
      ? { ...config.monitor, pollIntervalMs: config.smee.fallbackPollIntervalMs, adaptivePolling: false }
      : config.monitor;

    labelMonitorService = new LabelMonitorService(
      server.log,
      createGitHubClient,
      phaseTracker,
      queueAdapter,
      monitorConfig,
      config.repositories,
      clusterGithubUsername,
      githubTokenProvider,
      githubAuthHealth ?? undefined,
      githubAppCredentialId,
      config.smee.channelUrl != null, // #953: webhooksConfigured
    );

    // Wire the smee pipeline (receiver + optional webhook setup) for a resolved URL.
    // Captures labelMonitorService, config, githubTokenProvider, clusterGithubUsername
    // from the enclosing scope. See specs/952-summary-no-automated-cluster/contracts/server-pipeline.md.
    const startSmeePipeline = (channelUrl: string): void => {
      const watchedRepos = new Set(
        config.repositories.map(r => `${r.owner}/${r.repo}`)
      );
      const receiver = new SmeeWebhookReceiver(
        server.log,
        labelMonitorService!,
        { channelUrl, watchedRepos, clusterGithubUsername },
      );
      smeeReceiver = receiver;
      server.log.info({ channelUrl }, 'Smee webhook receiver configured');
      receiver.start().catch((error) => {
        server.log.error({ err: error }, 'Smee webhook receiver failed');
      });
      if (config.webhookSetup.enabled) {
        // #972: DI hooks for fail-loud triple on webhook-registration 403.
        // - sendRelayEvent: mirrors the closure used by PostActivationRetryService
        //   / BootResumeService at the initializeRelayBridge sites; dereferences
        //   relayClientRef at emit time so late relay-client init is tolerated.
        // - statusReporter: exposes the same StatusReporter instance the relay
        //   bridge init returns; wrapped as a thin object so the ref is read
        //   at pushStatus() call time (the 403 fires from a network round-trip,
        //   so the ref is populated by then even on the wizard-mode path).
        // - channelFilePath: same path SmeeChannelResolver writes to.
        // - installationIdProvider: null in v1 — installation id is not stored
        //   in .agency/credentials.yaml (it lives inside the sealed credential
        //   value in credentials.dat). Diagnostic-only per spec, so falling
        //   back to null is safe (data-model.md §"WebhookRegistrationForbiddenEvent").
        const webhookSetupService = new WebhookSetupService(server.log, githubTokenProvider, {
          sendRelayEvent: (channel, payload) => {
            const client = relayClientRef;
            if (!client || !client.isConnected) return;
            client.send({
              type: 'event',
              event: channel,
              data: payload,
              timestamp: new Date().toISOString(),
            } as unknown as import('./types/relay.js').RelayMessage);
          },
          statusReporter: {
            pushStatus: async (status, reason) => {
              const reporter = statusReporterRef;
              if (!reporter) return;
              await reporter.pushStatus(status, reason);
            },
          },
          channelFilePath: config.smee.channelFilePath,
          installationIdProvider: async () => null,
        });
        webhookSetupService.ensureWebhooks(channelUrl, config.repositories).catch((error) => {
          server.log.error({ err: error }, 'Webhook setup failed');
        });
      } else {
        // #954: surface the deliberate webhook-setup opt-out rather than
        // staying silent. Fires whenever a smee pipeline starts (static,
        // persisted, or provisioned channel) while auto-setup is disabled —
        // no GitHub webhooks will be created for the monitored repos.
        server.log.info(
          { remediation: ['GENERACY_WEBHOOK_SETUP_ENABLED', 'orchestrator.webhookSetup.enabled'] },
          'Webhook auto-setup disabled; no GitHub webhooks will be created for monitored repos',
        );
      }
    };

    if (config.smee.channelUrl) {
      // Env/yaml URL path: preserve today's synchronous ordering so `smeeReceiver`
      // is non-null before onReady runs (existing tests rely on this).
      startSmeePipeline(config.smee.channelUrl);
    } else {
      // No URL configured: kick off async resolver after server.listen() via onReady.
      // Fire-and-forget; never blocks listen. Belt-and-braces predicate matches the
      // outer gate so future refactors can't accidentally invoke on worker-mode boot.
      server.addHook('onReady', async () => {
        if (isWorkerMode || !config.labelMonitor || config.repositories.length === 0) return;
        const resolver = new SmeeChannelResolver(server.log, {
          channelFilePath: config.smee.channelFilePath,
        });
        resolver.resolve()
          .then((result) => {
            if (result) {
              server.log.info(
                { channelUrl: result.channelUrl, source: result.source },
                'Resolved smee channel URL — starting pipeline',
              );
              startSmeePipeline(result.channelUrl);
            } else {
              // #954: the cluster is genuinely webhook-less — no static URL,
              // no persisted channel, and provisioning failed — so polling is
              // the only feeder. Emit the polling-fallback summary with the
              // resulting latency characteristics + remediation pointers. This
              // is the true "no smee" moment under the #952 resolver model
              // (not construction time, where a channel may still be resolved).
              server.log.warn(
                {
                  pollIntervalMs: monitorConfig.pollIntervalMs,
                  completedCheckInterval: LabelMonitorService.COMPLETED_CHECK_INTERVAL,
                  processLatencyMs: monitorConfig.pollIntervalMs,
                  completedLatencyMs: monitorConfig.pollIntervalMs * LabelMonitorService.COMPLETED_CHECK_INTERVAL,
                  remediation: ['SMEE_CHANNEL_URL', 'orchestrator.smeeChannelUrl'],
                },
                'No smee channel configured; polling fallback active',
              );
            }
          })
          .catch((error) => {
            server.log.error({ err: error }, 'Unexpected error resolving smee channel URL');
          });
      });
    }

    // Initialize PR feedback monitor service (if enabled). #879: in-flight
    // dedupe via QueueManager.enqueueIfAbsent; no PhaseTracker dependency.
    if (config.prMonitor.enabled) {
      prFeedbackMonitorService = new PrFeedbackMonitorService(
        server.log,
        createGitHubClient,
        queueAdapter,
        config.prMonitor,
        config.repositories,
        clusterGithubUsername,
        githubTokenProvider,
        githubAuthHealth ?? undefined,
        githubAppCredentialId,
        false, // #953: no reliable feeder signal available at construction
      );

      // #898: Merge-conflict monitor reuses the PR-monitor config for poll
      // cadence (same order of magnitude). Enqueues `resolve-merge-conflicts`
      // items when the pause label pair (`waiting-for:merge-conflicts` +
      // `agent:paused`) is detected on an assigned open issue.
      mergeConflictMonitorService = new MergeConflictMonitorService(
        server.log,
        createGitHubClient,
        queueAdapter,
        config.prMonitor,
        config.repositories,
        clusterGithubUsername,
        githubTokenProvider,
        githubAuthHealth ?? undefined,
        githubAppCredentialId,
        false, // #953: recordWebhookEvent() has no callers anywhere
      );

      // #958 T015: Clarification-answer monitor — sibling of merge-conflict
      // monitor. Enqueues `continue` resumes when a plain human comment
      // arrives on a `waiting-for:clarification` + `agent:paused` issue.
      // Never applies `completed:clarification` (FR-011).
      clarificationAnswerMonitorService = new ClarificationAnswerMonitorService(
        server.log,
        createGitHubClient,
        queueAdapter,
        config.prMonitor,
        config.repositories,
        clusterGithubUsername,
        githubTokenProvider,
        githubAuthHealth ?? undefined,
        githubAppCredentialId,
      );
    }

    // #892: Initialize base-advance monitor. Enqueues a resume for any open PR
    // sitting at `failed:validate` whose base branch head SHA has advanced.
    // The resume path clears the failed:validate label and re-runs validate
    // against a fresh merge-preview (stale-evidence recovery). Cadence
    // matches LabelMonitorService.
    baseAdvanceMonitorService = new BaseAdvanceMonitorService(
      server.log,
      createGitHubClient,
      {
        pollIntervalMs: monitorConfig.pollIntervalMs,
        repositories: config.repositories,
        concurrency: monitorConfig.maxConcurrentPolls,
      },
      phaseTracker,
      async (item) => {
        // Wire the resume enqueue. The cockpit-resume handler is a companion
        // issue; for now we enqueue via the same QueueManager surface used
        // by the label-monitor resume path. `command: 'continue'` +
        // `queueReason: 'resume'` follows the existing resume shape, with
        // metadata carrying the base-advance identity so PhaseLoop can gate
        // ValidateFixHandler on it.
        const queueItem = {
          owner: item.owner,
          repo: item.repo,
          issueNumber: item.issueNumber,
          workflowName: 'speckit-feature',
          command: 'continue' as const,
          priority: Date.now(),
          enqueuedAt: new Date().toISOString(),
          metadata: {
            description: `Base advanced to ${item.newSha.slice(0, 12)}; re-validating`,
            resumeReason: item.reason,
            baseSha: item.newSha,
          },
          queueReason: 'resume' as const,
        };
        await queueAdapter.enqueueIfAbsent(queueItem);
      },
      githubTokenProvider,
      githubAuthHealth ?? undefined,
      githubAppCredentialId,
    );
  }

  // Proactive credential expiry watcher (60s timer). Reads .agency/credentials.yaml
  // and asks the auth-health service to request a refresh when <5 min remain.
  // No-op when no credentials.yaml is present (wizard never sealed a credential).
  let credentialExpiryWatcher: CredentialExpiryWatcher | null = null;
  if (!isWorkerMode && githubAuthHealth) {
    credentialExpiryWatcher = new CredentialExpiryWatcher({
      agencyDir,
      health: githubAuthHealth,
      logger: server.log,
    });
  }

  // Initialize relay bridge (full mode only, when API key is configured)
  let relayBridge: RelayBridge | null = null;
  let activationPending = false;

  // Register internal relay events route BEFORE server.listen() (deferred binding pattern).
  // The getter resolves to null until activation completes; the route returns 503 in that window.
  // (`relayClientRef` is declared above so the GitHubAuthHealthService's emit closure can capture it.)
  let relayBridgeRef: RelayBridge | null = null;
  if (!isWorkerMode) {
    const controlPlaneKey = process.env['ORCHESTRATOR_INTERNAL_API_KEY'];
    if (controlPlaneKey) {
      apiKeyStore.addKey(controlPlaneKey, {
        name: 'control-plane-internal',
        scopes: ['admin'],
        createdAt: new Date().toISOString(),
      });
      setupInternalRelayEventsRoute(server, () => relayClientRef);
      setupInternalRefreshMetadataRoute(server, () => relayBridgeRef);
      server.log.info('Control-plane relay event IPC endpoint registered');
    }
  }

  if (!isWorkerMode && !config.relay.apiKey) {
    // Wizard mode: background the activation so server.listen() is not blocked
    activationPending = true;
    activateInBackground(config, server, apiKeyStore, (bridge, convMgr) => {
      relayBridge = bridge;
      relayBridgeRef = bridge;
      conversationManager = convMgr;
      activationPending = false;
    }, (client) => { relayClientRef = client; }, (reporter) => { statusReporterRef = reporter; }).catch((error) => {
      activationPending = false;
      server.log.warn(
        `Cluster activation skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } else if (!isWorkerMode && config.relay.apiKey) {
    // API key already exists: initialize relay bridge synchronously
    const result = await initializeRelayBridge(config, server, apiKeyStore, (client) => { relayClientRef = client; });
    relayBridge = result.relayBridge;
    relayBridgeRef = result.relayBridge;
    statusReporterRef = result.statusReporter;

    // Detect identity split (env GENERACY_CLUSTER_ID vs persisted cluster.json.cluster_id).
    // Best-effort: drops event if relay client unavailable. Once per process lifetime (#750).
    detectIdentitySplit({
      clusterJsonPath: config.activation.clusterJsonPath,
      logger: server.log,
      sendRelayEvent: relayClientRef
        ? (channel, payload) => relayClientRef!.send({
            type: 'event',
            event: channel,
            data: payload,
            timestamp: new Date().toISOString(),
          } as unknown as import('./types/relay.js').RelayMessage)
        : undefined,
    }).catch((err) => {
      server.log.error({ err }, 'Identity-split detection failed (non-fatal)');
    });

    await runPostActivationBranch({
      logger: server.log,
      sendRelayEvent: relayClientRef
        ? (channel, payload) => relayClientRef!.send({
            type: 'event',
            event: channel,
            data: payload,
            timestamp: new Date().toISOString(),
          } as unknown as import('./types/relay.js').RelayMessage)
        : undefined,
    });
  }

  // Initialize ConversationManager (full mode only, when workspaces are configured)
  let conversationManager: ConversationManager | null = null;
  if (!isWorkerMode && Object.keys(config.conversations.workspaces).length > 0) {
    conversationManager = await initializeConversationManager(config, server, relayBridge);
  }

  // Register routes (unless skipped for testing)
  if (!options.skipRoutes) {
    if (isWorkerMode) {
      // Worker mode: minimal routes — health checks and dispatch observability only
      await setupHealthRoutes(server, {
        checks: {
          server: async () => 'ok',
          redis: async () => redisClient ? 'ok' : 'error',
          dispatcher: async () => workerDispatcher ? 'ok' : 'error',
        },
        cluster: {
          id: config.cluster?.id,
          displayName: config.cluster?.displayName,
        },
        githubAuth: () => githubAuthHealth?.snapshot(),
        smeeConfigured: !!config.smee.channelUrl,
      });
      await setupDispatchRoutes(server, queueAdapter);
    } else {
      // Full mode: all routes
      const workflowStore = new InMemoryWorkflowStore();
      const workflowService = new WorkflowService(workflowStore);

      const queueStore = new InMemoryQueueStore();
      const queueService = new QueueService(queueStore);

      const agentRegistry = new AgentRegistry();
      const integrationRegistry = new InMemoryIntegrationRegistry();
      const sessionService = new SessionService({
        workspaces: config.conversations.workspaces,
      });

      await registerRoutes(server, {
        workflowService,
        queueService,
        agentRegistry,
        integrationRegistry,
        sessionService,
        healthCheckOptions: {
          cluster: {
            id: config.cluster?.id,
            displayName: config.cluster?.displayName,
          },
          githubAuth: () => githubAuthHealth?.snapshot(),
          smeeConfigured: !!config.smee.channelUrl,
        },
      });

      // Register webhook routes inside an encapsulated plugin so the custom
      // application/json content-type parser (needed for raw-body signature
      // verification) is scoped to webhook routes only and registered exactly once.
      const hasWebhookRoutes = labelMonitorService || prFeedbackMonitorService;
      if (hasWebhookRoutes) {
        await server.register(async (webhookScope) => {
          // Replace the default JSON parser with one that preserves the raw body
          // for HMAC-SHA256 signature verification.
          webhookScope.removeContentTypeParser('application/json');
          webhookScope.addContentTypeParser(
            'application/json',
            { parseAs: 'string' },
            (_req, body, done) => {
              try {
                const json = JSON.parse(body as string);
                done(null, { parsed: json, raw: body });
              } catch (err) {
                done(err as Error, undefined);
              }
            },
          );

          if (labelMonitorService) {
            const watchedRepos = new Set(
              config.repositories.map(r => `${r.owner}/${r.repo}`)
            );
            await setupWebhookRoutes(webhookScope, {
              monitorService: labelMonitorService,
              webhookSecret: config.monitor.webhookSecret,
              watchedRepos,
              clusterGithubUsername,
            });
          }

          if (prFeedbackMonitorService) {
            const watchedRepos = new Set(
              config.repositories.map(r => `${r.owner}/${r.repo}`)
            );
            await setupPrWebhookRoutes(webhookScope, {
              monitorService: prFeedbackMonitorService,
              webhookSecret: config.prMonitor.webhookSecret,
              watchedRepos,
              clusterGithubUsername,
            });
          }
        });
      }

      // Register conversation routes (if manager is available)
      if (conversationManager) {
        await setupConversationRoutes(server, conversationManager);
      }

      // Register session detail routes (manager is optional — isActive defaults to false without it)
      await setupSessionDetailRoutes(server, conversationManager);

      // Register dispatch queue routes
      await setupDispatchRoutes(server, queueAdapter);

      // Note: SSE routes are registered via registerRoutes() -> setupEventsRoutes()
    }
  }

  // Start services on server ready
  server.addHook('onReady', async () => {
    if (isWorkerMode) {
      // Worker mode: connect relay client (for job events) and start dispatcher
      if (workerRelayClient) {
        workerRelayClient.connect().catch((error) => {
          server.log.warn({ err: error }, 'Worker relay client connection failed (job events disabled)');
        });
      }
      if (workerDispatcher) {
        workerDispatcher.start().catch((error) => {
          server.log.error({ err: error }, 'Worker dispatcher failed');
        });
      }
    } else {
      // Full mode: start monitors, Smee, webhook setup (no dispatcher)
      if (labelMonitorService) {
        labelMonitorService.startPolling().catch((error) => {
          server.log.error({ err: error }, 'Label monitor polling failed');
        });
      }

      if (prFeedbackMonitorService) {
        prFeedbackMonitorService.startPolling().catch((error) => {
          server.log.error({ err: error }, 'PR feedback monitor polling failed');
        });
      }

      if (mergeConflictMonitorService) {
        mergeConflictMonitorService.startPolling().catch((error) => {
          server.log.error({ err: error }, 'Merge-conflict monitor polling failed');
        });
      }

      if (clarificationAnswerMonitorService) {
        clarificationAnswerMonitorService.startPolling().catch((error) => {
          server.log.error({ err: error }, 'Clarification-answer monitor polling failed');
        });
      }

      if (baseAdvanceMonitorService) {
        baseAdvanceMonitorService.startPolling().catch((error) => {
          server.log.error({ err: error }, 'Base-advance monitor polling failed');
        });
      }

      // smeeReceiver.start() and WebhookSetupService.ensureWebhooks() are invoked
      // from startSmeePipeline() at construction time (sync path) or from the
      // resolver's .then() callback (async path); no separate onReady wiring needed.

      if (credentialExpiryWatcher) {
        credentialExpiryWatcher.start();
      }

      // Only start relay bridge here if it was initialized synchronously.
      // The background activation path calls relayBridge.start() itself.
      if (relayBridge && !activationPending) {
        relayBridge.start().catch((error) => {
          server.log.error({ err: error }, 'Relay bridge start failed');
        });
      }
    }
  });

  // Setup graceful shutdown with SSE connection cleanup
  setupGracefulShutdown(server, {
    timeout: Math.max(30000, config.dispatch.shutdownTimeoutMs),
    logger: {
      info: (msg) => server.log.info(msg),
      error: (msg, error) => server.log.error({ err: error }, msg),
    },
    cleanup: [
      async () => {
        if (isWorkerMode) {
          // Worker mode: stop dispatcher and disconnect relay client
          if (workerDispatcher) {
            await workerDispatcher.stop();
          }
          if (workerRelayClient) {
            await workerRelayClient.disconnect();
          }
        } else {
          // Full mode: stop conversations, relay, monitors, Smee, SSE
          if (conversationManager) {
            await conversationManager.stop();
          }
          if (relayBridge) {
            await relayBridge.stop();
          }
          if (smeeReceiver) {
            smeeReceiver.stop();
          }
          if (labelMonitorService) {
            labelMonitorService.stopPolling();
          }
          if (prFeedbackMonitorService) {
            prFeedbackMonitorService.stopPolling();
          }
          if (mergeConflictMonitorService) {
            mergeConflictMonitorService.stopPolling();
          }
          if (clarificationAnswerMonitorService) {
            clarificationAnswerMonitorService.stopPolling();
          }
          if (baseAdvanceMonitorService) {
            await baseAdvanceMonitorService.stopPolling();
          }
          if (credentialExpiryWatcher) {
            await credentialExpiryWatcher.stop();
          }
          closeAllSSEConnections();
        }
        // Close Redis connection (both modes)
        if (redisClient) {
          await redisClient.quit();
        }
      },
    ],
  });

  return server;
}

/**
 * Start the server and begin listening.
 * After listen, waits for the control-plane socket to appear (configurable timeout).
 * On timeout: pushes error status via relay, waits a grace window, then exits.
 */
export async function startServer(server: FastifyInstance): Promise<string> {
  const config = (server as FastifyInstance & { config: OrchestratorConfig }).config;

  const address = await server.listen({
    port: config.server.port,
    host: config.server.host,
  });

  // Control-plane socket-wait (skip in worker mode)
  if (config.mode !== 'worker') {
    const waitTimeoutSec = parseInt(process.env['CONTROL_PLANE_WAIT_TIMEOUT'] ?? '15', 10);
    const graceWindowMs = 30_000;
    let found = false;

    for (let elapsed = 0; elapsed < waitTimeoutSec; elapsed++) {
      found = await probeControlPlaneSocket();
      if (found) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!found) {
      const reason = `control-plane socket did not bind within ${waitTimeoutSec}s`;
      server.log.error(reason);

      // Try to push error status via relay (StatusReporter goes through control-plane
      // which is dead, so push directly via relay event IPC if available)
      try {
        const controlPlaneKey = process.env['ORCHESTRATOR_INTERNAL_API_KEY'];
        if (!controlPlaneKey) {
          // Direct push — relay bridge may be available
          server.log.warn('Cannot push error status: no relay IPC key');
        }
      } catch {
        // Best effort
      }

      // Grace window: let any relay messages drain before exiting
      server.log.error(`Waiting ${graceWindowMs / 1000}s grace window before exit...`);
      await new Promise((r) => setTimeout(r, graceWindowMs));
      process.exit(1);
    }
  }

  return address;
}

/**
 * Create a server for testing
 */
export async function createTestServer(
  configOverrides: Partial<OrchestratorConfig> = {}
): Promise<FastifyInstance> {
  const config = createTestConfig(configOverrides);
  return createServer({ config, skipRoutes: true });
}

/**
 * Create a fully configured server for production
 */
export async function createProductionServer(): Promise<FastifyInstance> {
  const config = loadConfig();
  return createServer({ config });
}

/**
 * Run cluster activation in the background so server.listen() is not blocked.
 * On success, initializes relay bridge, conversation manager, and starts the relay.
 */
async function activateInBackground(
  config: OrchestratorConfig,
  server: FastifyInstance,
  apiKeyStore: InMemoryApiKeyStore,
  onInitialized: (relayBridge: RelayBridge | null, conversationManager: ConversationManager | null) => void,
  setRelayClient?: (client: import('./types/relay.js').ClusterRelayClient) => void,
  setStatusReporter?: (reporter: StatusReporter) => void,
): Promise<void> {
  const initialWorkersRaw = process.env['GENERACY_INITIAL_WORKERS'];
  let initialWorkers: number | undefined;
  if (initialWorkersRaw != null && initialWorkersRaw !== '') {
    const parsed = Number.parseInt(initialWorkersRaw, 10);
    if (Number.isInteger(parsed) && parsed >= 1) {
      initialWorkers = parsed;
    } else {
      server.log.warn(
        `GENERACY_INITIAL_WORKERS="${initialWorkersRaw}" is not a positive integer; ignoring`,
      );
    }
  }

  const activationResult = await activate({
    cloudUrl: config.activation.cloudUrl,
    keyFilePath: config.activation.keyFilePath,
    clusterJsonPath: config.activation.clusterJsonPath,
    logger: server.log as unknown as import('pino').Logger,
    initialWorkers,
  });

  config.relay.apiKey = activationResult.apiKey;
  config.relay.clusterApiKeyId = activationResult.clusterApiKeyId;
  if (activationResult.cloudUrl) {
    config.activation.cloudUrl = activationResult.cloudUrl;
    // Relay-server's auth middleware requires ?projectId=<id> on the upgrade
    // request (see generacy-cloud/services/api/src/middleware/relay-auth.ts).
    // Append it here so the cluster's WS connection isn't rejected with
    // 401 "projectId query parameter required" — without the relay link,
    // the cloud treats the cluster as offline and rejects credential pushes
    // with "Cluster is not connected for this project".
    const relayUrl = activationResult.cloudUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
      .replace(/\/$/, '') + '/relay'
      + `?projectId=${encodeURIComponent(activationResult.projectId)}`;
    config.relay.cloudUrl = relayUrl;
  }
  server.log.info('Cluster activation complete');

  let localRelayClient: import('./types/relay.js').ClusterRelayClient | null = null;
  const { relayBridge, statusReporter } = await initializeRelayBridge(config, server, apiKeyStore, (client) => {
    localRelayClient = client;
    setRelayClient?.(client);
  });
  setStatusReporter?.(statusReporter);
  const conversationManager = await initializeConversationManager(config, server, relayBridge);

  onInitialized(relayBridge, conversationManager);

  // Server is already listening — start relay bridge directly.
  // Fire-and-forget: relayBridge.start() awaits client.connect(), which is a
  // long-lived reconnect loop that only resolves on disconnect. Awaiting it
  // here would strand everything below (identity-split detection, the
  // post-activation dispatch) as unreachable dead code — the bug that made the
  // #834 boot-resume never fire on wizard-provisioned clusters. Mirrors the
  // synchronous existing-key path, which also starts the bridge fire-and-forget.
  if (relayBridge) {
    relayBridge.start().catch((err) => {
      server.log.error({ err }, 'Relay bridge start failed');
    });
  }

  // Detect identity split after relay bridge has started (wizard-mode path, #750).
  // Same call shape as the existing-key path; once-per-process guard lives in the detector.
  detectIdentitySplit({
    clusterJsonPath: config.activation.clusterJsonPath,
    logger: server.log,
    sendRelayEvent: localRelayClient
      ? (channel, payload) => localRelayClient!.send({
          type: 'event',
          event: channel,
          data: payload,
          timestamp: new Date().toISOString(),
        } as unknown as import('./types/relay.js').RelayMessage)
      : undefined,
  }).catch((err) => {
    server.log.error({ err }, 'Identity-split detection failed (non-fatal)');
  });

  await runPostActivationBranch({
    logger: server.log,
    sendRelayEvent: localRelayClient
      ? (channel, payload) => localRelayClient!.send({
          type: 'event',
          event: channel,
          data: payload,
          timestamp: new Date().toISOString(),
        } as unknown as import('./types/relay.js').RelayMessage)
      : undefined,
  });
}

/**
 * Initialize relay bridge and status reporter.
 * Extracted from createServer() for reuse in background activation path.
 */
async function initializeRelayBridge(
  config: OrchestratorConfig,
  server: FastifyInstance,
  apiKeyStore: InMemoryApiKeyStore,
  setRelayClient?: (client: import('./types/relay.js').ClusterRelayClient) => void,
): Promise<{ relayBridge: RelayBridge | null; statusReporter: StatusReporter }> {
  const controlPlaneSocket = process.env['CONTROL_PLANE_SOCKET_PATH'] ?? '/run/generacy-control-plane/control.sock';
  const statusReporter = new StatusReporter({ socketPath: controlPlaneSocket });

  let relayBridge: RelayBridge | null = null;
  if (!config.relay.apiKey) {
    return { relayBridge, statusReporter };
  }
  try {
    const { ClusterRelayClient: RelayClientImpl } = await import('@generacy-ai/cluster-relay');

    const relayInternalKey = crypto.randomUUID();
    apiKeyStore.addKey(relayInternalKey, {
      name: 'relay-internal',
      scopes: ['admin'],
      createdAt: new Date().toISOString(),
    });

    const codeServerSocket = process.env['CODE_SERVER_SOCKET_PATH'] ?? '/run/generacy-control-plane/code-server.sock';

    // Cast: package's RelayMessage is a subset of local RelayMessage (lease types not in package yet — follow-up)
    const relayClient = new RelayClientImpl({
      apiKey: config.relay.apiKey,
      cloudUrl: config.relay.cloudUrl,
      orchestratorUrl: `http://127.0.0.1:${config.server.port}`,
      orchestratorApiKey: relayInternalKey,
      routes: [
        {
          prefix: '/control-plane',
          target: `unix://${controlPlaneSocket}`,
        },
        {
          prefix: '/code-server',
          target: `unix://${codeServerSocket}`,
        },
      ],
    }) as unknown as import('./types/relay.js').ClusterRelayClient;

    // Assign relay client ref for the deferred-binding route registered in createServer()
    if (setRelayClient) {
      setRelayClient(relayClient);
    }

    // Single Docker Engine client shared across all relay-driven Engine paths
    // (worker enumeration in collectMetadata, container lifecycle event
    // subscription in start()). Picks up DOCKER_HOST from env or falls back
    // to /var/run/docker-host.sock.
    const engineClient = new DockerEngineClient();

    relayBridge = new RelayBridge({
      client: relayClient,
      server,
      sseManager: getSSESubscriptionManager(),
      logger: server.log,
      config: config.relay,
      cluster: {
        id: config.cluster?.id,
        displayName: config.cluster?.displayName,
      },
      engineClient,
    });

    const fullModeLeaseManager = new LeaseManager(relayClient, server.log, config.lease);
    relayBridge.setLeaseManager(fullModeLeaseManager);

    const codeServerManager = getCodeServerManager();
    if (codeServerManager) {
      const tunnelHandler = new TunnelHandler(
        { send: (msg: unknown) => relayClient.send(msg as import('./types/relay.js').RelayMessage) },
        codeServerManager,
      );
      relayBridge.setTunnelHandler(tunnelHandler);

      // Push metadata immediately when code-server becomes ready (seconds-latency, not 60s heartbeat)
      const bridge = relayBridge;
      codeServerManager.onStatusChange((status) => {
        if (status === 'running') {
          bridge.sendMetadata();
        }
      });
    }

    relayBridge.setStatusReporter(statusReporter);

    server.log.info('Relay bridge configured');
  } catch (error) {
    server.log.info(
      `Relay bridge not available: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { relayBridge, statusReporter };
}

/**
 * Initialize ConversationManager.
 * Extracted from createServer() for reuse in background activation path.
 */
async function initializeConversationManager(
  config: OrchestratorConfig,
  server: FastifyInstance,
  relayBridge: RelayBridge | null,
): Promise<ConversationManager | null> {
  if (Object.keys(config.conversations.workspaces).length === 0) {
    return null;
  }

  const convSocketPath = process.env['GENERACY_CREDHELPER_SOCKET'] ?? '/run/generacy-credhelper/control.sock';
  const convCredhelperClient = existsSync(convSocketPath)
    ? new CredhelperHttpClient({ socketPath: convSocketPath })
    : undefined;

  const agentLauncher = createAgentLauncher({
    default: defaultProcessFactory,
    interactive: conversationProcessFactory,
  }, convCredhelperClient);
  const conversationSpawner = new ConversationSpawner(
    agentLauncher,
    config.conversations.shutdownGracePeriodMs,
    config.worker.credentialRole,
  );
  const conversationManager = new ConversationManager(
    config.conversations,
    conversationSpawner,
    server.log,
  );

  if (relayBridge) {
    relayBridge.setConversationManager(conversationManager);
  }

  server.log.info(
    { workspaces: Object.keys(config.conversations.workspaces) },
    'Conversation manager configured',
  );

  return conversationManager;
}

// Type augmentation for config access
declare module 'fastify' {
  interface FastifyInstance {
    config: OrchestratorConfig;
  }
}
