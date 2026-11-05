import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'

// `?raw` imports a file as its text, exactly like the prototype's client build
// (client.css); tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = {
  name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const } : undefined,
}

export default defineConfig([
  // Host half: node ESM with declarations.
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: false,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  // Client half: browser CJS wrapped in the ModuleLoader banner, react kept external.
  // The banner id is this plugin's ModuleLoader registration id — keep in sync
  // with package.json dsh.client and the sidebar/panel keys in src/client.tsx.
  {
    entry: { client: 'src/client.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    plugins: [raw],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent-console", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
