#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, Vec,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
enum DataKey {
    Seller,
    Buyer,
    Token,
    Principal,
    DueDate,
    Tiers,
    Status,
}

// ── Types ─────────────────────────────────────────────────────────────────────

/// A discount window: if payment is triggered before `cutoff` (unix timestamp),
/// the buyer pays `principal * (1 - discount_bps / 10_000)`.
/// Tiers must be stored ordered by cutoff ascending.
#[contracttype]
#[derive(Clone)]
pub struct DiscountTier {
    pub cutoff: u64,
    pub discount_bps: u32, // e.g. 1500 = 15%
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Active,    // created, not yet funded
    Funded,    // buyer has locked principal
    Paid,
    Cancelled,
}

/// Full invoice state, returned by get_invoice for the frontend.
#[contracttype]
pub struct InvoiceState {
    pub seller: Address,
    pub buyer: Option<Address>, // None until funded
    pub token: Address,
    pub principal: i128,
    pub due_date: u64,
    pub tiers: Vec<DiscountTier>,
    pub status: Status,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct InvoiceDiscount;

#[contractimpl]
impl InvoiceDiscount {
    /// Called by anyone to configure the invoice. No auth required.
    /// `tiers` must be sorted by `cutoff` ascending; all cutoffs must be <= due_date.
    pub fn initialize(
        env: Env,
        seller: Address,
        token: Address,
        principal: i128,
        due_date: u64,
        tiers: Vec<DiscountTier>,
    ) {
        if env.storage().instance().has(&DataKey::Status) {
            panic!("already initialized");
        }

        assert!(principal > 0, "principal must be positive");
        assert!(due_date > env.ledger().timestamp(), "due date must be in the future");
        assert!(tiers.len() <= 10, "too many tiers");

        let mut prev_cutoff: u64 = 0;
        for i in 0..tiers.len() {
            let tier = tiers.get(i).unwrap();
            assert!(tier.cutoff > prev_cutoff, "tiers must be ordered ascending");
            assert!(tier.cutoff <= due_date, "tier cutoff must not exceed due date");
            assert!(tier.discount_bps <= 10_000, "discount cannot exceed 100%");
            prev_cutoff = tier.cutoff;
        }

        env.storage().instance().set(&DataKey::Seller, &seller);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Principal, &principal);
        env.storage().instance().set(&DataKey::DueDate, &due_date);
        env.storage().instance().set(&DataKey::Tiers, &tiers);
        env.storage().instance().set(&DataKey::Status, &Status::Active);

        env.storage().instance().extend_ttl(100_000, 100_000);
    }

    /// Any wallet can fund. The funder becomes the buyer for this invoice.
    pub fn fund(env: Env, funder: Address) {
        funder.require_auth();

        let status: Status = env.storage().instance().get(&DataKey::Status).unwrap();
        assert!(status == Status::Active, "invoice must be Active to fund");

        let token: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let principal: i128 = env.storage().instance().get(&DataKey::Principal).unwrap();

        token::Client::new(&env, &token)
            .transfer(&funder, &env.current_contract_address(), &principal);

        env.storage().instance().set(&DataKey::Buyer, &funder);
        env.storage().instance().set(&DataKey::Status, &Status::Funded);
        env.storage().instance().extend_ttl(100_000, 100_000);
    }

    /// Called by either the seller or the buyer to execute payment.
    /// Applies the highest discount tier still available at the current time,
    /// pays the seller, and refunds the remainder to the buyer.
    pub fn trigger_payment(env: Env, caller: Address) {
        caller.require_auth();

        let seller: Address = env.storage().instance().get(&DataKey::Seller).unwrap();
        let buyer: Address = env.storage().instance().get(&DataKey::Buyer).unwrap();
        assert!(caller == seller || caller == buyer, "caller must be seller or buyer");

        let status: Status = env.storage().instance().get(&DataKey::Status).unwrap();
        assert!(status == Status::Funded, "invoice must be Funded");

        let now = env.ledger().timestamp();
        let tiers: Vec<DiscountTier> = env.storage().instance().get(&DataKey::Tiers).unwrap();
        let principal: i128 = env.storage().instance().get(&DataKey::Principal).unwrap();
        let token: Address = env.storage().instance().get(&DataKey::Token).unwrap();

        let discount_bps = Self::active_discount(&tiers, now);
        let discount_amount = principal * discount_bps as i128 / 10_000;
        let payment_to_seller = principal - discount_amount;
        let refund_to_buyer = discount_amount;

        let token_client = token::Client::new(&env, &token);
        let contract_addr = env.current_contract_address();

        token_client.transfer(&contract_addr, &seller, &payment_to_seller);
        if refund_to_buyer > 0 {
            token_client.transfer(&contract_addr, &buyer, &refund_to_buyer);
        }

        env.storage().instance().set(&DataKey::Status, &Status::Paid);

        env.events().publish(
            (symbol_short!("paid"), caller),
            (payment_to_seller, refund_to_buyer, discount_bps),
        );
    }

