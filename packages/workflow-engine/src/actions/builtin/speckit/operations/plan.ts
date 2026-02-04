/**
 * Plan operation handler.
 * Uses agent.invoke to generate implementation plan from specification.
 */
import { join } from 'node:path';
import type { ActionContext } from '../../../../types/index.js';
import type { PlanInput, PlanOutput } from '../types.js';
import { executeCommand } from '../../../cli-utils.js';
import { exists, readFile, readDir } from '../lib/fs.js';

/**
 * Build the prompt for plan generation
 */
function buildPlanPrompt(featureDir: string, specContent: string, clarificationsContent?: string): string {
  let prompt = `Generate an implementation plan for this feature specification.

Feature directory: ${featureDir}
Plan file: ${join(featureDir, 'plan.md')}

Specification:
${specContent}

`;

  if (clarificationsContent) {
    prompt += `Clarifications and answers:
${clarificationsContent}

`;
  }

  prompt += `Instructions:
1. Analyze the specification and clarifications
2. Determine the technical approach and architecture
3. Identify required technologies and dependencies
4. Break down the implementation into phases
5. Create supporting artifacts as needed

Generate a comprehensive implementation plan with:
- Summary of the approach
- Technical context (language, framework, dependencies)
- Architecture overview
- Implementation phases
- API contracts (if applicable)
- Data models (if applicable)
- Key technical decisions with rationale
- Risk mitigation strategies

Also create supporting artifacts if needed:
- data-model.md: If there are new entities or schemas
- research.md: If technical decisions need documentation
- contracts/*.yaml: If there are new API endpoints

Write all artifacts directly to the feature directory.`;

  return prompt;
}

/**
 * Extract technologies from plan content
 */
function extractTechnologies(content: string): string[] {
  const technologies: string[] = [];

  // Look for common technology mentions
  const techPatterns = [
    /typescript/gi,
    /javascript/gi,
    /react/gi,
    /node\.?js/gi,
    /postgresql/gi,
    /mongodb/gi,
    /redis/gi,
    /docker/gi,
    /kubernetes/gi,
    /graphql/gi,
    /rest\s*api/gi,
    /vitest/gi,
    /jest/gi,
  ];

  for (const pattern of techPatterns) {
    if (pattern.test(content)) {
      const match = content.match(pattern);
      if (match) {
        const tech = match[0].toLowerCase().replace(/\s+/g, '');
        if (!technologies.includes(tech)) {
          technologies.push(tech);
        }
      }
    }
  }

  // Also look for explicit "Technologies:" section
  const techSection = content.match(/##\s*(?:Technologies?|Tech\s*Stack|Dependencies)\s*\n([\s\S]*?)(?=##|$)/i);
  if (techSection?.[1]) {
    const lines = techSection[1].split('\n');
    for (const line of lines) {
      const itemMatch = line.match(/[-*]\s*(?:\*\*)?([^*:\n]+)/);
      if (itemMatch?.[1]) {
        const tech = itemMatch[1].trim().toLowerCase();
        if (tech.length > 1 && !technologies.includes(tech)) {
          technologies.push(tech);
        }
      }
    }
  }

  return technologies;
}

/**
 * Count phases in plan content
 */
function countPhases(content: string): number {
  const phaseMatches = content.match(/##\s*Phase\s*\d+/gi);
  return phaseMatches ? phaseMatches.length : 0;
}

/**
 * Find artifacts created in feature directory
 */
async function findCreatedArtifacts(featureDir: string): Promise<string[]> {
  const artifacts: string[] = [];
  const expectedFiles = ['data-model.md', 'research.md', 'quickstart.md'];

  for (const file of expectedFiles) {
    const filePath = join(featureDir, file);
    if (await exists(filePath)) {
      artifacts.push(filePath);
    }
  }

  // Check contracts directory
  const contractsDir = join(featureDir, 'contracts');
  if (await exists(contractsDir)) {
    const contracts = await readDir(contractsDir);
    for (const contract of contracts) {
      if (contract.endsWith('.yaml') || contract.endsWith('.yml')) {
        artifacts.push(join(contractsDir, contract));
      }
    }
  }

  return artifacts;
}

/**
 * Execute the plan operation using agent.invoke delegation
 */
export async function executePlan(
  input: PlanInput,
  context: ActionContext
): Promise<PlanOutput> {
  const specFile = join(input.feature_dir, 'spec.md');
  const planFile = join(input.feature_dir, 'plan.md');
  const clarificationsFile = join(input.feature_dir, 'clarifications.md');

  context.logger.info(`Generating implementation plan for: ${input.feature_dir}`);

  // Read the spec file
  if (!(await exists(specFile))) {
    return {
      success: false,
      plan_file: planFile,
      artifacts_created: [],
      technologies: [],
      phases_count: 0,
    };
  }

  let specContent: string;
  try {
    specContent = await readFile(specFile);
  } catch (error) {
    context.logger.error(`Failed to read spec file: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      plan_file: planFile,
      artifacts_created: [],
      technologies: [],
      phases_count: 0,
    };
  }

  // Read clarifications if available
  let clarificationsContent: string | undefined;
  if (await exists(clarificationsFile)) {
    try {
      clarificationsContent = await readFile(clarificationsFile);
    } catch {
      // Ignore read errors
    }
  }

  // Build prompt
  const prompt = buildPlanPrompt(input.feature_dir, specContent, clarificationsContent);

  try {
    // Invoke Claude agent
    const args: string[] = ['-p', prompt, '--output-format', 'json'];
    const timeout = (input.timeout ?? 600) * 1000;

    const result = await executeCommand('claude', args, {
      cwd: input.feature_dir,
      timeout,
      signal: context.signal,
    });

    if (result.exitCode !== 0) {
      return {
        success: false,
        plan_file: planFile,
        artifacts_created: [],
        technologies: [],
        phases_count: 0,
      };
    }

    // Read the generated plan to extract metrics
    let technologies: string[] = [];
    let phasesCount = 0;

    if (await exists(planFile)) {
      try {
        const planContent = await readFile(planFile);
        technologies = extractTechnologies(planContent);
        phasesCount = countPhases(planContent);
      } catch {
        // Ignore read errors
      }
    }

    // Find any additional artifacts created
    const artifactsCreated = await findCreatedArtifacts(input.feature_dir);
    // Filter out the plan file itself
    const additionalArtifacts = artifactsCreated.filter(a => a !== planFile);

    context.logger.info(`Plan generated with ${phasesCount} phases`);
    context.logger.info(`Technologies identified: ${technologies.join(', ') || 'none'}`);
    if (additionalArtifacts.length > 0) {
      context.logger.info(`Additional artifacts created: ${additionalArtifacts.length}`);
    }

    return {
      success: true,
      plan_file: planFile,
      artifacts_created: additionalArtifacts,
      technologies,
      phases_count: phasesCount,
    };
  } catch (error) {
    context.logger.error(`Plan operation failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      success: false,
      plan_file: planFile,
      artifacts_created: [],
      technologies: [],
      phases_count: 0,
    };
  }
}
