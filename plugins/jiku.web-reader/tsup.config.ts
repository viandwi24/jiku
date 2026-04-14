import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    WebReaderPanel: 'src/ui/WebReaderPanel.tsx',
  },
  outDir: 'dist/ui',
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@jiku\//, /^@jiku-plugin\//, 'react', 'react-dom', 'react-dom/client'],
  external: [],
  minify: false,
  dts: false,
})
