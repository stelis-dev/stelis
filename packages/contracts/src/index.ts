// @stelis/contracts — shared TypeScript contract data for cross-package
// boundaries.
//
// Policy constraints:
//   - zero / minimal runtime scope;
//   - no runtime helper with Node-only or browser-only side effects;
//   - only request/response types, runtime data tables/identifiers/discriminator
//     literals, and trivial pure data-adjacent lookup functions.

export type {
  SuiNetwork,
  SettleProfile,
  SettlementSwapDirection,
  MoveCallCommand,
  OtherCommand,
  PtbCommand,
  DeepBookPoolHop,
  SingleHopSettlementSwapPath,
  SingleHopSettlementSwapPathResponse,
  PrepareAuthorizationFields,
  ExpectedSettleEventFields,
} from './types.js';

export {
  SETTLE_MODULE,
  SETTLE_WITH_CREDIT_FUNCTION,
  SETTLE_FUNCTIONS,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SETTLEMENT_SWAP_DIRECTION_VECTORS,
  VALID_SETTLEMENT_SWAP_DIRECTIONS,
  settlementSwapDirectionFromFunctionName,
  settlementSwapDirectionFromSwapDirections,
  PROFILE_RANKS,
  SUI_TYPE,
  INTEGRITY_POLICY_VERSION,
  DEEPBOOK_IDS,
  STELIS_CONTRACT_IDS,
  requireContractId,
  SLIPPAGE_CAP_BPS,
  GAS_MARGIN_CAP_BPS,
} from './constants.js';

export type { DeepBookIds, StelisContractIds } from './constants.js';

export type {
  SponsorSlotState,
  SponsorAvailabilityErrorCode,
  SponsorSlotStatus,
  SponsorSlotLeaseStatus,
  SponsorSlotLeaseSummary,
  SponsorRefillAccountStatus,
  SponsorOperationsStatus,
} from './admin.js';

export { buildSponsorRefillAccountWithdrawMessage } from './admin.js';
