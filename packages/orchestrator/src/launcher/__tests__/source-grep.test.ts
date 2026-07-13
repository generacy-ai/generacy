import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LAUNCHER_DIR = resolve(__dirname, '..');

describe('launcher source-grep invariants', () => {
  it('types.ts contains no reference to generacy-plugin-claude-code', () => {
    const source = readFileSync(resolve(LAUNCHER_DIR, 'types.ts'), 'utf8');
    expect(source.includes('generacy-plugin-claude-code')).toBe(false);
  });

  it('index.ts does not re-export SYSTEM_PROVIDER or DEFAULT_PROVIDER', () => {
    const source = readFileSync(resolve(LAUNCHER_DIR, 'index.ts'), 'utf8');
    expect(source.includes('SYSTEM_PROVIDER')).toBe(false);
    expect(source.includes('DEFAULT_PROVIDER')).toBe(false);
  });
});
