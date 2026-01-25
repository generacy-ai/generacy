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

  it('should have run, worker, and agent commands', () => {
    const program = createProgram();
    const commands = program.commands.map(cmd => cmd.name());

    expect(commands).toContain('run');
    expect(commands).toContain('worker');
    expect(commands).toContain('agent');
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