    /// Seller can cancel at any time before Paid.
    /// If already Funded, the full principal is refunded to the buyer (whoever funded).
    /// The buyer can also cancel after the due date if the invoice expired unfunded.
    pub fn cancel(env: Env, caller: Address) {
        caller.require_auth();

        let seller: Address = env.storage().instance().get(&DataKey::Seller).unwrap();
        let now = env.ledger().timestamp();
        let due_date: u64 = env.storage().instance().get(&DataKey::DueDate).unwrap();
        let status: Status = env.storage().instance().get(&DataKey::Status).unwrap();

        let caller_is_seller = caller == seller;
        let maybe_buyer: Option<Address> = env.storage().instance().get(&DataKey::Buyer);
        let caller_is_buyer_after_due = maybe_buyer
            .as_ref()
            .map(|b| caller == *b && now > due_date)
            .unwrap_or(false);

        assert!(
            caller_is_seller || caller_is_buyer_after_due,
            "not authorized to cancel"
        );

        assert!(
            status == Status::Active || status == Status::Funded,
            "cannot cancel a completed invoice"
        );

        if status == Status::Funded {
            let buyer = maybe_buyer.unwrap();
            let token: Address = env.storage().instance().get(&DataKey::Token).unwrap();
            let principal: i128 = env.storage().instance().get(&DataKey::Principal).unwrap();
            token::Client::new(&env, &token)
                .transfer(&env.current_contract_address(), &buyer, &principal);
        }

        env.storage().instance().set(&DataKey::Status, &Status::Cancelled);
    }

