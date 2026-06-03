import { describe, it, expect } from 'vitest';
import {
  normalizeClusterName,
  sanitizeProjectComponent,
} from '../name-normalize.js';

const CLUSTER_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const PROJECT_COMPONENT_RE = /^[a-z][a-z0-9-]{0,39}$/;

describe('normalizeClusterName', () => {
  it('passes through valid ASCII slugs unchanged', () => {
    expect(normalizeClusterName('acme-frontend')).toBe('acme-frontend');
  });

  it('lowercases mixed-case input', () => {
    expect(normalizeClusterName('ACME Frontend')).toBe('acme-frontend');
  });

  it('collapses runs of non-[a-z0-9-] to single hyphens', () => {
    expect(normalizeClusterName('  weird___name!!!  ')).toBe('weird-name');
  });

  it('prepends c- for digit-initial inputs', () => {
    expect(normalizeClusterName('123-numeric-start')).toBe('c-123-numeric-start');
  });

  it('returns null for empty input', () => {
    expect(normalizeClusterName('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(normalizeClusterName('   ')).toBeNull();
  });

  it('returns null when input collapses to nothing after trim', () => {
    expect(normalizeClusterName('!!')).toBeNull();
  });

  it('returns null for non-Latin-only input that collapses entirely', () => {
    expect(normalizeClusterName('日本語')).toBeNull();
  });

  it('truncates to 63 chars by default', () => {
    const input = 'a'.repeat(100);
    const out = normalizeClusterName(input);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(63);
  });

  it('truncates with hyphen-trim to avoid trailing hyphens', () => {
    const input = 'a'.repeat(62) + '!!!';
    const out = normalizeClusterName(input);
    expect(out).not.toBeNull();
    expect(out!.endsWith('-')).toBe(false);
  });

  it('honors custom maxLen', () => {
    const out = normalizeClusterName('a'.repeat(50), 20);
    expect(out!.length).toBe(20);
  });

  it('post-condition holds: result matches /^[a-z][a-z0-9-]{0,62}$/', () => {
    const inputs = [
      'ACME Frontend',
      '123abc',
      'mixed_underscores',
      'a',
      'long-name-with-many-segments-and-stuff-here',
    ];
    for (const input of inputs) {
      const out = normalizeClusterName(input);
      if (out !== null) {
        expect(out).toMatch(CLUSTER_NAME_RE);
      }
    }
  });

  it('handles digit-initial truncation: prefix re-truncates within maxLen', () => {
    const input = '1' + 'a'.repeat(100);
    const out = normalizeClusterName(input);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(63);
    expect(out!.startsWith('c-')).toBe(true);
  });
});

describe('sanitizeProjectComponent', () => {
  it('passes through valid ASCII slugs', () => {
    expect(sanitizeProjectComponent('acme-frontend')).toBe('acme-frontend');
  });

  it('strips scoped package prefix', () => {
    expect(sanitizeProjectComponent('@scope/pkg-name')).toBe('scope-pkg-name');
  });

  it('returns "cluster" for empty input', () => {
    expect(sanitizeProjectComponent('')).toBe('cluster');
  });

  it('returns "cluster" for input that collapses to nothing', () => {
    expect(sanitizeProjectComponent('日本語')).toBe('cluster');
  });

  it('truncates to 40 chars by default', () => {
    const out = sanitizeProjectComponent('a'.repeat(100));
    expect(out.length).toBe(40);
  });

  it('post-condition holds: result matches /^[a-z][a-z0-9-]{0,39}$/', () => {
    const inputs = [
      'ACME Frontend',
      '@scope/pkg-name',
      '123abc',
      'very-long-project-name-exceeding-forty-chars-limit',
      '',
      '日本語',
    ];
    for (const input of inputs) {
      const out = sanitizeProjectComponent(input);
      expect(out).toMatch(PROJECT_COMPONENT_RE);
    }
  });

  it('never returns empty', () => {
    expect(sanitizeProjectComponent('!!').length).toBeGreaterThan(0);
  });
});
