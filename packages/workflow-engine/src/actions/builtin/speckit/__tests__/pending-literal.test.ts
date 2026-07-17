import { describe, it, expect } from 'vitest';
import {
  PENDING_ANSWER_LITERAL,
  isPendingAnswerValue,
} from '../pending-literal.js';

describe('PENDING_ANSWER_LITERAL', () => {
  it('is the literal *Pending* (asterisks preserved)', () => {
    expect(PENDING_ANSWER_LITERAL).toBe('*Pending*');
  });
});

describe('isPendingAnswerValue — data-model.md invariants', () => {
  it.each<[string, boolean, string]>([
    ['', true, 'empty string'],
    ['   ', true, 'whitespace-only'],
    ['*Pending*', true, 'exact literal match'],
    ['[Leave empty for now]', true, 'legacy bracketed placeholder'],
    ['[TBD]', true, 'bracketed TBD'],
    ['[foo] bar', false, 'bracketed prefix + trailing text is a real answer'],
    ['A', false, 'bare letter answer'],
    ['Some prose answer here.', false, 'prose'],
  ])('isPendingAnswerValue(%p) === %p (%s)', (input, expected) => {
    expect(isPendingAnswerValue(input)).toBe(expected);
  });

  it('accepts empty brackets `[]` as pending (shape-based)', () => {
    expect(isPendingAnswerValue('[]')).toBe(true);
  });

  it('accepts [TODO] as pending', () => {
    expect(isPendingAnswerValue('[TODO]')).toBe(true);
  });

  it('is case-sensitive on the exact *Pending* literal', () => {
    expect(isPendingAnswerValue('*pending*')).toBe(false);
    expect(isPendingAnswerValue('*PENDING*')).toBe(false);
  });

  it('treats multiple bracket groups as a real answer (deliberately)', () => {
    expect(isPendingAnswerValue('[a][b]')).toBe(false);
  });
});
