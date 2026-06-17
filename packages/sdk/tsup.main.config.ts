import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  dts: { resolve: ['@stelis/contracts', '@stelis/core-relay'] },
  clean: true,
  outDir: 'dist',
  target: 'es2022',
  sourcemap: true,
  silent: true,
  treeshake: true,
  noExternal: ['@stelis/contracts', '@stelis/core-relay'],
});
