import { defineConfig } from 'vitest/config';

// Config for the slow diagnostic probes in sim/ (not part of `npx vitest run`).
//   npx vitest run --config sim/vitest.probe.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['sim/**/*.probe.ts'],
    globals: false,
    silent: false,
  },
});
