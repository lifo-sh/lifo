import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test here boots a real VM in a child process — a few seconds each,
    // and slower on a cold cache.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Sessions are global state (~/.lifo/sessions + host ports), so files must
    // not race each other. Unique ids and ports are still used per test.
    fileParallelism: false,
  },
});
