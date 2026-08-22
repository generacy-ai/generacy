import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // `**/fixtures/**`: synthetic monorepo fixtures (e.g. bugfix-monorepo) ship
    // stub `*.test.ts` files that exist only so the targeted-validate existence
    // filter has real diff paths on disk — they are not real suites and must
    // never be collected.
    exclude: ['**/*.integration.test.ts', '**/fixtures/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/types/**/*.ts'],
    },
    testTimeout: 15000,
  },
});
