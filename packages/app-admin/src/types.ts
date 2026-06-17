/**
 * Shared type definitions for app-admin.
 *
 * Extracted from DashboardPage, LoginPage, and RenewModal to eliminate duplication.
 */

/** Wallet signing feature — typed wrapper for @mysten/wallet-standard. */
export interface SuiSignPersonalMessageFeature {
  signPersonalMessage(params: {
    message: Uint8Array;
    account: { address: string };
  }): Promise<{ signature: string; bytes: string }>;
}
