/**
 * [app-api] Sponsor operations 503 response builder.
 *
 * Thin adapter over `evaluateSponsorAvailability`. Returns the current code +
 * headers when the gate denies, or `null` when the gate admits
 * the request. Prepare routes pass a lease snapshot to require one free
 * healthy sponsor slot; sponsor routes do not, because they complete an
 * existing leased prepare receipt.
 *
 * The only sponsor operations gate error codes are:
 *   - `SPONSOR_CAPACITY_UNAVAILABLE`            — no healthy slot, or no free healthy slot for prepare admission
 *   - `SPONSOR_REFILL_ACCOUNT_UNHEALTHY` — `availableSlots === 0` with sponsor refill account unhealthy
 */

import type { SponsorAvailabilityErrorCode } from '@stelis/contracts';
import {
  evaluateSponsorAvailability,
  type SponsorAvailabilityOptions,
  type SponsorAvailabilityView,
} from './gate.js';

export interface SponsorOperationsBlockedResponse {
  readonly errorCode: SponsorAvailabilityErrorCode;
  readonly headers: Record<string, string>;
}

export function buildSponsorUnavailableResponse(
  view: SponsorAvailabilityView,
  options: SponsorAvailabilityOptions = {},
): SponsorOperationsBlockedResponse | null {
  const decision = evaluateSponsorAvailability(view, options);
  if (decision.allowed) return null;
  return {
    errorCode: decision.errorCode,
    headers: {},
  };
}