    /// Read all invoice state. Used by the frontend to render invoice detail.
    pub fn get_invoice(env: Env) -> InvoiceState {
        InvoiceState {
            seller: env.storage().instance().get(&DataKey::Seller).unwrap(),
            buyer: env.storage().instance().get(&DataKey::Buyer),
            token: env.storage().instance().get(&DataKey::Token).unwrap(),
            principal: env.storage().instance().get(&DataKey::Principal).unwrap(),
            due_date: env.storage().instance().get(&DataKey::DueDate).unwrap(),
            tiers: env.storage().instance().get(&DataKey::Tiers).unwrap(),
            status: env.storage().instance().get(&DataKey::Status).unwrap(),
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Walk tiers in order; return discount_bps for the first tier whose cutoff
    /// is still in the future. Returns 0 if no tier applies (full payment).
    fn active_discount(tiers: &Vec<DiscountTier>, now: u64) -> u32 {
        for i in 0..tiers.len() {
            let tier = tiers.get(i).unwrap();
            if now < tier.cutoff {
                return tier.discount_bps;
            }
        }
        0
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    fn setup() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let seller = Address::generate(&env);
        let buyer = Address::generate(&env);

        // Deploy a mock SAC token
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_id = token_contract.address();

        // Mint principal + some extra to buyer
        StellarAssetClient::new(&env, &token_id).mint(&buyer, &1_000_000);

        let contract_id = env.register(InvoiceDiscount, ());

        (env, seller, buyer, token_id, contract_id)
    }

    fn make_tiers(env: &Env, now: u64, due: u64) -> Vec<DiscountTier> {
        // Three tiers relative to due date:
        //   before 1/4 of period elapsed → 15%
        //   before 1/2 of period elapsed → 10%
        //   before 3/4 of period elapsed →  5%
        let period = due - now;
        let mut tiers = Vec::new(env);
        tiers.push_back(DiscountTier { cutoff: now + period / 4, discount_bps: 1500 });
        tiers.push_back(DiscountTier { cutoff: now + period / 2, discount_bps: 1000 });
        tiers.push_back(DiscountTier { cutoff: now + 3 * period / 4, discount_bps: 500 });
        tiers
    }

    #[test]
    fn test_full_payment_at_due_date() {
        let (env, seller, buyer, token_id, contract_id) = setup();
        let client = InvoiceDiscountClient::new(&env, &contract_id);
        let token = TokenClient::new(&env, &token_id);

        let now = env.ledger().timestamp();
        let due = now + 60 * 86_400; // 60 days
        let principal: i128 = 100_000;
        let tiers = make_tiers(&env, now, due);

        client.initialize(&seller, &token_id, &principal, &due, &tiers);
        client.fund(&buyer);

        // Jump to after due date — no discount applies
        env.ledger().with_mut(|l| l.timestamp = due + 1);
        client.trigger_payment(&seller);

        assert_eq!(token.balance(&seller), principal);
        assert_eq!(token.balance(&buyer), 1_000_000 - principal);
    }

    #[test]
    fn test_early_payment_first_tier() {
        let (env, seller, buyer, token_id, contract_id) = setup();
        let client = InvoiceDiscountClient::new(&env, &contract_id);
        let token = TokenClient::new(&env, &token_id);

        let now = env.ledger().timestamp();
        let due = now + 60 * 86_400;
        let principal: i128 = 100_000;
        let tiers = make_tiers(&env, now, due);

        client.initialize(&seller, &token_id, &principal, &due, &tiers);
        client.fund(&buyer);

        // Still in first tier (15% discount)
        env.ledger().with_mut(|l| l.timestamp = now + 1);
        client.trigger_payment(&buyer);

        let expected_seller = principal - (principal * 1500 / 10_000); // 85_000
        let expected_refund = principal - expected_seller;              // 15_000
        assert_eq!(token.balance(&seller), expected_seller);
        assert_eq!(token.balance(&buyer), 1_000_000 - principal + expected_refund);
    }

    #[test]
    fn test_cancel_before_fund_refunds_nothing() {
        let (env, seller, _buyer, token_id, contract_id) = setup();
        let client = InvoiceDiscountClient::new(&env, &contract_id);
        let token = TokenClient::new(&env, &token_id);

        let now = env.ledger().timestamp();
        let due = now + 60 * 86_400;
        let tiers = make_tiers(&env, now, due);

        client.initialize(&seller, &token_id, &100_000, &due, &tiers);
        client.cancel(&seller);

        // Buyer balance should be untouched — no funds were ever locked
        assert_eq!(token.balance(&_buyer), 1_000_000);
    }

    #[test]
    fn test_cancel_after_fund_refunds_buyer() {
        let (env, seller, buyer, token_id, contract_id) = setup();
        let client = InvoiceDiscountClient::new(&env, &contract_id);
        let token = TokenClient::new(&env, &token_id);

        let now = env.ledger().timestamp();
        let due = now + 60 * 86_400;
        let principal: i128 = 100_000;
        let tiers = make_tiers(&env, now, due);

        client.initialize(&seller, &token_id, &principal, &due, &tiers);
        client.fund(&buyer);
        assert_eq!(token.balance(&buyer), 1_000_000 - principal);

        client.cancel(&seller);
        assert_eq!(token.balance(&buyer), 1_000_000); // full refund
    }

    #[test]
    fn test_get_invoice_returns_state() {
        let (env, seller, _buyer, token_id, contract_id) = setup();
        let client = InvoiceDiscountClient::new(&env, &contract_id);

        let now = env.ledger().timestamp();
        let due = now + 30 * 86_400;
        let tiers = make_tiers(&env, now, due);

        client.initialize(&seller, &token_id, &50_000, &due, &tiers);
        let state = client.get_invoice();

        assert_eq!(state.principal, 50_000);
        assert_eq!(state.due_date, due);
        assert_eq!(state.status, Status::Active);
    }
}
