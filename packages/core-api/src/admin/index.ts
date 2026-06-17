/**
 * @stelis/core-api/admin — shared admin authentication, session, rate limiting.
 *
 * Framework-agnostic admin subset:
 * - adminAuth (Sui wallet signature verification)
 * - adminAuthEdge (JWT sign/verify via jose — DI config, no process.env)
 * - adminRedis (Redis session client — DI url, no process.env)
 * - adminRateLimit (login rate limiting)
 * - adminOperationsRateLimit (admin operation rate limiting)
 * - adminOperationsLog (audit logging — DI redis client)
 *
 * NOTE: edgeClientIp.ts (Next.js NextRequest dependent) is NOT included here.
 * It belongs in app-api (runtime host layer).
 */

// ── JWT operations (DI: AdminJwtConfig) ─────────────────────────────────────
export {
  parseDuration,
  signAdminJwt,
  verifyAdminJwt,
  type AdminJwtConfig,
} from './adminAuthEdge.js';

// ── Admin auth (DI: adminAddress parameter) ─────────────────────────────────
export { verifyAdminSignature, verifySignedMessage } from './adminAuth.js';

// ── Redis (DI: redisUrl parameter) ──────────────────────────────────────────
export { type AdminRedisClient, getRedisForAdmin } from './adminRedis.js';

// ── Rate limiting ────────────────────────────────────────────────────────────
export { checkAndIncrement, resetAttempts } from './adminRateLimit.js';

export { checkAndIncrementAdminOperationAttempt } from './adminOperationsRateLimit.js';

// ── Audit logging (DI: AdminRedisClient) ────────────────────────────────────
export { pushAdminOperationLog } from './adminOperationsLog.js';
