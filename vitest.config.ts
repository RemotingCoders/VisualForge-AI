import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest owns tests/**/*.test.ts only — e2e/*.spec.ts belongs to Playwright (playwright.config.ts).
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }, // "@" -> src (same as tsconfig paths)
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
