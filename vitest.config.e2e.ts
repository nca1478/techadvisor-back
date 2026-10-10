import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Serial file execution: every e2e suite shares a single physical Postgres,
    // so parallel files contaminate each other's retrieval corpus (foreign
    // product-less chunks outrank a suite's own evidence) and unanswered-query
    // assertions. Each suite cleans its fixtures in afterAll, which is only
    // reliable when files run one at a time.
    fileParallelism: false,
    globals: true,
    root: './',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.e2e-spec.ts'],
  },
});
