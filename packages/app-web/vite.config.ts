import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const relayerUrl = (env.VITE_STELIS_RELAYER_URL || '').trim();
  if (!relayerUrl) {
    throw new Error(
      '[app-web] Missing required env VITE_STELIS_RELAYER_URL. Set packages/app-web/.env.local (see .env.local.example).',
    );
  }
  if (!/\/relay\/?$/.test(relayerUrl)) {
    throw new Error('[app-web] VITE_STELIS_RELAYER_URL must end with /relay.');
  }

  // Strip /relay suffix to get the origin for proxy target
  const proxyTarget = relayerUrl.replace(/\/relay\/?$/, '');

  return {
    plugins: [react()],
    server: {
      proxy: {
        // Proxy /relay requests to the relayer during local dev.
        // This avoids CORS issues regardless of whether relayer is local or remote.
        '/relay': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.ts'],
    },
  };
});
