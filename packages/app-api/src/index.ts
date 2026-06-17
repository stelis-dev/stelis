/**
 * [app-api] Unified Hono API host for Stelis.
 *
 * Entry point: boots env validation, creates context, registers routes,
 * and starts the HTTP server.
 *
 * Runtime model:
 *   - Generic relay path: always active
 *   - Studio path: active only when studio env set is complete
 *
 * Session policy:
 *   - Cookie: stelis_admin
 *   - Redis not_before: stelis:app-api:admin:not_before
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { formatRuntimeMode, runBootValidation } from './boot.js';
import { getCtx, setSharedSuiClient } from './context.js';
import { createRelayRoutes } from './routes/relay.js';
import { createAuthRoutes } from './routes/auth.js';
import { createAdminRoutes } from './routes/admin.js';
import { createStudioRoutes } from './routes/studio.js';
import { parsePortEnv } from './env.js';

const PORT = parsePortEnv('PORT', process.env.PORT, 3200);

async function main() {
  // 1. Boot validation (fail-fast) — creates shared Sui RPC client
  const bootResult = await runBootValidation();

  // 1b. Inject shared Sui client + transport into context module (before any getCtx() calls)
  setSharedSuiClient(
    bootResult.suiClient,
    bootResult.failoverTransport,
    bootResult.rpcEndpointUrls,
  );

  // 2. Create Hono app
  const app = new Hono();

  // 3. Security headers (all routes)
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-XSS-Protection', '0');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  // 4. CORS policy
  //    /relay/* and /studio/* — SDK-facing, open to all origins (public API)
  app.use(
    '/relay/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(
    '/studio/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  //    /auth/*, /api/* — admin-facing, restricted to configured origins
  const allowedOrigins =
    process.env.CORS_ORIGINS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (allowedOrigins.length > 0) {
    app.use(
      '/auth/*',
      cors({
        origin: allowedOrigins,
        credentials: true,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      }),
    );
    app.use(
      '/api/*',
      cors({
        origin: allowedOrigins,
        credentials: true,
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      }),
    );
  }

  // 5. Eager context init (fail-fast: on-chain settlement swap path derivation)
  // This must complete before the server starts accepting requests.
  // If settlement-swap-paths.json contains invalid pool IDs, or RPC derivation fails,
  // the process crashes here — not on first request.
  // eslint-disable-next-line no-console
  console.log('[app-api] Initializing context (settlement-swap-paths.json on-chain derivation)...');
  await getCtx();

  // 6. Health check (always available — context already initialized)
  app.get('/health', (c) => c.json({ status: 'ok', mode: bootResult.mode }));

  // 7. Mount route groups
  const relayRoutes = createRelayRoutes(getCtx);
  const authRoutes = createAuthRoutes(getCtx);
  const adminRoutes = createAdminRoutes(getCtx);
  const studioRoutes = createStudioRoutes(getCtx);

  app.route('/relay', relayRoutes);
  app.route('/auth', authRoutes);
  app.route('/api', adminRoutes);
  app.route('/studio', studioRoutes);

  // 8. Start server
  // eslint-disable-next-line no-console
  console.log(`[app-api] Starting server on port ${PORT}...`);

  serve(
    {
      fetch: app.fetch,
      port: PORT,
    },
    (info) => {
      // eslint-disable-next-line no-console
      console.log(`[app-api] Listening on http://localhost:${info.port}`);
      // eslint-disable-next-line no-console
      console.log(`[app-api] ✅ Ready — mode: ${formatRuntimeMode(bootResult.mode)}`);
    },
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[app-api] Fatal error:', err);
  process.exit(1);
});
