/**
 * Tests for SpecKitAction dispatch logic
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpecKitAction } from '../../../src/actions/builtin/speckit/index.js';
import { parseActionType } from '../../../src/types/action.js';
import type { StepDefinition } from '../../../src/types/index.js';

describe('SpecKitAction', () => {
  let action: SpecKitAction;

  beforeEach(() => {
    action = new SpecKitAction();
  });

  describe('canHandle', () => {
    it('should return true for speckit.* action in uses field', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'speckit.create_feature',
      };
      expect(action.canHandle(step)).toBe(true);
    });

    it('should return true for speckit/* action in uses field', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'speckit/specify',
      };
      expect(action.canHandle(step)).toBe(true);
    });

    it('should return true for speckit.* action in action field', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'speckit.plan',
      };
      expect(action.canHandle(step)).toBe(true);
    });

    it('should return false for non-speckit actions', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'agent.invoke',
      };
      expect(action.canHandle(step)).toBe(false);
    });

    it('should return false for shell action', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        command: 'echo test',
      };
      expect(action.canHandle(step)).toBe(false);
    });
  });

  describe('parseActionType', () => {
    it('should parse speckit.create_feature as speckit', () => {
      const step: StepDefinition = {
        name: 'test',
        action: 'shell',
        uses: 'speckit.create_feature',
      };
      expect(parseActionType(step)).toBe('speckit');
    });

    it('should parse speckit/specify as speckit', () => {
      const step: StepDefinition = {
        name: 'test',
        action: 'shell',
        uses: 'speckit/specify',
      };
      expect(parseActionType(step)).toBe('speckit');
    });

    it('should parse speckit.plan in action field as speckit', () => {
      const step: StepDefinition = {
        name: 'test',
        action: 'speckit.plan',
      };
      expect(parseActionType(step)).toBe('speckit');
    });

    it('should parse speckit/tasks in action field as speckit', () => {
      const step: StepDefinition = {
        name: 'test',
        action: 'speckit/tasks',
      };
      expect(parseActionType(step)).toBe('speckit');
    });
  });

  describe('validate', () => {
    it('should fail validation without operation', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'speckit',
        uses: 'speckit',
      };
      const result = action.validate(step);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('MISSING_OPERATION');
    });

    it('should fail validation for unknown operation', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'speckit.unknown_op',
      };
      const result = action.validate(step);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('INVALID_OPERATION');
    });

    it('should fail validation for create_feature without description', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'speckit.create_feature',
        with: {},
      };
      const result = action.validate(step);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('MISSING_DESCRIPTION');
    });

    it('should pass validation for create_feature with description', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'speckit.create_feature',
        with: {
          description: 'Test feature',
        },
      };
      const result = action.validate(step);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail validation for specify without feature_dir', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'speckit.specify',
        with: {},
      };
      const result = action.validate(step);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('MISSING_FEATURE_DIR');
    });

    it('should pass validation for get_paths (no required inputs)', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'speckit.get_paths',
      };
      const result = action.validate(step);
      expect(result.valid).toBe(true);
    });

    it('should pass validation for check_prereqs (no required inputs)', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'speckit.check_prereqs',
      };
      const result = action.validate(step);
      expect(result.valid).toBe(true);
    });

    it('should fail validation for copy_template without templates', () => {
      const step: StepDefinition = {
        name: 'test-step',
        action: 'shell',
        uses: 'speckit.copy_template',
        with: {},
      };
      const result = action.validate(step);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('MISSING_TEMPLATES');
    });
  });

  describe('extractOperation', () => {
    it('should extract operation from speckit.create_feature', () => {
      const step: StepDefinition = {
        name: 'test',
        action: 'shell',
        uses: 'speckit.create_feature',
      };
      // Use the internal method via reflection or test indirectly via validate
      const result = action.validate(step);
      // If it doesn't fail with INVALID_OPERATION, we know the operation was extracted
      expect(result.errors.some(e => e.code === 'INVALID_OPERATION')).toBe(false);
    });

    it('should extract operation from speckit/specify', () => {
      const step: StepDefinition = {
        name: 'test',
        action: 'shell',
        uses: 'speckit/specify',
        with: { feature_dir: '/test' },
      };
      const result = action.validate(step);
      expect(result.valid).toBe(true);
    });

    it('should handle all valid operations', () => {
      const operations = [
        'create_feature',
        'get_paths',
        'check_prereqs',
        'copy_template',
        'specify',
        'clarify',
        'plan',
        'tasks',
        'implement',
      ];

      for (const op of operations) {
        const step: StepDefinition = {
          name: 'test',
          action: 'shell',
          uses: `speckit.${op}`,
          with: {
            // Add required fields for validation
            description: 'test',
            feature_dir: '/test',
            templates: ['spec'],
          },
        };
        const result = action.validate(step);
        expect(result.errors.some(e => e.code === 'INVALID_OPERATION')).toBe(false);
      }
    });
  });
});
