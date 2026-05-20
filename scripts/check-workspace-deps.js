import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const depFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const violations = [];

for (const field of depFields) {
  const deps = pkg[field];
  if (!deps) continue;
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      violations.push(`  ${field}.${name}: ${version}`);
    }
  }
}

if (violations.length > 0) {
  console.error('ERROR: Found workspace: protocol in package.json');
  console.error('These should have been rewritten by pnpm before publish:\n');
  violations.forEach(v => console.error(v));
  console.error('\nThis usually means publish was not run from the workspace root.');
  process.exit(1);
}
