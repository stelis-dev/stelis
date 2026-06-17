import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'server/index': 'src/server/index.ts',
  },
  format: ['esm'],
  dts: { resolve: ['@stelis/contracts', '@stelis/core-relay'] },
  clean: false,
  outDir: 'dist',
  target: 'es2022',
  sourcemap: true,
  silent: true,
  treeshake: true,
  noExternal: ['@stelis/contracts', '@stelis/core-relay'],
});
