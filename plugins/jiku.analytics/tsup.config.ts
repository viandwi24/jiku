import { defineConfig } from 'tsup'

// Plugin UI bundle — fully self-contained ESM.
// React + ReactDOM + @jiku/kit/ui are bundled so this plugin runs with its
// OWN React instance, isolated from Studio's. No bare specifiers end up in
// the output — the browser just needs to execute the file.
export default defineConfig({
  entry: {
    Dashboard: 'src/ui/Dashboard.tsx',
    Settings: 'src/ui/Settings.tsx',
  },
  outDir: 'dist/ui',
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  splitting: false,
  sourcemap: true,
  clean: true,
  // Force bundling of workspace deps + React. Without this, tsup keeps them
  // as `import from '@jiku/kit/ui'` bare specifiers which the browser can't
  // resolve at runtime.
  noExternal: [/^@jiku\//, /^@jiku-plugin\//, 'react', 'react-dom', 'react-dom/client'],
  external: [],
  minify: false,
  dts: false,
})
