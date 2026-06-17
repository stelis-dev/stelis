module stelis::config {
    use stelis::events;
    use stelis::vault;

    // --- Constants ---

    // Invariants: S-2, E-4
    const MAX_CLAIM_MIST: u64 = 100_000_000; // see docs/parameters.md
    const INITIAL_MAX_CLAIM_MIST: u64 = 75_000_000; // see docs/parameters.md
    // Minimum allowed min_settle_mist (dust spam prevention)
    const MIN_SETTLE_MIST: u64 = 1_000; // see docs/parameters.md

    // Errors
    const EInvalidMaxClaim: u64 = 2;
    const ENotAdmin: u64 = 3;
    const EInvalidMinSettle: u64 = 4;
    const ENotPendingAdmin: u64 = 5; // only pending admin can accept
    const ENoPendingAdmin: u64 = 6;
    /// max_relayer_fee_mist + protocol_flat_fee_mist would exceed max_claim_mist.
    const EInvalidRelayerFeeCap: u64 = 7;
    /// max_spread_bps must be positive and at or below the full-BPS ceiling.
    const EInvalidSpreadBps: u64 = 8;
    /// propose_admin called while pending_admin is already set.
    const EPendingAdminExists: u64 = 9;

    // --- Structs ---

    public struct Config has key {
        id: UID,
        admin: address,
        pending_admin: Option<address>, // 2-step admin transfer
        /// On-chain cap for the relayer service fee per TX (MIST).
        /// The relayer operator quotes any value <= this cap via RELAYER_FEE_MIST.
        max_relayer_fee_mist: u64,
        /// Flat protocol fee per TX (MIST). Paid to protocol_treasury.
        protocol_flat_fee_mist: u64,
        protocol_treasury: address,
        max_claim_mist: u64,
        min_settle_mist: u64, // Invariant E-8: <= max_claim_mist
        /// Maximum bid-ask spread (BPS) allowed for DeepBook swap paths.
        /// Swap entrypoints abort with ESpreadTooWide (110) when spread exceeds this.
        /// Only applies to swap paths; credit-only paths are unaffected.
        max_spread_bps: u64,
        paused: bool,
        /// Monotonically increasing version. Incremented on every update_config call.
        /// Used by settle.move to detect config drift between /prepare and /sponsor.
        config_version: u64,
    }

    // --- Init ---

    fun init(ctx: &mut TxContext) {
        let deployer = ctx.sender();

        let config = Config {
            id: object::new(ctx),
            admin: deployer,
            pending_admin: option::none(),
            max_relayer_fee_mist: 0,      // Set via update_config
            protocol_flat_fee_mist: 0,    // Default protocol fee
            protocol_treasury: deployer,
            max_claim_mist: INITIAL_MAX_CLAIM_MIST,
            min_settle_mist: 100_000,     // see docs/parameters.md
            max_spread_bps: 500,          // see docs/parameters.md
            paused: false,
            config_version: 0,
        };

        transfer::share_object(config);
        vault::create_registry(ctx);
    }

    // --- Admin Functions ---

    public fun set_paused(config: &mut Config, paused: bool, ctx: &mut TxContext) {
        assert!(ctx.sender() == config.admin, ENotAdmin);
        config.paused = paused;
        events::emit_paused_event(paused, ctx.sender(), ctx.epoch());
    }

    public fun update_protocol_treasury(config: &mut Config, new_treasury: address, ctx: &mut TxContext) {
        assert!(ctx.sender() == config.admin, ENotAdmin);
        let old_treasury = config.protocol_treasury;
        config.protocol_treasury = new_treasury;
        events::emit_treasury_updated_event(old_treasury, new_treasury, ctx.sender(), ctx.epoch());
    }

    /// Step 1 — propose a new admin (only current admin can call)
    public fun propose_admin(config: &mut Config, new_admin: address, ctx: &mut TxContext) {
        assert!(ctx.sender() == config.admin, ENotAdmin);
        assert!(option::is_none(&config.pending_admin), EPendingAdminExists);
        config.pending_admin = option::some(new_admin);
        events::emit_admin_proposed_event(config.admin, new_admin, ctx.epoch());
    }

    /// Step 2 — accept admin role (only pending admin can call)
    public fun accept_admin(config: &mut Config, ctx: &mut TxContext) {
        assert!(option::is_some(&config.pending_admin), ENoPendingAdmin);
        let pending = *option::borrow(&config.pending_admin);
        assert!(ctx.sender() == pending, ENotPendingAdmin);
        let old_admin = config.admin;
        config.admin = pending;
        config.pending_admin = option::none();
        events::emit_admin_transferred_event(old_admin, pending, ctx.sender(), ctx.epoch());
    }

    /// Cancel — revoke a pending admin proposal (only current admin can call).
    /// Clears pending_admin and emits AdminProposalCancelledEvent.
    public fun cancel_admin_proposal(config: &mut Config, ctx: &mut TxContext) {
        assert!(ctx.sender() == config.admin, ENotAdmin);
        assert!(option::is_some(&config.pending_admin), ENoPendingAdmin);
        let cancelled = option::extract(&mut config.pending_admin);
        events::emit_admin_proposal_cancelled_event(config.admin, cancelled, ctx.epoch());
    }

    public fun update_config(
        config: &mut Config,
        new_max_relayer_fee_mist: u64,
        new_protocol_flat_fee_mist: u64,
        new_max_claim_mist: u64,
        new_min_settle_mist: u64,
        new_max_spread_bps: u64,
        ctx: &mut TxContext
    ) {
        assert!(ctx.sender() == config.admin, ENotAdmin);
        assert!(new_max_claim_mist <= MAX_CLAIM_MIST, EInvalidMaxClaim);
        // E-7: max_claim_mist > 0
        assert!(new_max_claim_mist > 0, EInvalidMaxClaim);
        // E-8: min_settle <= max_claim, and min_settle >= MIN_SETTLE_MIST
        assert!(new_min_settle_mist >= MIN_SETTLE_MIST, EInvalidMinSettle);
        assert!(new_min_settle_mist <= new_max_claim_mist, EInvalidMinSettle);
        // Fee cap: relayer fee cap + protocol fee must not exceed max_claim_mist.
        // Cast to u128 before addition to prevent ARITHMETIC_ERROR on u64 overflow,
        // ensuring EInvalidRelayerFeeCap is raised instead of an uncatchable abort.
        assert!(
            (new_max_relayer_fee_mist as u128) + (new_protocol_flat_fee_mist as u128) <= (new_max_claim_mist as u128),
            EInvalidRelayerFeeCap,
        );
        // Spread cap must be positive and at or below the full-BPS ceiling.
        assert!(new_max_spread_bps > 0 && new_max_spread_bps <= 10_000, EInvalidSpreadBps);

        let old_max_relayer_fee = config.max_relayer_fee_mist;
        let old_proto_fee = config.protocol_flat_fee_mist;
        let old_max = config.max_claim_mist;
        let old_min = config.min_settle_mist;
        let old_spread = config.max_spread_bps;

        config.max_relayer_fee_mist = new_max_relayer_fee_mist;
        config.protocol_flat_fee_mist = new_protocol_flat_fee_mist;
        config.max_claim_mist = new_max_claim_mist;
        config.min_settle_mist = new_min_settle_mist;
        config.max_spread_bps = new_max_spread_bps;
        // Increment config_version on every update so settle.move can detect drift.
        config.config_version = config.config_version + 1;

        events::emit_config_updated_event(
            old_max_relayer_fee,
            new_max_relayer_fee_mist,
            old_proto_fee,
            new_protocol_flat_fee_mist,
            old_max,
            new_max_claim_mist,
            old_min,
            new_min_settle_mist,
            old_spread,
            new_max_spread_bps,
            config.config_version,
            ctx.sender(),
            ctx.epoch(),
        );
    }

    // --- Getter functions ---

    public fun max_relayer_fee_mist(c: &Config): u64 { c.max_relayer_fee_mist }
    public fun protocol_flat_fee_mist(c: &Config): u64 { c.protocol_flat_fee_mist }
    public fun protocol_treasury(c: &Config): address { c.protocol_treasury }
    public fun max_claim_mist(c: &Config): u64 { c.max_claim_mist }
    public fun min_settle_mist(c: &Config): u64 { c.min_settle_mist }
    public fun max_spread_bps(c: &Config): u64 { c.max_spread_bps }
    public fun paused(c: &Config): bool { c.paused }
    public fun config_version(c: &Config): u64 { c.config_version }

    // Constants getters
    public fun get_max_claim_mist(): u64 { MAX_CLAIM_MIST }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx);
    }
}
