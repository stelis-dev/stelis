import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiUrl = (env.VITE_STELIS_API_URL || '').trim();
  if (!apiUrl) {
    throw new Error(
      '[app-admin] Missing required env VITE_STELIS_API_URL. Set packages/app-admin/.env.local (see .env.local.example).',
    );
  }

  return {
    plugins: [react()],
    server: {
      port: 3100,
      proxy: {
        '/auth': apiUrl,
        '/api': apiUrl,
        '/relay': apiUrl,
        '/studio': apiUrl,
        '/health': apiUrl,
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.{ts,tsx}'],
    },
  };
});
