import { defineConfig } from 'tsdown'

// lib/client.js is vendored by scripts/sync-client.mjs before this runs, so clean stays off.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
