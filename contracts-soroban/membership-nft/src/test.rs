#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _, Events as _},
        Address, BytesN, Env, String as SorobanString, Vec,
    };
    use crate::bitmap::{hash_pair, leaf_hash};

    fn setup() -> (Env, Address, Address, Address) {
        let e = Env::default();
        e.mock_all_auths();
        let deployer = Address::generate(&e);
        let admin = Address::generate(&e);
        let user = Address::generate(&e);
        let contract_id = e.register(MembershipNFT, ());
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(deployer.clone());
        client
            .initialize(
                &SorobanString::from_str(&e, "GuildPass Membership"),
                &SorobanString::from_str(&e, "GPM"),
                &SorobanString::from_str(&e, "https://guildpass.example.com/metadata/"),
            )
            .unwrap();
        e.set_invoker(deployer.clone());
        client.set_admin(&admin, &true).unwrap();
        (e, admin, user, contract_id)
    }

    #[derive(Clone)]
    struct Entry {
        index: u128,
        wallet: Address,
        community: SorobanString,
        expires_at: u64,
    }

    fn build_levels(
        env: &Env,
        leaves: Vec<BytesN<32>>,
    ) -> (Vec<Vec<BytesN<32>>>, BytesN<32>) {
        let mut levels: Vec<Vec<BytesN<32>>> = Vec::new(env);
        levels.push_back(leaves);
        loop {
            let cur = levels.last().unwrap();
            if cur.len() <= 1 {
                break;
            }
            let next_len = (cur.len() + 1) / 2;
            let mut next: Vec<BytesN<32>> = Vec::new(env);
            for i in 0..next_len {
                let l = i * 2;
                let r = l + 1;
                if (r as usize) < cur.len() {
                    next.push_back(hash_pair(
                        env,
                        &cur.get(l as u32).unwrap(),
                        &cur.get(r as u32).unwrap(),
                    ));
                } else {
                    next.push_back(cur.get(l as u32).unwrap());
                }
            }
            levels.push_back(next);
        }
        let root = levels.last().unwrap().get(0).unwrap();
        (levels, root)
    }

    fn proof_for(
        env: &Env,
        levels: &Vec<Vec<BytesN<32>>>,
        index: u128,
    ) -> Vec<BytesN<32>> {
        let mut proof: Vec<BytesN<32>> = Vec::new(env);
        let mut idx = index;
        let num_levels = levels.len() as u128;
        for lvl in 0..num_levels - 1 {
            let cur = levels.get(lvl as u32).unwrap();
            let sibling_idx = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
            if sibling_idx < cur.len() as u128 {
                proof.push_back(cur.get(sibling_idx as u32).unwrap());
            }
            idx /= 2;
        }
        proof
    }

    fn sample_entries(
        env: &Env,
        community: &SorobanString,
        count: u128,
        wallet_seed: u64,
    ) -> Vec<Entry> {
        let base_ts = 1_700_000_000u64;
        let mut entries: Vec<Entry> = Vec::new(env);
        for i in 0..count {
            let mut salt = (wallet_seed as u128).wrapping_mul(65537u128);
            salt = salt.wrapping_add(i);
            salt = salt.wrapping_mul(0x100000001b3u128);
            let mut addr_bytes = [0u8; 32];
            let salt_bytes = salt.to_be_bytes();
            for j in 0..16 {
                addr_bytes[j] = salt_bytes[j];
            }
            addr_bytes[0] = 0xAA;
            let wallet = Address::from_contract_id(&BytesN::from_array(env, &addr_bytes));
            entries.push_back(Entry {
                index: i,
                wallet,
                community: community.clone(),
                expires_at: base_ts + 365 * 24 * 3600,
            });
        }
        entries
    }

    fn make_leaves(env: &Env, entries: &Vec<Entry>) -> Vec<BytesN<32>> {
        let mut leaves: Vec<BytesN<32>> = Vec::new(env);
        for i in 0..entries.len() {
            let e = entries.get(i as u32).unwrap();
            leaves.push_back(leaf_hash(
                env,
                e.index,
                &e.wallet,
                &e.community,
                e.expires_at,
            ));
        }
        leaves
    }

    fn check_err<T>(res: Result<T, Result<ContractError, _>>, expected: ContractError) -> bool {
        match res {
            Err(Ok(ce)) => ce == expected,
            _ => false,
        }
    }

    // ---- Basic Mint / Renew / Suspend ----

    #[test]
    fn test_mint_and_active() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let dur = 365u64 * 24 * 3600;
        let id = client.mint(&user, &community, &dur).unwrap();
        assert!(client.is_active(&id));
        assert_eq!(client.community_of(&id).unwrap(), community);
        assert_eq!(client.active_token_of(&user, &community), id);
    }

    #[test]
    fn test_renew() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.ledger().with_mut(|li| {
            li.timestamp = 1_700_000_000;
        });
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let id = client.mint(&user, &community, &1u64).unwrap();
        e.ledger().with_mut(|li| {
            li.timestamp = 1_700_000_003;
        });
        assert!(!client.is_active(&id));
        client.renew(&id, &100u64).unwrap();
        assert!(client.is_active(&id));
    }

    #[test]
    fn test_suspend() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let id = client.mint(&user, &community, &100u64).unwrap();
        client.set_suspended(&id, &true).unwrap();
        assert!(!client.is_active(&id));
    }

    #[test]
    fn test_set_admin_rejects_zero_address() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let owner = client.owner().unwrap();
        e.set_invoker(owner);
        let zero_addr =
            Address::from_contract_id(&BytesN::from_array(&e, &[0u8; 32]));
        let res = client.set_admin(&zero_addr, &true);
        assert!(check_err(res, ContractError::InvalidAdmin));
        let _ = admin;
    }

    #[test]
    fn test_reminting_suspends_previous_active_token() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let first = client.mint(&user, &community, &100u64).unwrap();
        assert!(client.is_active(&first));
        let second = client.mint(&user, &community, &100u64).unwrap();
        assert!(!client.is_active(&first));
        assert!(client.suspended(&first).unwrap());
        assert!(client.is_active(&second));
        assert_eq!(client.active_token_of(&user, &community), second);
    }

    #[test]
    fn test_reminting_after_expiry_does_not_suspend() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.ledger().with_mut(|li| {
            li.timestamp = 1_700_000_000;
        });
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let first = client.mint(&user, &community, &1u64).unwrap();
        e.ledger().with_mut(|li| {
            li.timestamp = 1_700_000_003;
        });
        assert!(!client.is_active(&first));
        let second = client.mint(&user, &community, &100u64).unwrap();
        assert!(!client.suspended(&first).unwrap());
        assert!(client.is_active(&second));
    }

    #[test]
    fn test_transfer_ownership_requires_acceptance() {
        let (e, _admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let owner = client.owner().unwrap();
        let new_owner = Address::generate(&e);
        e.set_invoker(owner.clone());
        client.transfer_ownership(&new_owner).unwrap();
        assert_eq!(client.owner().unwrap(), owner);
        assert_eq!(client.pending_owner(), Some(new_owner.clone()));
        e.set_invoker(new_owner.clone());
        client.accept_ownership().unwrap();
        assert_eq!(client.owner().unwrap(), new_owner);
        assert_eq!(client.pending_owner(), None);
    }

    #[test]
    fn test_accept_ownership_reverts_non_pending() {
        let (e, _admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let owner = client.owner().unwrap();
        let new_owner = Address::generate(&e);
        e.set_invoker(owner);
        client.transfer_ownership(&new_owner).unwrap();
        let bad = Address::generate(&e);
        e.set_invoker(bad);
        let res = client.accept_ownership();
        assert!(check_err(res, ContractError::NotPendingOwner));
    }

    #[test]
    fn test_expiry_boundary() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.ledger().with_mut(|li| {
            li.timestamp = 1_700_000_000;
        });
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let id = client.mint(&user, &community, &100u64).unwrap();
        let expires_at = client.expiry(&id).unwrap();
        e.ledger().with_mut(|li| {
            li.timestamp = expires_at - 1;
        });
        assert!(client.is_active(&id));
        e.ledger().with_mut(|li| {
            li.timestamp = expires_at;
        });
        assert!(!client.is_active(&id));
    }

    #[test]
    fn test_supports_interface() {
        let (e, _admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        assert!(client.supports_interface(&0x01ffc9a7u32));
        assert!(client.supports_interface(&0x80ac58cdu32));
        assert!(client.supports_interface(&0x4bc2a65bu32));
        assert!(!client.supports_interface(&0xffffffffu32));
        assert!(!client.supports_interface(&0x12345678u32));
    }

    #[test]
    fn test_balance_of_increments() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        assert_eq!(client.balance_of(&user).unwrap(), 0);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "community-a");
        let dur = 365u64 * 24 * 3600;
        client.mint(&user, &community, &dur).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 1);
        let other = SorobanString::from_str(&e, "other-community");
        client.mint(&user, &other, &dur).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 2);
    }

    #[test]
    fn test_balance_of_decrements_on_suspend() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let dur = 365u64 * 24 * 3600;
        let id = client.mint(&user, &community, &dur).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 1);
        client.set_suspended(&id, &true).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 0);
    }

    #[test]
    fn test_balance_stable_across_remint() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let dur = 365u64 * 24 * 3600;
        client.mint(&user, &community, &dur).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 1);
        client.mint(&user, &community, &dur).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 1);
        client.mint(&user, &community, &dur).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 1);
    }

    #[test]
    fn test_unsuspend_restores_balance() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let dur = 365u64 * 24 * 3600;
        let id = client.mint(&user, &community, &dur).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 1);
        client.set_suspended(&id, &true).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 0);
        client.set_suspended(&id, &false).unwrap();
        assert_eq!(client.balance_of(&user).unwrap(), 1);
    }

    #[test]
    fn test_token_uri() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let dur = 365u64 * 24 * 3600;
        let id = client.mint(&user, &community, &dur).unwrap();
        let uri = client.token_uri(&id).unwrap();
        let expected =
            SorobanString::from_str(&e, "https://guildpass.example.com/metadata/1");
        assert_eq!(uri, expected);
    }

    #[test]
    fn test_token_uri_rejects_nonexistent() {
        let (e, _admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let res = client.token_uri(&999u128);
        assert!(check_err(res, ContractError::NoToken));
    }

    #[test]
    fn test_locked_always_true() {
        let (e, admin, user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "test-community");
        let dur = 365u64 * 24 * 3600;
        let id = client.mint(&user, &community, &dur).unwrap();
        assert!(client.locked(&id).unwrap());
        client.set_suspended(&id, &true).unwrap();
        assert!(client.locked(&id).unwrap());
    }

    // ---- Merkle Claim Tests ----

    #[test]
    fn test_claim_mints_new_wallet() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let community = SorobanString::from_str(&e, "merkle-a");
        let entries = sample_entries(&e, &community, 4, 1);
        let leaves = make_leaves(&e, &entries);
        let (levels, root) = build_levels(&e, leaves);
        e.set_invoker(admin.clone());
        client.set_membership_merkle_root(&community, &root).unwrap();
        let proof = proof_for(&e, &levels, 1);
        let entry1 = entries.get(1).unwrap();
        let relayer = Address::generate(&e);
        e.set_invoker(relayer);
        let token_id = client
            .claim_membership(
                &community,
                &1u128,
                &entry1.wallet,
                &entry1.expires_at,
                &proof,
            )
            .unwrap();
        assert!(client.is_active(&token_id));
        assert_eq!(client.owner_of(&token_id).unwrap(), entry1.wallet);
        assert_eq!(client.expiry(&token_id).unwrap(), entry1.expires_at);
        assert_eq!(
            client.active_token_of(&entry1.wallet, &community),
            token_id
        );
        assert!(client.is_claimed(&community, &root, &1u128));
    }

    #[test]
    fn test_claim_reuses_token_for_renewal() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let community = SorobanString::from_str(&e, "merkle-a");
        let entries = sample_entries(&e, &community, 2, 2);
        let leaves = make_leaves(&e, &entries);
        let (levels, root) = build_levels(&e, leaves);
        e.set_invoker(admin.clone());
        client.set_membership_merkle_root(&community, &root).unwrap();
        let proof0 = proof_for(&e, &levels, 0);
        let entry0 = entries.get(0).unwrap();
        let first = client
            .claim_membership(
                &community,
                &0u128,
                &entry0.wallet,
                &entry0.expires_at,
                &proof0,
            )
            .unwrap();
        let later_expiry = entry0.expires_at + 30 * 24 * 3600;
        let mut later_entries: Vec<Entry> = Vec::new(&e);
        later_entries.push_back(Entry {
            index: 0,
            wallet: entry0.wallet.clone(),
            community: community.clone(),
            expires_at: later_expiry,
        });
        let later_leaves = make_leaves(&e, &later_entries);
        let (later_levels, later_root) = build_levels(&e, later_leaves);
        client.set_membership_merkle_root(&community, &later_root).unwrap();
        let later_proof = proof_for(&e, &later_levels, 0);
        let second = client
            .claim_membership(
                &community,
                &0u128,
                &entry0.wallet,
                &later_expiry,
                &later_proof,
            )
            .unwrap();
        assert_eq!(second, first);
        assert_eq!(client.expiry(&first).unwrap(), later_expiry);
        assert_eq!(client.active_token_of(&entry0.wallet, &community), first);
    }

    #[test]
    fn test_claim_rejects_wrong_proof() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let community = SorobanString::from_str(&e, "merkle-a");
        let entries = sample_entries(&e, &community, 4, 5);
        let leaves = make_leaves(&e, &entries);
        let (_levels, root) = build_levels(&e, leaves);
        e.set_invoker(admin.clone());
        client.set_membership_merkle_root(&community, &root).unwrap();
        let mut garbage: Vec<BytesN<32>> = Vec::new(&e);
        garbage.push_back(BytesN::from_array(&e, &[0x01u8; 32]));
        garbage.push_back(BytesN::from_array(&e, &[0x02u8; 32]));
        let entry0 = entries.get(0).unwrap();
        let res = client.claim_membership(
            &community,
            &0u128,
            &entry0.wallet,
            &entry0.expires_at,
            &garbage,
        );
        assert!(check_err(res, ContractError::InvalidProof));
    }

    #[test]
    fn test_claim_rejects_double_claim() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let community = SorobanString::from_str(&e, "merkle-a");
        let entries = sample_entries(&e, &community, 4, 11);
        let leaves = make_leaves(&e, &entries);
        let (levels, root) = build_levels(&e, leaves);
        e.set_invoker(admin.clone());
        client.set_membership_merkle_root(&community, &root).unwrap();
        let proof = proof_for(&e, &levels, 0);
        let entry0 = entries.get(0).unwrap();
        client
            .claim_membership(
                &community,
                &0u128,
                &entry0.wallet,
                &entry0.expires_at,
                &proof,
            )
            .unwrap();
        let res = client.claim_membership(
            &community,
            &0u128,
            &entry0.wallet,
            &entry0.expires_at,
            &proof,
        );
        assert!(check_err(res, ContractError::AlreadyClaimed));
    }

    #[test]
    fn test_set_root_rejects_zero() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let community = SorobanString::from_str(&e, "merkle-a");
        let zero = BytesN::from_array(&e, &[0u8; 32]);
        e.set_invoker(admin.clone());
        let res = client.set_membership_merkle_root(&community, &zero);
        assert!(check_err(res, ContractError::InvalidRoot));
    }

    #[test]
    fn test_claim_reverts_when_no_root() {
        let (e, _admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let community = SorobanString::from_str(&e, "no-root");
        let wallet = Address::generate(&e);
        let proof: Vec<BytesN<32>> = Vec::new(&e);
        let res = client.claim_membership(
            &community,
            &0u128,
            &wallet,
            &(1_700_000_000u64 + 86400),
            &proof,
        );
        assert!(check_err(res, ContractError::NoRootSet));
    }

    #[test]
    fn test_claim_relayer_path() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let community = SorobanString::from_str(&e, "merkle-a");
        let entries = sample_entries(&e, &community, 4, 17);
        let leaves = make_leaves(&e, &entries);
        let (levels, root) = build_levels(&e, leaves);
        e.set_invoker(admin.clone());
        client.set_membership_merkle_root(&community, &root).unwrap();
        let relayer = Address::generate(&e);
        let entry2 = entries.get(2).unwrap();
        assert_ne!(relayer, entry2.wallet);
        let proof = proof_for(&e, &levels, 2);
        e.set_invoker(relayer.clone());
        let token_id = client
            .claim_membership(
                &community,
                &2u128,
                &entry2.wallet,
                &entry2.expires_at,
                &proof,
            )
            .unwrap();
        assert_eq!(client.owner_of(&token_id).unwrap(), entry2.wallet);
        assert_ne!(client.owner_of(&token_id).unwrap(), relayer);
    }

    // ---- Fuzz / Invariants ----

    #[test]
    fn test_invariant_single_active_per_community() {
        for _ in 0..5 {
            let (e, admin, _user, contract_id) = setup();
            let client = MembershipNFTClient::new(&e, &contract_id);
            let wallet = Address::generate(&e);
            e.set_invoker(admin.clone());
            let community = SorobanString::from_str(&e, "comm-x");
            let t1 = client.mint(&wallet, &community, &500u64).unwrap();
            let t2 = client.mint(&wallet, &community, &600u64).unwrap();
            let active = client.active_token_of(&wallet, &community);
            assert_eq!(active, t2);
            assert!(client.is_active(&t2));
            assert!(!client.is_active(&t1));
        }
    }

    #[test]
    fn test_suspended_is_not_active() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let user = Address::generate(&e);
        e.set_invoker(admin.clone());
        let community = SorobanString::from_str(&e, "comm-s");
        let id = client.mint(&user, &community, &100u64).unwrap();
        client.set_suspended(&id, &true).unwrap();
        assert!(!client.is_active(&id));
        assert!(client.suspended(&id).unwrap());
    }

    #[test]
    fn test_access_control_non_admin_rejected() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let caller = Address::generate(&e);
        assert_ne!(caller, admin);
        e.set_invoker(caller);
        let target = Address::generate(&e);
        let community = SorobanString::from_str(&e, "comm");
        let res = client.mint(&target, &community, &10u64);
        assert!(check_err(res, ContractError::NotAdmin));
        let res = client.renew(&1u128, &10u64);
        assert!(check_err(res, ContractError::NotAdmin));
        let res = client.set_suspended(&1u128, &true);
        assert!(check_err(res, ContractError::NotAdmin));
    }

    #[test]
    fn test_edge_cases_invalid_inputs() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        e.set_invoker(admin.clone());
        let zero_addr =
            Address::from_contract_id(&BytesN::from_array(&e, &[0u8; 32]));
        let community = SorobanString::from_str(&e, "comm");
        let res = client.mint(&zero_addr, &community, &10u64);
        assert!(check_err(res, ContractError::InvalidTo));
        let user = Address::generate(&e);
        let res = client.mint(&user, &community, &0u64);
        assert!(check_err(res, ContractError::InvalidDuration));
        let res = client.renew(&9999u128, &10u64);
        assert!(check_err(res, ContractError::NoToken));
    }

    #[test]
    fn test_claim_renewal_preserves_suspension() {
        let (e, admin, _user, contract_id) = setup();
        let client = MembershipNFTClient::new(&e, &contract_id);
        let community = SorobanString::from_str(&e, "merkle-a");
        let entries = sample_entries(&e, &community, 1, 4);
        let leaves = make_leaves(&e, &entries);
        let (levels, root) = build_levels(&e, leaves);
        e.set_invoker(admin.clone());
        client.set_membership_merkle_root(&community, &root).unwrap();
        let proof = proof_for(&e, &levels, 0);
        let entry0 = entries.get(0).unwrap();
        let token_id = client
            .claim_membership(
                &community,
                &0u128,
                &entry0.wallet,
                &entry0.expires_at,
                &proof,
            )
            .unwrap();
        client.set_suspended(&token_id, &true).unwrap();
        assert!(!client.is_active(&token_id));
        let later_exp = entry0.expires_at + 86400;
        let mut renew_entries: Vec<Entry> = Vec::new(&e);
        renew_entries.push_back(Entry {
            index: 0,
            wallet: entry0.wallet.clone(),
            community: community.clone(),
            expires_at: later_exp,
        });
        let renew_leaves = make_leaves(&e, &renew_entries);
        let (renew_levels, renew_root) = build_levels(&e, renew_leaves);
        client.set_membership_merkle_root(&community, &renew_root).unwrap();
        let renew_proof = proof_for(&e, &renew_levels, 0);
        client
            .claim_membership(
                &community,
                &0u128,
                &entry0.wallet,
                &later_exp,
                &renew_proof,
            )
            .unwrap();
        assert_eq!(client.expiry(&token_id).unwrap(), later_exp);
        assert!(client.suspended(&token_id).unwrap());
        assert!(!client.is_active(&token_id));
    }
}
