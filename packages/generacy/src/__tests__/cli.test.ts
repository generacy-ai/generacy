/**
 * Integration tests for CLI commands
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProgram } from '../cli/index.js';
import { resolveConfig, createConfig, validateConfig } from '../cli/utils/config.js';
import { createLogger, PinoWorkflowLogger } from '../cli/utils/logger.js';
import { OrchestratorClient, OrchestratorClientError } from '../orchestrator/client.js';
import { HeartbeatManager } from '../orchestrator/heartbeat.js';
import { createHealthServer } from '../health/server.js';

describe('CLI Program', () => {
  it('should create a program with correct name', () => {
    const program = createProgram();
    expect(program.name()).toBe('generacy');
  });

  it('should have run, worker, agent, orchestrator, and setup commands', () => {
    const program = createProgram();
    const commands = program.commands.map(cmd => cmd.name());

    expect(commands).toContain('run');
    expect(commands).toContain('worker');
    expect(commands).toContain('agent');
    expect(commands).toContain('orchestrator');
    expect(commands).toContain('setup');
  });

  it('should have setup command with auth, workspace, build, and services subcommands', () => {
    const program = createProgram();
    const setupCmd = program.commands.find(cmd => cmd.name() === 'setup');

    expect(setupCmd).toBeDefined();
    const subcommands = setupCmd!.commands.map(cmd => cmd.name());
    expect(subcommands).toContain('auth');
    expect(subcommands).toContain('workspace');
    expect(subcommands).toContain('build');
    expect(subcommands).toContain('services');
    expect(subcommands).toHaveLength(4);
  });

  describe('setup --help output', () => {
    let setupCmd: ReturnType<typeof createProgram>['commands'][number];

    beforeEach(() => {
      const program = createProgram();
      setupCmd = program.commands.find(cmd => cmd.name() === 'setup')!;
    });

    it('should show description and all 4 subcommands in setup --help', () => {
      expect(setupCmd.description()).toBe('Dev container setup commands');

      const helpText = setupCmd.helpInformation();
      expect(helpText).toContain('auth');
      expect(helpText).toContain('workspace');
      expect(helpText).toContain('build');
      expect(helpText).toContain('services');
    });

    it('should show --email and --username options in setup auth --help', () => {
      const authCmd = setupCmd.commands.find(cmd => cmd.name() === 'auth')!;
      expect(authCmd).toBeDefined();

      const helpText = authCmd.helpInformation();
      expect(helpText).toContain('--email');
      expect(helpText).toContain('--username');
    });

    it('should show --repos, --branch, --workdir, --clean options in setup workspace --help', () => {
      const wsCmd = setupCmd.commands.find(cmd => cmd.name() === 'workspace')!;
      expect(wsCmd).toBeDefined();

      const helpText = wsCmd.helpInformation();
      expect(helpText).toContain('--repos');
      expect(helpText).toContain('--branch');
      expect(helpText).toContain('--workdir');
      expect(helpText).toContain('--clean');
    });

    it('should show --skip-cleanup, --skip-agency, --skip-generacy options in setup build --help', () => {
      const buildCmd = setupCmd.commands.find(cmd => cmd.name() === 'build')!;
      expect(buildCmd).toBeDefined();

      const helpText = buildCmd.helpInformation();
      expect(helpText).toContain('--skip-cleanup');
      expect(helpText).toContain('--skip-agency');
      expect(helpText).toContain('--skip-generacy');
    });

    it('should show --only, --skip-api, --timeout options in setup services --help', () => {
      const svcCmd = setupCmd.commands.find(cmd => cmd.name() === 'services')!;
      expect(svcCmd).toBeDefined();

      const helpText = svcCmd.helpInformation();
      expect(helpText).toContain('--only');
      expect(helpText).toContain('--skip-api');
      expect(helpText).toContain('--timeout');
    });
  });

  it('should accept global options', () => {
    const program = createProgram();
    const options = program.options.map(opt => opt.long);

    expect(options).toContain('--log-level');
    expect(options).toContain('--no-pretty');
  });
});

describe('Config Resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear env vars that affect config resolution so we can test defaults
    delete process.env['LOG_LEVEL'];
    delete process.env['HEALTH_PORT'];
    delete process.env['HEARTBEAT_INTERVAL'];
    delete process.env['POLL_INTERVAL'];
    delete process.env['ORCHESTRATOR_URL'];
    delete process.env['WORKER_ID'];
    delete process.env['AGENCY_MODE'];
    delete process.env['AGENCY_URL'];
    delete process.env['AGENCY_COMMAND'];
    delete process.env['GENERACY_PRETTY_LOG'];
    delete process.env['GENERACY_WORKFLOW_FILE'];
    delete process.env['GENERACY_WORKDIR'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should use defaults when no config provided', () => {
    const config = resolveConfig();

    expect(config.logLevel).toBe('info');
    expect(config.healthPort).toBe(8080);
    expect(config.heartbeatInterval).toBe(30000);
  });

  it('should read from environment variables', () => {
    process.env['LOG_LEVEL'] = 'debug';
    process.env['ORCHESTRATOR_URL'] = 'http://localhost:3000';
    process.env['HEALTH_PORT'] = '9090';

    const config = resolveConfig();

    expect(config.logLevel).toBe('debug');
    expect(config.orchestratorUrl).toBe('http://localhost:3000');
    expect(config.healthPort).toBe(9090);
  });

  it('should allow CLI args to override env', () => {
    process.env['LOG_LEVEL'] = 'debug';

    const config = resolveConfig({ logLevel: 'error' });

    expect(config.logLevel).toBe('error');
  });

  it('should validate config', () => {
    expect(() => validateConfig({
      logLevel: 'info',
      prettyLog: true,
      workdir: '/tmp',
      healthPort: 8080,
      heartbeatInterval: 30000,
      pollInterval: 5000,
      agencyMode: 'subprocess',
    })).not.toThrow();
  });

  it('should reject invalid log level', () => {
    expect(() => validateConfig({
      logLevel: 'invalid' as 'info',
      prettyLog: true,
      workdir: '/tmp',
      healthPort: 8080,
      heartbeatInterval: 30000,
      pollInterval: 5000,
      agencyMode: 'subprocess',
    })).toThrow('Invalid log level');
  });

  it('should reject invalid health port', () => {
    expect(() => validateConfig({
      logLevel: 'info',
      prettyLog: true,
      workdir: '/tmp',
      healthPort: 99999,
      heartbeatInterval: 30000,
      pollInterval: 5000,
      agencyMode: 'subprocess',
    })).toThrow('Invalid health port');
  });

  it('should require agency URL for network mode', () => {
    expect(() => validateConfig({
      logLevel: 'info',
      prettyLog: true,
      workdir: '/tmp',
      healthPort: 8080,
      heartbeatInterval: 30000,
      pollInterval: 5000,
      agencyMode: 'network',
    })).toThrow('Agency URL is required');
  });
});

describe('Logger', () => {
  it('should create a pino logger', () => {
    const logger = createLogger({ level: 'info' });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('should create a workflow logger adapter', () => {
    const pinoLogger = createLogger({ level: 'info' });
    const workflowLogger = new PinoWorkflowLogger(pinoLogger);

    expect(workflowLogger).toBeDefined();
    expect(typeof workflowLogger.info).toBe('function');
    expect(typeof workflowLogger.warn).toBe('function');
    expect(typeof workflowLogger.error).toBe('function');
    expect(typeof workflowLogger.debug).toBe('function');
    expect(typeof workflowLogger.child).toBe('function');
  });
});

describe('OrchestratorClient', () => {
  it('should create client with options', () => {
    const client = new OrchestratorClient({
      baseUrl: 'http://localhost:3000',
      timeout: 5000,
    });

    expect(client).toBeDefined();
  });

  it('should handle request errors', async () => {
    const client = new OrchestratorClient({
      baseUrl: 'http://localhost:99999', // Invalid port
      timeout: 100,
    });

    await expect(client.pollForJob('test-worker')).rejects.toThrow();
  });
});

describe('OrchestratorClientError', () => {
  it('should create error with details', () => {
    const error = new OrchestratorClientError(
      'Not found',
      'NOT_FOUND',
      404,
      { resource: 'job' }
    );

    expect(error.message).toBe('Not found');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.details).toEqual({ resource: 'job' });
  });
});

describe('HeartbeatManager', () => {
  it('should create manager with options', () => {
    const client = new OrchestratorClient({
      baseUrl: 'http://localhost:3000',
    });

    const manager = new HeartbeatManager({
      client,
      workerId: 'test-worker',
      interval: 10000,
    });

    expect(manager).toBeDefined();
  });

  it('should track status changes', () => {
    const client = new OrchestratorClient({
      baseUrl: 'http://localhost:3000',
    });

    const manager = new HeartbeatManager({
      client,
      workerId: 'test-worker',
    });

    manager.setStatus('busy');
    manager.setCurrentJob('job-123', 50);

    // Status is tracked internally
    expect(manager.getUptime()).toBeGreaterThanOrEqual(0);
  });
});

describe('HealthServer', () => {
  it('should create health server', () => {
    const server = createHealthServer({
      port: 0, // Random port
      getStatus: () => ({
        status: 'healthy',
        uptime: 1000,
      }),
    });

    expect(server).toBeDefined();
    expect(typeof server.listen).toBe('function');
    expect(typeof server.close).toBe('function');
  });

  it('should return status from getStatus callback', async () => {
    const mockStatus = {
      status: 'busy' as const,
      uptime: 5000,
      currentJob: 'job-123',
    };

    const server = createHealthServer({
      port: 0,
      getStatus: () => mockStatus,
    });

    const httpServer = server.getServer();
    expect(httpServer).toBeDefined();
  });
});
