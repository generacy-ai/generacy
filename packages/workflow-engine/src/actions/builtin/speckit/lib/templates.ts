/**
 * Template copying library for speckit operations.
 * Ported from speckit MCP server for direct library access.
 */
import { join, dirname } from 'node:path';
import {
  exists,
  mkdir,
  copyFile,
  findRepoRoot,
  resolveTemplatesPath,
} from './fs.js';
import type { CopyTemplateInput, CopyTemplateOutput, TemplateName } from '../types.js';

/**
 * Template configuration
 */
interface Template {
  name: TemplateName;
  sourceFilename: string;
  destFilename: string;
}

/**
 * Template configuration mapping
 */
const TEMPLATES: Record<TemplateName, Template> = {
  spec: {
    name: 'spec',
    sourceFilename: 'spec-template.md',
    destFilename: 'spec.md',
  },
  plan: {
    name: 'plan',
    sourceFilename: 'plan-template.md',
    destFilename: 'plan.md',
  },
  tasks: {
    name: 'tasks',
    sourceFilename: 'tasks-template.md',
    destFilename: 'tasks.md',
  },
  checklist: {
    name: 'checklist',
    sourceFilename: 'checklist-template.md',
    destFilename: 'checklist.md',
  },
  'agent-file': {
    name: 'agent-file',
    sourceFilename: 'agent-file-template.md',
    destFilename: 'CLAUDE.md',
  },
};

/**
 * Get all valid template names
 */
export function getTemplateNames(): TemplateName[] {
  return Object.keys(TEMPLATES) as TemplateName[];
}

/**
 * Check if a string is a valid template name
 */
export function isValidTemplateName(name: string): name is TemplateName {
  return name in TEMPLATES;
}

/**
 * Copy one or more templates to the feature directory.
 * Ported from speckit MCP copy_template tool.
 */
export async function copyTemplates(input: CopyTemplateInput): Promise<CopyTemplateOutput> {
  const workDir = input.cwd || process.cwd();

  // Validate custom filename only with single template
  if (input.dest_filename && input.templates.length > 1) {
    return {
      success: false,
      copied: [],
      errors: [
        {
          template: 'all',
          error: {
            code: 'INVALID_INPUT',
            message: 'dest_filename can only be used when copying a single template',
          },
        },
      ],
    };
  }

  // Find repo root
  const repoRoot = await findRepoRoot(workDir);
  if (!repoRoot) {
    return {
      success: false,
      copied: [],
      errors: [
        {
          template: 'all',
          error: {
            code: 'FEATURE_DIR_NOT_FOUND',
            message: 'Could not find repository root',
          },
        },
      ],
    };
  }

  // Validate feature directory
  if (!input.feature_dir) {
    return {
      success: false,
      copied: [],
      errors: [
        {
          template: 'all',
          error: {
            code: 'FEATURE_DIR_NOT_FOUND',
            message: 'feature_dir is required',
          },
        },
      ],
    };
  }

  // Ensure feature directory exists
  await mkdir(input.feature_dir);

  // Get configured templates path
  const templatesDir = await resolveTemplatesPath(workDir);

  const copied: Array<{ template: string; destPath: string }> = [];
  const errors: Array<{ template: string; error: { code: string; message: string } }> = [];

  for (const templateName of input.templates) {
    if (!isValidTemplateName(templateName)) {
      errors.push({
        template: templateName,
        error: {
          code: 'TEMPLATE_NOT_FOUND',
          message: `Unknown template: ${templateName}. Valid templates: ${getTemplateNames().join(', ')}`,
        },
      });
      continue;
    }

    const template = TEMPLATES[templateName];
    // Use configured templates path if available
    const sourcePath = templatesDir
      ? join(templatesDir, template.sourceFilename)
      : join(repoRoot, '.specify', 'templates', template.sourceFilename);

    // Check if template exists
    if (!(await exists(sourcePath))) {
      errors.push({
        template: templateName,
        error: {
          code: 'TEMPLATE_NOT_FOUND',
          message: `Template file not found: ${sourcePath}`,
        },
      });
      continue;
    }

    // Determine destination path
    let destPath: string;
    if (input.dest_filename && input.templates.length === 1) {
      destPath = join(input.feature_dir, input.dest_filename);
    } else if (templateName === 'checklist') {
      // Checklists go in checklists/ subdirectory
      const checklistsDir = join(input.feature_dir, 'checklists');
      await mkdir(checklistsDir);
      destPath = join(checklistsDir, template.destFilename);
    } else {
      destPath = join(input.feature_dir, template.destFilename);
    }

    try {
      // Ensure parent directory exists
      await mkdir(dirname(destPath));
      await copyFile(sourcePath, destPath);
      copied.push({ template: templateName, destPath });
    } catch (error) {
      errors.push({
        template: templateName,
        error: {
          code: 'FILE_WRITE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  const result: CopyTemplateOutput = {
    success: errors.length === 0,
    copied,
  };

  if (errors.length > 0) {
    result.errors = errors;
  }

  return result;
}
