/**
 * PromptBuilder class for constructing AI prompts from decision requests.
 * Builds structured system and user prompts for generating baseline recommendations.
 */

import type {
  DecisionRequest,
  BaselineConfig,
  DecisionOption,
  ProjectContext,
  DecisionConstraints,
} from './types.js';
import { DEFAULT_BASELINE_CONFIG } from './types.js';

/**
 * Builds system and user prompts for the AI service from a DecisionRequest.
 * The prompts are designed to generate objective, well-reasoned recommendations
 * based on configurable factors.
 */
export class PromptBuilder {
  private config: BaselineConfig;

  /**
   * Creates a new PromptBuilder instance.
   * @param config - Configuration for the recommendation generator. Defaults to DEFAULT_BASELINE_CONFIG.
   */
  constructor(config: BaselineConfig = DEFAULT_BASELINE_CONFIG) {
    this.config = config;
  }

  /**
   * Updates the configuration used for building prompts.
   * @param config - The new configuration to use.
   */
  setConfig(config: BaselineConfig): void {
    this.config = config;
  }

  /**
   * Builds the system prompt that instructs the AI how to analyze decisions.
   * The prompt explains the AI's role, lists factors to consider, and specifies
   * the expected JSON output format.
   * @returns The system prompt string.
   */
  buildSystemPrompt(): string {
    const enabledFactors = this.getEnabledFactors();
    const factorsList = enabledFactors.length > 0
      ? enabledFactors.map(f => `- ${f}`).join('\n')
      : '- General best practices';

    return `You are an objective technical decision analyzer. Your role is to analyze architectural and technical decisions and provide well-reasoned recommendations based solely on objective criteria and industry best practices.

## Guidelines

1. **Objectivity**: Base your analysis ONLY on objective best practices, technical merits, and the provided context. Do NOT incorporate any human-specific knowledge, personal preferences, or assumptions beyond what is explicitly provided.

2. **Factors to Consider**:
${factorsList}

3. **Analysis Approach**:
   - Evaluate each option against the enabled factors
   - Consider trade-offs and potential risks
   - Account for any constraints provided
   - Provide balanced analysis of alternatives

4. **Confidence Scoring**:
   - 90-100: Clear best choice with strong evidence
   - 70-89: Good choice with moderate confidence
   - 50-69: Reasonable choice but with notable trade-offs
   - Below 50: Uncertain, multiple options are equally viable

## Output Format

You MUST respond with valid JSON in the following structure:

\`\`\`json
{
  "optionId": "string - ID of the recommended option",
  "confidence": "number - Confidence score from 0 to 100",
  "reasoning": ["array of strings - Key reasons supporting the recommendation"],
  "factors": [
    {
      "name": "string - Factor name",
      "value": "string - Assessment of this factor",
      "weight": "number - Weight from 0 to 1",
      "impact": "string - 'supports', 'opposes', or 'neutral'",
      "explanation": "string - How this factor influenced the decision"
    }
  ],
  "alternativeOptionAnalysis": [
    {
      "optionId": "string - ID of the alternative option",
      "whyNotChosen": "string - Explanation of why not recommended",
      "confidenceIfChosen": "number - Confidence if this had been chosen",
      "keyDifferences": ["array of strings - Key differences from recommended option"]
    }
  ]
}
\`\`\`

Ensure your response is ONLY the JSON object with no additional text or markdown formatting outside the JSON.`;
  }

  /**
   * Builds the user prompt containing the specific decision request.
   * Includes the decision description, options, project context, and constraints.
   * @param request - The decision request to build a prompt for.
   * @returns The user prompt string.
   */
  buildUserPrompt(request: DecisionRequest): string {
    const sections: string[] = [];

    // Decision description
    sections.push(`## Decision Request

**Description**: ${request.description}

**Request ID**: ${request.id}`);

    // Options
    sections.push(this.buildOptionsSection(request.options));

    // Project context
    sections.push(this.buildContextSection(request.context));

    // Constraints (if any)
    if (request.constraints) {
      const constraintsSection = this.buildConstraintsSection(request.constraints);
      if (constraintsSection) {
        sections.push(constraintsSection);
      }
    }

    // Request for recommendation
    sections.push(`## Request

Please analyze the above decision and provide a recommendation. Consider all provided options, the project context, and any constraints. Return your analysis as a JSON object with your recommended option, confidence score, reasoning, factor analysis, and alternative option analysis.`);

    return sections.join('\n\n');
  }

