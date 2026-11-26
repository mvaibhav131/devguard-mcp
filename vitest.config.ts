import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The stdio end-to-end test needs a built dist/ and runs via `npm run test:stdio`.
    exclude: [...configDefaults.exclude, 'tests/stdio/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
