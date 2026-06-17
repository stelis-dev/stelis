module stelis::vault {
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use sui::table::{Self, Table};
    use stelis::events;

    // --- Errors ---
    const EInsufficientBalance: u64 = 0;
    const EReplayNonce: u64 = 1;
    const EVaultAlreadyRegistered: u64 = 2;
    const EVaultNotRegistered: u64 = 3;
    const EVaultMismatch: u64 = 4;

    // --- Structs ---

    /// UserVault holds the surplus SUI from settlements.
    /// Invariant O-1: Owned Object, **soulbound** (no `store` → non-transferable).
    public struct UserVault has key {
        id: UID,
        // Invariant O-2: credit is mutable only by owner (via usage) or settle (via friend).
        credit: Balance<SUI>,
        // Invariant O-3: surplus belongs only here.
        // S-14: Monotonic nonce for on-chain replay prevention (complete defense-in-depth).
        last_nonce: u64,
    }

    /// Vault registry — enforces one registered vault per user.
    /// Shared Object: created at init, used by settle/settle_with_vault.
    public struct VaultRegistry has key {
        id: UID,
        /// address → registered vault Object ID
        vaults: Table<address, ID>,
    }

    // --- Registry Functions (package-only) ---

    /// Create and share the VaultRegistry. Called from config::init().
    public(package) fun create_registry(ctx: &mut TxContext) {
        let registry = VaultRegistry {
            id: object::new(ctx),
            vaults: table::new(ctx),
        };
        transfer::share_object(registry);
    }

    /// Register a vault for the sender.
    /// Aborts if the sender already has a registered vault.
    public(package) fun register_vault(
        registry: &mut VaultRegistry,
        owner: address,
        vault_id: ID,
    ) {
        assert!(!table::contains(&registry.vaults, owner), EVaultAlreadyRegistered);
        table::add(&mut registry.vaults, owner, vault_id);
    }

    /// Validate that the given vault is the sender's registered vault.
    /// Aborts if not registered or if vault ID doesn't match.
    public(package) fun validate_vault(
        registry: &VaultRegistry,
        owner: address,
        vault_id: ID,
    ) {
        assert!(table::contains(&registry.vaults, owner), EVaultNotRegistered);
        let registered_id = table::borrow(&registry.vaults, owner);
        assert!(*registered_id == vault_id, EVaultMismatch);
    }

    // --- Internal Functions (package-only) ---

    /// Create a new UserVault.
    /// Only callable from within the package (settle module).
    /// Invariant O-1: Sender owned.
    public(package) fun create_vault(ctx: &mut TxContext): UserVault {
        UserVault {
            id: object::new(ctx),
            credit: balance::zero<SUI>(),
            last_nonce: 0,
        }
    }

    /// Get the Object ID of a vault (for registry operations).
    public(package) fun vault_id(vault: &UserVault): ID {
        object::id(vault)
    }

    /// Use credit (surplus) for the current transaction intent.
    /// Only callable from within the package (settle module).
    /// Returns Coin<SUI> from vault to be merged with swap output.
    /// Invariant P-3: Always callable.
    public(package) fun use_credit(vault: &mut UserVault, amount: u64, ctx: &mut TxContext): Coin<SUI> {
        assert!(balance::value(&vault.credit) >= amount, EInsufficientBalance);
        let remaining = balance::value(&vault.credit) - amount;
        events::emit_credit_used_event(ctx.sender(), amount, remaining);
        coin::take(&mut vault.credit, amount, ctx)
    }

    /// Join surplus balance to vault. Only callable from within the package.
    public(package) fun join_surplus(vault: &mut UserVault, surplus: Balance<SUI>) {
        balance::join(&mut vault.credit, surplus);
    }

    /// S-14: Monotonic nonce replay prevention.
    /// Aborts if nonce is not strictly greater than the last recorded nonce.
    /// Only callable from within the package (settle module).
    public(package) fun check_and_advance_nonce(
        vault: &mut UserVault,
        nonce: u64,
    ) {
        assert!(nonce > vault.last_nonce, EReplayNonce);
        vault.last_nonce = nonce;
    }

    // --- Public Functions (user-facing) ---

    /// Owner can withdraw entire balance.
    /// Invariant O-5, P-2: Always callable.
    public fun withdraw(vault: &mut UserVault, ctx: &mut TxContext): Coin<SUI> {
        let amount = balance::value(&vault.credit);
        assert!(amount > 0, EInsufficientBalance);
        events::emit_withdraw_event(ctx.sender(), amount);
        coin::take(&mut vault.credit, amount, ctx)
    }

    /// Owner can withdraw a specified amount from the vault.
    /// Allows partial withdrawals without draining the entire balance.
    /// Aborts with EInsufficientBalance if amount is 0 or exceeds current credit.
    /// The `amount > 0` guard mirrors `withdraw()` and avoids emitting a withdraw
    /// event + creating a zero-value Coin<SUI> that the caller must then
    /// transfer or destroy separately (gas/event hygiene).
    public fun withdraw_amount(vault: &mut UserVault, amount: u64, ctx: &mut TxContext): Coin<SUI> {
        assert!(amount > 0, EInsufficientBalance);
        assert!(balance::value(&vault.credit) >= amount, EInsufficientBalance);
        events::emit_withdraw_event(ctx.sender(), amount);
        coin::take(&mut vault.credit, amount, ctx)
    }

    /// Public accessor for balance (view function)
    public fun balance(vault: &UserVault): u64 {
        balance::value(&vault.credit)
    }

    /// Transfer vault to owner. Required because UserVault is soulbound (no `store`),
    /// so only this module can call `transfer::transfer`.
    public(package) fun transfer_vault(vault: UserVault, owner: address) {
        transfer::transfer(vault, owner);
    }

    #[test_only]
    public fun init_registry_for_testing(ctx: &mut TxContext) {
        create_registry(ctx);
    }

    #[test_only]
    public fun init_vault_for_testing(ctx: &mut TxContext): UserVault {
        create_vault(ctx)
    }

    #[test_only]
    /// Transfer vault to owner for testing (needed because UserVault is soulbound / no `store`).
    public fun transfer_vault_for_testing(vault: UserVault, owner: address) {
        transfer::transfer(vault, owner);
    }
}
