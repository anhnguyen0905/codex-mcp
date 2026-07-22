import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Windows CI runners spawn git/node subprocesses slowly under load; the
    // 5000ms default flakes on subprocess-heavy tests. 15s gives headroom.
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/liveView.ts'],
      // Thresholds sit ~3-9 points below current actuals (stmts 93.36, branch 81.94,
      // funcs 98.88, lines 95.43) so they gate regressions without flaking on noise.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 78,
        statements: 90,
      },
    },
  },
})
