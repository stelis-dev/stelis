/**
 * SponsoredExecution — state vocabulary, HTTP phase map, and transition
 * names.
 *
 * This module is the type-level foundation for the shared lifecycle. It is
 * intentionally type-only and module-internal: nothing here is exposed from the
 * `@stelis/core-api` main barrel.
 *
 * Two HTTP phases, one shared transition contract:
 *   - `/prepare`  runs `Intent` → `AwaitUserSignature` and persists the
 *                 prepared commit. Resource ownership transfers to the
 *                 prepared-store entry on success.
 *   - `/sponsor`  resumes from the stored commit and runs
 *                 `DecodeSponsorSubmission` → `Release`. Phase-local reservation handles
 *                 is reconstructed from durable coordination state, not from
 *                 in-memory objects.
 *
 * Internal module. Do not export from the package barrel.
 */

// ─────────────────────────────────────────────
// State literal union — one entry per named lifecycle state.
// ─────────────────────────────────────────────

/**
 * Prepare-side states (run inside the `/prepare` request).
 *
 * The order of the literals mirrors the prepare state-machine execution order so
 * `PREPARE_STATE_ORDER` below can derive from the same state vocabulary without
 * a second list to drift from.
 */
export type PrepareState =
  | 'Intent'
  | 'RequestValidation'
  | 'InflightAdmission'
  | 'ChainSnapshot'
  | 'ExecutionPolicySelected'
  | 'SlotFreePlan'
  | 'ReceiptIdGenerated'
  | 'SponsorSlotReservationAcquired'
  | 'RouteReservationBeforeBuild'
  | 'GasBoundBuild'
  | 'RouteReservationAfterBuild'
  | 'SelfCheck'
  | 'SponsorLeaseCommitted'
  | 'PrepareStored'
  | 'AwaitUserSignature';

/** Sponsor-side states (run inside the `/sponsor` request). */
export type SponsorState =
  | 'DecodeSponsorSubmission'
  | 'UserSignatureValidation'
  | 'Consume'
  | 'SharedPostconsumeChecks'
  | 'PolicyPostconsumeChecks'
  | 'Preflight'
  | 'PolicyApproval'
  | 'SponsorSign'
  | 'Submit'
  | 'ClassifySponsorResult'
  | 'Release';

/** Discriminated union of every named state on the SponsoredExecution machine. */
export type SponsoredExecutionState = PrepareState | SponsorState;

// ─────────────────────────────────────────────
// HTTP phase map — which states belong to which HTTP phase.
// ─────────────────────────────────────────────

export type SponsoredExecutionPhase = 'prepare' | 'sponsor';

/**
 * Forward execution order for the prepare run. Used by the lifecycle
 * runner and tests to assert ordering invariants without re-listing the states
 * locally.
 */
export const PREPARE_STATE_ORDER: readonly PrepareState[] = [
  'Intent',
  'RequestValidation',
  'InflightAdmission',
  'ChainSnapshot',
  'ExecutionPolicySelected',
  'SlotFreePlan',
  'ReceiptIdGenerated',
  'SponsorSlotReservationAcquired',
  'RouteReservationBeforeBuild',
  'GasBoundBuild',
  'RouteReservationAfterBuild',
  'SelfCheck',
  'SponsorLeaseCommitted',
  'PrepareStored',
  'AwaitUserSignature',
] as const;

/** Forward execution order for the sponsor run. */
export const SPONSOR_STATE_ORDER: readonly SponsorState[] = [
  'DecodeSponsorSubmission',
  'UserSignatureValidation',
  'Consume',
  'SharedPostconsumeChecks',
  'PolicyPostconsumeChecks',
  'Preflight',
  'PolicyApproval',
  'SponsorSign',
  'Submit',
  'ClassifySponsorResult',
  'Release',
] as const;

/**
 * Map every state to its owning HTTP phase. Used by the runner to drive
 * phase transitions and by tests to lock the phase boundary against
 * accidental cross-phase state drift.
 */
export const STATE_SPONSORED_EXECUTION_PHASE: {
  readonly [S in SponsoredExecutionState]: SponsoredExecutionPhase;
} = {
  Intent: 'prepare',
  RequestValidation: 'prepare',
  InflightAdmission: 'prepare',
  ChainSnapshot: 'prepare',
  ExecutionPolicySelected: 'prepare',
  SlotFreePlan: 'prepare',
  ReceiptIdGenerated: 'prepare',
  SponsorSlotReservationAcquired: 'prepare',
  RouteReservationBeforeBuild: 'prepare',
  GasBoundBuild: 'prepare',
  RouteReservationAfterBuild: 'prepare',
  SelfCheck: 'prepare',
  SponsorLeaseCommitted: 'prepare',
  PrepareStored: 'prepare',
  AwaitUserSignature: 'prepare',
  DecodeSponsorSubmission: 'sponsor',
  UserSignatureValidation: 'sponsor',
  Consume: 'sponsor',
  SharedPostconsumeChecks: 'sponsor',
  PolicyPostconsumeChecks: 'sponsor',
  Preflight: 'sponsor',
  PolicyApproval: 'sponsor',
  SponsorSign: 'sponsor',
  Submit: 'sponsor',
  ClassifySponsorResult: 'sponsor',
  Release: 'sponsor',
};

// ─────────────────────────────────────────────
// Transition vocabulary — typed names for state→state moves.
// ─────────────────────────────────────────────

/**
 * One named transition step in the SponsoredExecution machine. Each transition
 * is identified by its `from` and `to` state literals so that the runtime
 * runner cannot silently jump ahead.
 *
 * Transition names are purely structural — they carry no policy data here.
 * Policy hooks (see `executionPolicy.ts`) bind to a single state and run during
 * the transition that moves out of that state.
 */
export interface SponsoredExecutionTransition<
  From extends SponsoredExecutionState,
  To extends SponsoredExecutionState,
> {
  readonly from: From;
  readonly to: To;
}

/**
 * Build the canonical forward-edge list from `PREPARE_STATE_ORDER` +
 * `SPONSOR_STATE_ORDER`. The two arrays are NOT joined into a single list —
 * `AwaitUserSignature` ends the prepare run and the next state
 * (`DecodeSponsorSubmission`) begins on a fresh `/sponsor` request, so an
 * artificial direct edge between them would misrepresent the durable
 * boundary.
 */
function buildForwardEdges<S extends SponsoredExecutionState>(
  order: readonly S[],
): ReadonlyArray<SponsoredExecutionTransition<S, S>> {
  const edges: SponsoredExecutionTransition<S, S>[] = [];
  for (let i = 0; i < order.length - 1; i++) {
    edges.push({ from: order[i]!, to: order[i + 1]! });
  }
  return edges;
}

export const PREPARE_FORWARD_TRANSITIONS: ReadonlyArray<
  SponsoredExecutionTransition<PrepareState, PrepareState>
> = buildForwardEdges(PREPARE_STATE_ORDER);

export const SPONSOR_FORWARD_TRANSITIONS: ReadonlyArray<
  SponsoredExecutionTransition<SponsorState, SponsorState>
> = buildForwardEdges(SPONSOR_STATE_ORDER);

/**
 * Optional-state policy: two states are conditionally entered depending on
 * which execution policy is active. The runner skips them when the active
 * policy says so — recorded here for tests and the execution policy module to
 * lock the legal skip set without scattering this knowledge.
 */
export const OPTIONAL_PREPARE_STATES: ReadonlySet<PrepareState> = new Set<PrepareState>([
  'RouteReservationBeforeBuild',
  'RouteReservationAfterBuild',
]);
