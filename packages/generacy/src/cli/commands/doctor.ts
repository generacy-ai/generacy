/**
 * Doctor command definition.
 * Validates the full development environment setup by running a series of
 * categorized health checks with color-coded pass/fail/warning output and
 * actionable fix suggestions.
 */
import { Command } from 'commander';
import { CheckRegistry, runChecks, formatText, formatJson } from './doctor/index.js';
import type { DoctorOptions } from './doctor/index.js';

// Individual checks
import { dockerCheck } from './doctor/checks/docker.js';
import { configCheck } from './doctor/checks/config.js';
import { envFileCheck } from './doctor/checks/env-file.js';
import { devcontainerCheck } from './doctor/checks/devcontainer.js';
import { githubTokenCheck } from './doctor/checks/github-token.js';
import { anthropicKeyCheck } from './doctor/checks/anthropic-key.js';
import { npmPackagesCheck } from './doctor/checks/npm-packages.js';
import { agencyMcpCheck } from './doctor/checks/agency-mcp.js';

/**
 * Create and configure a registry with all built-in checks.
 */
function createDefaultRegistry(): CheckRegistry {
  const registry = new CheckRegistry();

  // System checks
  registry.register(dockerCheck);
  registry.register(devcontainerCheck);

  // Config checks
  registry.register(configCheck);
  registry.register(envFileCheck);

  // Credential checks
  registry.register(githubTokenCheck);
  registry.register(anthropicKeyCheck);

  // Package checks
  registry.register(npmPackagesCheck);

  // Service checks
  registry.register(agencyMcpCheck);

  return registry;
}

/**
 * Create the doctor command.
 */
export function doctorCommand(): Command {
  const command = new Command('doctor');

  command
    .description('Validate the full development environment setup')
    .option('--check <name...>', 'Run only specific checks (and their dependencies)')
    .option('--skip <name...>', 'Skip specific checks')
    .option('-j, --json', 'Output results as JSON')
    .option('-v, --verbose', 'Show detailed diagnostic information')
    .option('-f, --fix', 'Attempt to fix detected issues (where possible)')
    .action(async (options: {
      check?: string[];
      skip?: string[];
      json?: boolean;
      verbose?: boolean;
      fix?: boolean;
    }) => {
      const doctorOptions: DoctorOptions = {
        check: options.check,
        skip: options.skip,
        json: options.json,
        verbose: options.verbose,
        fix: options.fix,
      };

      try {
        // Build registry and resolve checks
        const registry = createDefaultRegistry();
        const checks = registry.resolve({
          check: doctorOptions.check,
          skip: doctorOptions.skip,
        });

        if (doctorOptions.fix) {
          console.error('Note: Auto-fix is not yet implemented. Running checks only.');
        }

        // Execute checks
        const report = await runChecks(checks, doctorOptions);

        // Format and output
        if (doctorOptions.json) {
          console.log(formatJson(report));
        } else {
          console.log(formatText(report, checks, doctorOptions.verbose ?? false));
        }

        process.exit(report.exitCode);
      } catch (error) {
        // Internal errors (e.g., invalid --check/--skip names, circular deps)
        if (doctorOptions.json) {
          console.log(JSON.stringify({
            version: 1,
            timestamp: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
            exitCode: 2,
          }, null, 2));
        } else {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        process.exit(2);
      }
    });

  return command;
}
