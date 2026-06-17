/**
 * Admin authentication helpers — Node.js runtime only.
 *
 * Framework-agnostic: admin address is injected via parameter,
 * NOT read from process.env (core-api boundary policy).
 *
 * Edge-safe exports (verifyAdminJwt, signAdminJwt, parseDuration)
 * are re-exported from adminAuthEdge.ts.
 */
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

// Re-export Edge-safe symbols so existing route handler imports keep working
export {
  parseDuration,
  signAdminJwt,
  verifyAdminJwt,
  type AdminJwtConfig,
} from './adminAuthEdge.js';

// ── Admin address helper (DI, no process.env) ─────────────────────────────

/**
 * Validate and return the admin address.
 * @param adminAddress — Injected by the host (app-api reads from env).
 */
export function getAdminAddress(adminAddress: string): string {
  const v = adminAddress?.trim();
  if (!v) throw new Error('[admin] adminAddress is not set');
  return v;
}

// ── Signature verification (Node.js only) ────────────────────────────────────

export async function verifyAdminSignature(params: {
  nonce: string;
  signature: string;
  address: string;
  adminAddress: string;
}): Promise<boolean> {
  const expected = getAdminAddress(params.adminAddress);
  if (params.address.toLowerCase() !== expected.toLowerCase()) return false;

  try {
    const messageBytes = new TextEncoder().encode(params.nonce);
    const recovered = await verifyPersonalMessageSignature(messageBytes, params.signature);
    return recovered.toSuiAddress().toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Low-level purpose-bound signature verification helper.
 *
 * App packages use this to build typed wrappers:
 * - main host: verifyWithdrawSignature(amountMist, nonce, ...)
 * - studio host: verifyPromotionSignature(action, poolId, params, nonce, ...)
 *
 * @param message   - Pre-built purpose-bound message string
 * @param signature - Base64 wallet signature
 * @param adminAddress - Expected signer address (injected by host)
 */
export async function verifySignedMessage(params: {
  message: string;
  signature: string;
  adminAddress: string;
}): Promise<boolean> {
  const expected = getAdminAddress(params.adminAddress);
  if (params.adminAddress.toLowerCase() !== expected.toLowerCase()) return false;

  try {
    const messageBytes = new TextEncoder().encode(params.message);
    const recovered = await verifyPersonalMessageSignature(messageBytes, params.signature);
    return recovered.toSuiAddress().toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}
