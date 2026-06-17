/**
 * Edge-safe sponsor key parser.
 *
 * This module intentionally avoids node:crypto and other Node-only imports
 * so it can be used from instrumentation.ts, middleware.ts, and any other
 * ambiguous-runtime module without pulling in Node-only dependencies.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { assertSponsorSlotCount } from './sponsorSlotPolicy.js';

/**
 * Parses a sponsor secret key.
 * Only Bech32 "suiprivkey1..." format is accepted.
 *
 * To get this format from a Sui CLI key file:
 *   sui keytool export --key-identity <ADDRESS> --json
 * or:
 *   cat ~/.sui/sui_config/sui.keystore  (the value starting with "suiprivkey1...")
 */
export function parseSponsorKey(secretKey: string, envName = 'SPONSOR_SECRET_KEY'): Ed25519Keypair {
  if (!secretKey.startsWith('suiprivkey1')) {
    throw new Error(
      `${envName} must be in Bech32 format (starts with "suiprivkey1"). ` +
        'Run: sui keytool export --key-identity <ADDRESS> --json',
    );
  }
  return Ed25519Keypair.fromSecretKey(secretKey);
}

export function parseSponsorKeys(secretKey: string | string[]): Ed25519Keypair[] {
  const rawKeys = Array.isArray(secretKey)
    ? secretKey
    : secretKey.includes(',')
      ? secretKey.split(',').map((k) => k.trim())
      : [secretKey];
  assertSponsorSlotCount(rawKeys.length, 'SPONSOR_SECRET_KEY');
  return rawKeys.map((key) => parseSponsorKey(key));
}
