import { defineConfig } from 'vitest/config';

// Vitest owns tests/**/*.test.ts only — e2e/*.spec.ts belongs to Playwright (playwright.config.ts).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