  /**
   * Gets the list of enabled factors based on the current configuration.
   * @returns Array of enabled factor descriptions.
   */
  private getEnabledFactors(): string[] {
    const factors: string[] = [];
    const { factors: factorConfig } = this.config;

    if (factorConfig.projectContext) {
      factors.push('Project Context: Consider the project\'s goals, description, and overall context');
    }
    if (factorConfig.domainBestPractices) {
      factors.push('Domain Best Practices: Apply industry standards and best practices for the project\'s domain');
    }
    if (factorConfig.teamSize) {
      factors.push('Team Size: Consider how team size affects implementation complexity and maintainability');
    }
    if (factorConfig.existingStack) {
      factors.push('Existing Technology Stack: Evaluate compatibility with and leverage of existing technologies');
    }

    return factors;
  }

  /**
   * Builds the options section of the user prompt.
   * @param options - The available options for the decision.
   * @returns The formatted options section.
   */
  private buildOptionsSection(options: DecisionOption[]): string {
    const optionDescriptions = options.map((option, index) => {
      const parts: string[] = [
        `### Option ${index + 1}: ${option.name}`,
        `**ID**: ${option.id}`,
        `**Description**: ${option.description}`,
      ];

      if (option.pros && option.pros.length > 0) {
        parts.push(`**Pros**:\n${option.pros.map(p => `- ${p}`).join('\n')}`);
      }

      if (option.cons && option.cons.length > 0) {
        parts.push(`**Cons**:\n${option.cons.map(c => `- ${c}`).join('\n')}`);
      }

      if (option.metadata && Object.keys(option.metadata).length > 0) {
        parts.push(`**Additional Metadata**: ${JSON.stringify(option.metadata)}`);
      }

      return parts.join('\n');
    });

    return `## Available Options\n\n${optionDescriptions.join('\n\n')}`;
  }

  /**
   * Builds the project context section of the user prompt.
   * @param context - The project context.
   * @returns The formatted context section.
   */
  private buildContextSection(context: ProjectContext): string {
    const parts: string[] = [
      '## Project Context',
      `**Project Name**: ${context.name}`,
    ];

    if (context.description) {
      parts.push(`**Project Description**: ${context.description}`);
    }

    if (context.techStack && context.techStack.length > 0) {
      parts.push(`**Technology Stack**: ${context.techStack.join(', ')}`);
    }

    if (context.teamSize !== undefined) {
      parts.push(`**Team Size**: ${context.teamSize} members`);
    }

    if (context.phase) {
      parts.push(`**Project Phase**: ${context.phase}`);
    }

    if (context.domain) {
      parts.push(`**Business Domain**: ${context.domain}`);
    }

    if (context.additionalContext && Object.keys(context.additionalContext).length > 0) {
      const additionalLines = Object.entries(context.additionalContext)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join('\n');
      parts.push(`**Additional Context**:\n${additionalLines}`);
    }

    return parts.join('\n');
  }

  /**
   * Builds the constraints section of the user prompt.
   * @param constraints - The decision constraints.
   * @returns The formatted constraints section, or null if no constraints are present.
   */
  private buildConstraintsSection(constraints: DecisionConstraints): string | null {
    const parts: string[] = ['## Constraints'];
    let hasConstraints = false;

    if (constraints.deadline) {
      const deadlineStr = constraints.deadline instanceof Date
        ? constraints.deadline.toISOString()
        : String(constraints.deadline);
      parts.push(`**Deadline**: ${deadlineStr}`);
      hasConstraints = true;
    }

    if (constraints.budget) {
      parts.push(`**Budget**: ${constraints.budget.amount} ${constraints.budget.currency}`);
      hasConstraints = true;
    }

    if (constraints.requiredFeatures && constraints.requiredFeatures.length > 0) {
      parts.push(`**Required Features**:\n${constraints.requiredFeatures.map(f => `- ${f}`).join('\n')}`);
      hasConstraints = true;
    }

    if (constraints.excludedTechnologies && constraints.excludedTechnologies.length > 0) {
      parts.push(`**Excluded Technologies**:\n${constraints.excludedTechnologies.map(t => `- ${t}`).join('\n')}`);
      hasConstraints = true;
    }

    return hasConstraints ? parts.join('\n') : null;
  }
}
