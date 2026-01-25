/**
 * Run command implementation.
 * Loads and executes a workflow from a file.
 */
import { Command } from 'commander';
import { resolve } from 'node:path';
import {
  loadWorkflow,
  prepareWorkflow,
  WorkflowExecutor,
  registerBuiltinActions,
  type ExecutionResult,
  type ExecutionEventListener,
} from '@generacy-ai/workflow-engine';
import { getLogger, createWorkflowLogger } from '../utils/logger.js';

/**
 * Parse input arguments in key=value format
 */
function parseInputs(inputs: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const input of inputs) {
    const eqIndex = input.indexOf('=');
    if (eqIndex === -1) {
      throw new Error(`Invalid input format: ${input}. Expected key=value`);
    }

    const key = input.substring(0, eqIndex);
    const value = input.substring(eqIndex + 1);

    // Try to parse as JSON, otherwise use as string
    try {
      result[key] = JSON.parse(value);
    } catch {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Create the run command
 */
export function runCommand(): Command {
  const command = new Command('run');

  command
    .description('Execute a workflow from a file')
    .argument('<workflow>', 'Path to workflow YAML file')
    .option('-i, --input <key=value...>', 'Input values for the workflow', [])
    .option('-w, --workdir <path>', 'Working directory for execution', process.cwd())
    .option('--dry-run', 'Validate workflow without executing')
    .option('--single-step <name>', 'Execute only a single step by name')
    .option('-v, --verbose', 'Enable verbose output')
    .action(async (workflowPath: string, options) => {
      const logger = getLogger();
      const workflowLogger = createWorkflowLogger(logger);

      try {
        // Resolve workflow path
        const resolvedPath = resolve(options['workdir'], workflowPath);
        logger.info({ path: resolvedPath }, 'Loading workflow');

        // Load and validate workflow
        const definition = await loadWorkflow(resolvedPath);
        logger.info({ name: definition.name }, 'Workflow loaded');

        // Prepare workflow for execution
        const workflow = prepareWorkflow(definition);

        // Parse inputs
        const inputs = parseInputs(options['input'] || []);
        if (Object.keys(inputs).length > 0) {
          logger.info({ inputs: Object.keys(inputs) }, 'Parsed inputs');
        }

        // Register builtin actions
        registerBuiltinActions();

        // Create executor
        const executor = new WorkflowExecutor({
          logger: workflowLogger,
        });

        // Set up event listener for progress
        const eventListener: ExecutionEventListener = (event) => {
          if (options['verbose']) {
            logger.debug({ event }, 'Execution event');
          }

          switch (event.type) {
            case 'workflow:start':
              logger.info({ workflow: event.workflowName }, 'Starting workflow');
              break;
            case 'phase:start':
              logger.info({ phase: event.phaseName }, 'Starting phase');
              break;
            case 'step:start':
              logger.info({ step: event.stepName }, 'Starting step');
              break;
            case 'step:complete':
              logger.info({ step: event.stepName }, 'Step completed');
              break;
            case 'step:error':
              logger.error({ step: event.stepName, error: event.message }, 'Step failed');
              break;
            case 'phase:complete':
              logger.info({ phase: event.phaseName }, 'Phase completed');
              break;
            case 'workflow:complete':
              logger.info({ workflow: event.workflowName }, 'Workflow completed');
              break;
            case 'workflow:error':
              logger.error({ workflow: event.workflowName, error: event.message }, 'Workflow failed');
              break;
          }
        };

        executor.addEventListener(eventListener);

        let result: ExecutionResult;

        if (options['dryRun']) {
          // Validate only
          logger.info('Running in dry-run mode (validation only)');
          result = await executor.validate(workflow, {
            workdir: options['workdir'],
            env: process.env as Record<string, string>,
          }, inputs);
        } else if (options['singleStep']) {
          // Execute single step
          const stepName = options['singleStep'];
          logger.info({ step: stepName }, 'Executing single step');

          const singleResult = await executor.executeSingleStep(workflow, {
            workdir: options['workdir'],
            env: process.env as Record<string, string>,
          }, {
            stepName,
            inputs,
          });

          // Convert single step result to execution result format
          result = {
            status: singleResult.status,
            startTime: singleResult.startTime,
            endTime: singleResult.endTime,
            duration: singleResult.duration,
            phases: [],
            outputs: singleResult.outputs,
            error: singleResult.error,
          };

          if (singleResult.result) {
            result.phases.push({
              name: singleResult.phaseName,
              status: singleResult.status,
              startTime: singleResult.startTime,
              endTime: singleResult.endTime,
              duration: singleResult.duration,
              steps: [singleResult.result],
            });
          }
        } else {
          // Full execution
          result = await executor.execute(workflow, {
            workdir: options['workdir'],
            env: process.env as Record<string, string>,
          }, inputs);
        }

        // Clean up listener
        executor.removeEventListener(eventListener);

        // Display results
        displayResult(result, logger);

        // Exit with appropriate code
        if (result.status === 'failed' || result.status === 'cancelled') {
          process.exit(1);
        }
      } catch (error) {
        logger.error({ error }, 'Failed to execute workflow');
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        }
        process.exit(1);
      }
    });

  return command;
}

/**
 * Display execution result summary
 */
function displayResult(result: ExecutionResult, logger: ReturnType<typeof getLogger>): void {
  const durationSec = (result.duration / 1000).toFixed(2);

  console.log('\n' + '='.repeat(60));
  console.log('EXECUTION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Status: ${result.status.toUpperCase()}`);
  console.log(`Duration: ${durationSec}s`);

  if (result.phases.length > 0) {
    console.log('\nPhases:');
    for (const phase of result.phases) {
      const phaseIcon = phase.status === 'completed' ? '✓' : phase.status === 'failed' ? '✗' : '○';
      console.log(`  ${phaseIcon} ${phase.name} (${phase.steps.length} steps)`);

      for (const step of phase.steps) {
        const stepIcon = step.status === 'completed' ? '✓' : step.status === 'failed' ? '✗' : '○';
        const stepDuration = step.duration ? ` (${(step.duration / 1000).toFixed(2)}s)` : '';
        console.log(`    ${stepIcon} ${step.name}${stepDuration}`);
      }
    }
  }

  if (result.outputs && Object.keys(result.outputs).length > 0) {
    console.log('\nOutputs:');
    for (const [key, value] of Object.entries(result.outputs)) {
      const displayValue = typeof value === 'string' ? value : JSON.stringify(value);
      console.log(`  ${key}: ${displayValue.substring(0, 100)}${displayValue.length > 100 ? '...' : ''}`);
    }
  }

  if (result.error) {
    console.log(`\nError: ${result.error}`);
  }

  console.log('='.repeat(60) + '\n');
}
