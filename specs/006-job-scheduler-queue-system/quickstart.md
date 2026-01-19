# Quickstart: Job Scheduler and Queue System

## Installation

The job scheduler is part of the generacy package. No additional installation required.

```bash
npm install  # Installs all dependencies including ioredis
```

## Basic Usage

### Creating a Scheduler

```typescript
import { JobScheduler, createSchedulerConfig } from 'generacy';

// In-memory backend (development/testing)
const scheduler = new JobScheduler(createSchedulerConfig({
  backend: 'memory',
}));

// Redis backend (production)
const scheduler = new JobScheduler(createSchedulerConfig({
  backend: 'redis',
  redis: {
    host: 'localhost',
    port: 6379,
  },
}));

await scheduler.start();
```

### Enqueueing Jobs

```typescript
// Basic job
const jobId = await scheduler.enqueue({
  workflowId: 'workflow-123',
  stepId: 'step-1',
  type: 'agent',
  payload: { prompt: 'Analyze this data...' },
});

// High priority job
const urgentJobId = await scheduler.enqueue({
  workflowId: 'workflow-456',
  stepId: 'step-urgent',
  type: 'agent',
  priority: 'high',
  payload: { prompt: 'Critical decision needed' },
});

// Custom retry settings
const customJobId = await scheduler.enqueue({
  workflowId: 'workflow-789',
  stepId: 'step-3',
  type: 'integration',
  payload: { api: 'external-service', data: {...} },
  maxAttempts: 5,
});
```

### Processing Jobs

```typescript
// Define a processor function
const processor = async (job) => {
  console.log(`Processing job ${job.id}`);

  // Do work based on job type
  switch (job.type) {
    case 'agent':
      return await invokeAgent(job.payload);
    case 'integration':
      return await callExternalAPI(job.payload);
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
};

// Start processing
scheduler.process(processor);

// Pause/resume processing
scheduler.pause();
scheduler.resume();
```

### Monitoring Jobs

```typescript
// Get job status
const job = await scheduler.getJob(jobId);
console.log(job.status);  // 'pending', 'processing', 'completed', 'failed', 'dead'

// Subscribe to events
scheduler.on('job:completed', (job, result) => {
  console.log(`Job ${job.id} completed with result:`, result);
});

scheduler.on('job:failed', (job, error) => {
  console.log(`Job ${job.id} failed:`, error.message);
});

scheduler.on('job:dead', (job) => {
  console.log(`Job ${job.id} moved to dead letter queue`);
});

// Get metrics
scheduler.on('metrics:snapshot', (metrics) => {
  console.log('Queue depth:', metrics.queueDepth.total);
  console.log('Processing:', metrics.processing);
  console.log('Avg time:', metrics.avgProcessingTimeMs, 'ms');
});
```

### Dead Letter Queue

```typescript
// List dead letter jobs
const deadJobs = await scheduler.getDeadLetterQueue();

for (const job of deadJobs) {
  console.log(`Dead job: ${job.id}, error: ${job.error}`);
}

// Retry a dead job
await scheduler.retryDeadLetter(deadJobs[0].id);
```

### Health Check

```typescript
const health = await scheduler.healthCheck();
if (!health.healthy) {
  console.error('Scheduler unhealthy:', health.details?.lastError);
}
```

## Configuration Options

```typescript
interface SchedulerConfig {
  // Backend selection
  backend: 'redis' | 'memory';

  // Redis settings (required for redis backend)
  redis?: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };

  // Retry settings
  retry?: {
    maxAttempts?: number;       // Default: 3
    initialDelay?: number;      // Default: 1000ms
    maxDelay?: number;          // Default: 30000ms
    backoffFactor?: number;     // Default: 2
  };

  // Concurrency settings
  concurrency?: {
    maxGlobalWorkers?: number;  // Default: 10
    maxPerWorkflow?: number;    // Default: unlimited
    maxPerJobType?: {
      agent?: number;
      human?: number;
      integration?: number;
    };
  };

  // Metrics settings
  metricsIntervalMs?: number;   // Default: 60000, 0 to disable

  // Visibility timeout
  defaultVisibilityTimeout?: number;  // Default: 30000ms
}
```

## Common Patterns

### Workflow Integration

```typescript
// In workflow engine
async function executeWorkflowStep(workflow, step) {
  const jobId = await scheduler.enqueue({
    workflowId: workflow.id,
    stepId: step.id,
    type: step.type,
    priority: urgencyToPriority(step.urgency),
    payload: step.input,
  });

  return jobId;
}

function urgencyToPriority(urgency) {
  switch (urgency) {
    case 'blocking_now': return 'high';
    case 'blocking_soon': return 'normal';
    case 'when_available': return 'low';
  }
}
```

### Custom Metrics Adapter

```typescript
// Prometheus adapter example
scheduler.on('metrics:snapshot', (metrics) => {
  queueDepthGauge.set({ priority: 'high' }, metrics.queueDepth.high);
  queueDepthGauge.set({ priority: 'normal' }, metrics.queueDepth.normal);
  queueDepthGauge.set({ priority: 'low' }, metrics.queueDepth.low);
  processingGauge.set(metrics.processing);
  completedCounter.inc(metrics.completedLastMinute);
  failedCounter.inc(metrics.failedLastMinute);
});
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  console.log('Shutting down scheduler...');
  scheduler.pause();  // Stop accepting new jobs

  // Wait for in-progress jobs to complete (with timeout)
  await scheduler.drain(30000);

  await scheduler.stop();
  process.exit(0);
});
```

## Troubleshooting

### Jobs not processing

1. Ensure `scheduler.process()` is called with a processor function
2. Check if scheduler is paused: `scheduler.isPaused()`
3. Verify backend connection: `await scheduler.healthCheck()`

### Jobs stuck in processing

Jobs have a visibility timeout (default 30s). If processor crashes:
- Jobs automatically return to queue after timeout
- Check `visibilityTimeout` setting if jobs take longer

### Redis connection issues

```typescript
// Check connection
const health = await scheduler.healthCheck();
console.log(health.details);

// Reconnection is automatic, but you can force:
await scheduler.stop();
await scheduler.start();
```

### High dead letter queue

1. Check error patterns: `(await scheduler.getDeadLetterQueue()).map(j => j.error)`
2. Increase `maxAttempts` if failures are transient
3. Review processor error handling
