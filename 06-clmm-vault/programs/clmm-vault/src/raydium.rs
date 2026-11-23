//! Weeks 12–13: the vault works with Raydium CLMM through CPI.
//!
//!   add_pair_token     — set the second token of the pair (TOKEN_B of the pool)
//!   swap               — week 12: swap vault tokens through the pool
//!   open_position      — week 13: put A and B into a price range
//!   increase_liquidity — week 13 (extra task 8): add tokens to the open position
//!   collect_fees       — week 13: collect accrued fees (counted, extra task 9)
//!   close_position     — week 13: withdraw everything and close the position
//!   sync_vault         — back to normal mode once everything is TOKEN_A again
//!
//! While funds are "in the market" (TOKEN_B or an open position), deposit and withdraw are
//! blocked: `total_tokens` does not reflect the real value of the vault then.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::memo::Memo;
use anchor_spl::token::{self, Approve, Mint, Revoke, Token, TokenAccount};
use anchor_spl::token_2022::Token2022;
use raydium_clmm_cpi::{
    cpi,
    states::{PersonalPositionState, PoolState},
};

use crate::{VaultError, VaultState};

/// Vault PDA signature: seeds = ["vault", token_mint, bump].
macro_rules! vault_signer {
    ($signer:ident, $vault:expr) => {
        let mint = $vault.token_mint;
        let bump = [$vault.bump];
        let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &bump];
        let $signer: &[&[&[u8]]] = &[seeds];
    };
}

/// The pool must be exactly the vault's TOKEN_A / TOKEN_B pair.
fn check_pool(vault: &VaultState, pool: &PoolState) -> Result<()> {
    require!(vault.token_mint_b != Pubkey::default(), VaultError::PairNotSet);
    let pair_ok = (pool.token_mint_0 == vault.token_mint && pool.token_mint_1 == vault.token_mint_b)
        || (pool.token_mint_0 == vault.token_mint_b && pool.token_mint_1 == vault.token_mint);
    require!(pair_ok, VaultError::WrongPool);
    Ok(())
}

/// Extra task 7: one A → B swap may sell at most half of the vault's TOKEN_A balance.
pub fn max_swap_a(balance_a: u64) -> u64 {
    balance_a / 2
}

// ─────────────────────────────────────────────────────────────────────────────
// add_pair_token
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct AddPairToken<'info> {
    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Second token of the pair (TOKEN_B)
    pub token_mint_b: Account<'info, Mint>,

    /// Vault token account for TOKEN_B — seeds: ["vault_tokens_b", token_mint].
    /// `init` also makes a second call fail: the pair is set once.
    #[account(
        init,
        payer = admin,
        token::mint = token_mint_b,
        token::authority = vault_state,
        seeds = [b"vault_tokens_b", vault_state.token_mint.as_ref()],
        bump,
    )]
    pub vault_token_account_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn add_pair_token(ctx: Context<AddPairToken>) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    require!(ctx.accounts.token_mint_b.key() != vault.token_mint, VaultError::SameToken);
    vault.token_mint_b = ctx.accounts.token_mint_b.key();
    vault.vault_token_account_b = ctx.accounts.vault_token_account_b.key();

    msg!("Pair token added: {}", vault.token_mint_b);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// swap (week 12)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct VaultSwap<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Vault TOKEN_A
    #[account(mut, address = vault_state.vault_token_account)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// Vault TOKEN_B
    #[account(mut, address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Box<Account<'info, TokenAccount>>,

    // ─── Raydium CLMM ───────────────────────────────────────────────────────
    /// CHECK: Raydium checks that this is the pool's amm_config
    pub amm_config: UncheckedAccount<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// CHECK: pool vault of the input token, compared with pool_state in the handler
    #[account(mut)]
    pub input_vault: UncheckedAccount<'info>,

    /// CHECK: pool vault of the output token, compared with pool_state in the handler
    #[account(mut)]
    pub output_vault: UncheckedAccount<'info>,

    /// CHECK: Raydium checks that this is the pool's observation account
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    /// CHECK: input mint, Raydium compares it with input_vault
    pub input_vault_mint: UncheckedAccount<'info>,

    /// CHECK: output mint, Raydium compares it with output_vault
    pub output_vault_mint: UncheckedAccount<'info>,

    /// CHECK: Raydium CLMM program address
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,
    // remaining_accounts: tick_array_bitmap_extension + tick arrays along the swap path
}

/// Swap `amount_in` vault tokens through the pool.
/// `a_to_b = true`: TOKEN_A → TOKEN_B, otherwise TOKEN_B → TOKEN_A.
/// `amount_in = u64::MAX` — the whole balance of the input token at execution time.
/// A → B may sell at most 50% of the TOKEN_A balance (`SwapTooLarge`).
/// If the pool returns less than `min_amount_out`, Raydium reverts the transaction.
pub fn swap<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultSwap<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    a_to_b: bool,
) -> Result<()> {
    let balance_a = ctx.accounts.vault_token_account.amount;
    // "Whole balance" is read on-chain: if someone sends TOKEN_B right before our transaction,
    // swap(B→A, MAX) + sync_vault still empties B
    let amount_in = if amount_in == u64::MAX {
        if a_to_b { balance_a } else { ctx.accounts.vault_token_account_b.amount }
    } else {
        amount_in
    };
    require!(amount_in > 0, VaultError::ZeroAmount);
    if a_to_b {
        require!(amount_in <= max_swap_a(balance_a), VaultError::SwapTooLarge);
    }

    let vault = &ctx.accounts.vault_state;
    let (input_mint, output_mint) = if a_to_b {
        (vault.token_mint, vault.token_mint_b)
    } else {
        (vault.token_mint_b, vault.token_mint)
    };

    // Pool vaults must match the swap direction
    {
        let pool = ctx.accounts.pool_state.load()?;
        check_pool(vault, &pool)?;
        let pool_vault_of = |mint: Pubkey| {
            if mint == pool.token_mint_0 { pool.token_vault_0 } else { pool.token_vault_1 }
        };
        require_keys_eq!(ctx.accounts.input_vault.key(), pool_vault_of(input_mint), VaultError::WrongPool);
        require_keys_eq!(ctx.accounts.output_vault.key(), pool_vault_of(output_mint), VaultError::WrongPool);
    }

    let (input_account, output_account) = if a_to_b {
        (ctx.accounts.vault_token_account.to_account_info(), ctx.accounts.vault_token_account_b.to_account_info())
    } else {
        (ctx.accounts.vault_token_account_b.to_account_info(), ctx.accounts.vault_token_account.to_account_info())
    };

    // CPI: Raydium swap_v2. The vault PDA pays and signs — it owns the input tokens.
    let cpi_accounts = cpi::accounts::SwapSingleV2 {
        payer: ctx.accounts.vault_state.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account: input_account,
        output_token_account: output_account,
        input_vault: ctx.accounts.input_vault.to_account_info(),
        output_vault: ctx.accounts.output_vault.to_account_info(),
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
        input_vault_mint: ctx.accounts.input_vault_mint.to_account_info(),
        output_vault_mint: ctx.accounts.output_vault_mint.to_account_info(),
    };
    vault_signer!(signer, ctx.accounts.vault_state);
    let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.clmm_program.to_account_info(), cpi_accounts, signer)
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    cpi::swap_v2(cpi_ctx, amount_in, min_amount_out, 0, true)?;

    // Vault funds are no longer only TOKEN_A → deposit/withdraw paused until sync_vault
    ctx.accounts.vault_state.in_market = true;

    msg!("Swap: {} in (a_to_b={}), min_out={}", amount_in, a_to_b, min_amount_out);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// open_position (week 13)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct VaultOpenPosition<'info> {
    /// The admin pays rent for the position NFT and Raydium's accounts
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut, address = vault_state.vault_token_account)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Box<Account<'info, TokenAccount>>,

    // ─── Raydium CLMM ───────────────────────────────────────────────────────
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// New position NFT mint (fresh keypair from the client)
    #[account(mut)]
    pub position_nft_mint: Signer<'info>,

    /// CHECK: vault PDA's ATA for the position NFT (Token-2022), created by Raydium
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: personal_position PDA, created by Raydium
    #[account(mut)]
    pub personal_position: UncheckedAccount<'info>,

    /// CHECK: tick array of the lower bound, Raydium creates it if needed
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,

    /// CHECK: tick array of the upper bound, Raydium creates it if needed
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,

    /// CHECK: pool vault token_0, Raydium compares it with pool_state
    #[account(mut)]
    pub token_vault_0: UncheckedAccount<'info>,

    /// CHECK: pool vault token_1, Raydium compares it with pool_state
    #[account(mut)]
    pub token_vault_1: UncheckedAccount<'info>,

    /// CHECK: pool token_0 mint
    pub vault_0_mint: UncheckedAccount<'info>,

    /// CHECK: pool token_1 mint
    pub vault_1_mint: UncheckedAccount<'info>,

    /// CHECK: Raydium CLMM program address
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program_2022: Program<'info, Token2022>,
    // remaining_accounts: tick_array_bitmap_extension (if the range is far from the current price)
}

/// Open a position in [tick_lower, tick_upper].
/// Raydium computes liquidity from `amount_0_max` (base_0 = true) or `amount_1_max` (base_0 = false).
/// Amounts are in POOL order (token_0 = smaller mint address), not vault A/B.
pub fn open_position<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultOpenPosition<'info>>,
    tick_lower_index: i32,
    tick_upper_index: i32,
    tick_array_lower_start_index: i32,
    tick_array_upper_start_index: i32,
    amount_0_max: u64,
    amount_1_max: u64,
    base_0: bool,
) -> Result<()> {
    require!(tick_lower_index < tick_upper_index, VaultError::InvalidTickRange);
    require!(amount_0_max > 0 || amount_1_max > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault_state;
    require!(vault.position_nft_mint == Pubkey::default(), VaultError::PositionAlreadyOpen);

    // Which vault token is the pool's token_0
    let a_is_token_0 = {
        let pool = ctx.accounts.pool_state.load()?;
        check_pool(vault, &pool)?;
        pool.token_mint_0 == vault.token_mint
    };
    let (account_0, account_1) = if a_is_token_0 {
        (&ctx.accounts.vault_token_account, &ctx.accounts.vault_token_account_b)
    } else {
        (&ctx.accounts.vault_token_account_b, &ctx.accounts.vault_token_account)
    };

    // Raydium pulls tokens on behalf of the payer (admin), who must also pay rent with the
    // system program — a data-carrying PDA cannot. The tokens belong to the vault PDA, so for the
    // duration of the call the admin may spend at most amount_*_max, then the approval is revoked.
    vault_signer!(signer, ctx.accounts.vault_state);
    for (account, amount) in [(account_0, amount_0_max), (account_1, amount_1_max)] {
        token::approve(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Approve {
                    to: account.to_account_info(),
                    delegate: ctx.accounts.admin.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
    }

    let cpi_accounts = cpi::accounts::OpenPositionWithToken22Nft {
        payer: ctx.accounts.admin.to_account_info(),
        position_nft_owner: ctx.accounts.vault_state.to_account_info(), // NFT belongs to the vault PDA
        position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
        position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        protocol_position: ctx.accounts.personal_position.to_account_info(), // deprecated Raydium field
        tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.tick_array_upper.to_account_info(),
        personal_position: ctx.accounts.personal_position.to_account_info(),
        token_account_0: account_0.to_account_info(),
        token_account_1: account_1.to_account_info(),
        token_vault_0: ctx.accounts.token_vault_0.to_account_info(),
        token_vault_1: ctx.accounts.token_vault_1.to_account_info(),
        rent: ctx.accounts.rent.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        vault_0_mint: ctx.accounts.vault_0_mint.to_account_info(),
        vault_1_mint: ctx.accounts.vault_1_mint.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.clmm_program.to_account_info(), cpi_accounts)
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    cpi::open_position_with_token22_nft(
        cpi_ctx,
        tick_lower_index,
        tick_upper_index,
        tick_array_lower_start_index,
        tick_array_upper_start_index,
        0, // Raydium computes liquidity from the base amount
        amount_0_max,
        amount_1_max,
        false, // no metaplex metadata
        Some(base_0),
    )?;

    // Remove the admin's allowance: the unused rest must not stay delegated
    for account in [account_0, account_1] {
        token::revoke(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Revoke {
                source: account.to_account_info(),
                authority: ctx.accounts.vault_state.to_account_info(),
            },
            signer,
        ))?;
    }

    let vault = &mut ctx.accounts.vault_state;
    vault.position_nft_mint = ctx.accounts.position_nft_mint.key();
    vault.in_market = true;

    msg!("Position opened: ticks [{}, {}], nft={}", tick_lower_index, tick_upper_index, vault.position_nft_mint);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// increase_liquidity / collect_fees / close_position (week 13)
// ─────────────────────────────────────────────────────────────────────────────

/// Accounts of the open vault position (increase_liquidity, collect_fees, close_position)
#[derive(Accounts)]
pub struct VaultPosition<'info> {
    /// mut: close_position returns to the admin the rent paid in open_position
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut, address = vault_state.vault_token_account)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Box<Account<'info, TokenAccount>>,

    // ─── Raydium CLMM ───────────────────────────────────────────────────────
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// CHECK: position NFT, must equal vault_state.position_nft_mint
    #[account(mut, address = vault_state.position_nft_mint @ VaultError::NoOpenPosition)]
    pub position_nft_mint: UncheckedAccount<'info>,

    /// CHECK: vault PDA's ATA holding the position NFT; Raydium checks mint, amount and owner
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = personal_position.pool_id == pool_state.key() @ VaultError::WrongPool,
        constraint = personal_position.nft_mint == vault_state.position_nft_mint @ VaultError::NoOpenPosition,
    )]
    pub personal_position: Box<Account<'info, PersonalPositionState>>,

    /// CHECK: pool vault token_0, Raydium compares it with pool_state
    #[account(mut)]
    pub token_vault_0: UncheckedAccount<'info>,

    /// CHECK: pool vault token_1, Raydium compares it with pool_state
    #[account(mut)]
    pub token_vault_1: UncheckedAccount<'info>,

    /// CHECK: tick array of the position's lower bound
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,

    /// CHECK: tick array of the position's upper bound
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,

    /// CHECK: pool token_0 mint
    pub vault_0_mint: UncheckedAccount<'info>,

    /// CHECK: pool token_1 mint
    pub vault_1_mint: UncheckedAccount<'info>,

    /// CHECK: Raydium CLMM program address
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,
    pub system_program: Program<'info, System>,
}

/// Vault token accounts in pool order: (token_0, token_1)
fn pool_ordered<'info>(accounts: &VaultPosition<'info>) -> Result<(AccountInfo<'info>, AccountInfo<'info>)> {
    let a_is_token_0 = {
        let pool = accounts.pool_state.load()?;
        check_pool(&accounts.vault_state, &pool)?;
        pool.token_mint_0 == accounts.vault_state.token_mint
    };
    let a = accounts.vault_token_account.to_account_info();
    let b = accounts.vault_token_account_b.to_account_info();
    Ok(if a_is_token_0 { (a, b) } else { (b, a) })
}

/// CPI decrease_liquidity_v2: withdraw `liquidity` from the position + all accrued fees.
/// liquidity = 0 → fees only.
fn decrease_liquidity<'info>(
    accounts: &VaultPosition<'info>,
    remaining: &[AccountInfo<'info>],
    liquidity: u128,
    amount_0_min: u64,
    amount_1_min: u64,
) -> Result<()> {
    let (recipient_0, recipient_1) = pool_ordered(accounts)?;
    let cpi_accounts = cpi::accounts::DecreaseLiquidityV2 {
        nft_owner: accounts.vault_state.to_account_info(),
        nft_account: accounts.position_nft_account.to_account_info(),
        personal_position: accounts.personal_position.to_account_info(),
        pool_state: accounts.pool_state.to_account_info(),
        protocol_position: accounts.personal_position.to_account_info(), // deprecated Raydium field
        token_vault_0: accounts.token_vault_0.to_account_info(),
        token_vault_1: accounts.token_vault_1.to_account_info(),
        tick_array_lower: accounts.tick_array_lower.to_account_info(),
        tick_array_upper: accounts.tick_array_upper.to_account_info(),
        recipient_token_account_0: recipient_0,
        recipient_token_account_1: recipient_1,
        token_program: accounts.token_program.to_account_info(),
        token_program_2022: accounts.token_program_2022.to_account_info(),
        memo_program: accounts.memo_program.to_account_info(),
        vault_0_mint: accounts.vault_0_mint.to_account_info(),
        vault_1_mint: accounts.vault_1_mint.to_account_info(),
    };
    vault_signer!(signer, accounts.vault_state);
    let cpi_ctx = CpiContext::new_with_signer(accounts.clmm_program.to_account_info(), cpi_accounts, signer)
        .with_remaining_accounts(remaining.to_vec());

    cpi::decrease_liquidity_v2(cpi_ctx, liquidity, amount_0_min, amount_1_min)
}

/// Extra task 9: collect fees (decrease with liquidity 0) and add what arrived to total_fees_a/b.
/// Returns (fees in TOKEN_A, fees in TOKEN_B).
fn collect_and_count<'info>(accounts: &mut VaultPosition<'info>, remaining: &[AccountInfo<'info>]) -> Result<(u64, u64)> {
    let a_before = accounts.vault_token_account.amount;
    let b_before = accounts.vault_token_account_b.amount;

    decrease_liquidity(accounts, remaining, 0, 0, 0)?;

    accounts.vault_token_account.reload()?;
    accounts.vault_token_account_b.reload()?;
    let fee_a = accounts.vault_token_account.amount.saturating_sub(a_before);
    let fee_b = accounts.vault_token_account_b.amount.saturating_sub(b_before);

    let vault = &mut accounts.vault_state;
    vault.total_fees_a = vault.total_fees_a.checked_add(fee_a).ok_or(VaultError::MathOverflow)?;
    vault.total_fees_b = vault.total_fees_b.checked_add(fee_b).ok_or(VaultError::MathOverflow)?;
    Ok((fee_a, fee_b))
}

/// Extra task 8: add vault tokens to the open position.
/// Unlike open_position, Raydium pulls the tokens from the NFT owner — the vault PDA itself,
/// which signs the CPI, so no temporary approval is needed. Amounts are in POOL order.
pub fn increase_liquidity<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultPosition<'info>>,
    amount_0_max: u64,
    amount_1_max: u64,
    base_0: bool,
) -> Result<()> {
    require!(amount_0_max > 0 || amount_1_max > 0, VaultError::ZeroAmount);
    let liquidity_before = ctx.accounts.personal_position.liquidity;

    let (account_0, account_1) = pool_ordered(&ctx.accounts)?;
    let cpi_accounts = cpi::accounts::IncreaseLiquidityV2 {
        nft_owner: ctx.accounts.vault_state.to_account_info(),
        nft_account: ctx.accounts.position_nft_account.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        protocol_position: ctx.accounts.personal_position.to_account_info(), // deprecated Raydium field
        personal_position: ctx.accounts.personal_position.to_account_info(),
        tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.tick_array_upper.to_account_info(),
        token_account_0: account_0,
        token_account_1: account_1,
        token_vault_0: ctx.accounts.token_vault_0.to_account_info(),
        token_vault_1: ctx.accounts.token_vault_1.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        vault_0_mint: ctx.accounts.vault_0_mint.to_account_info(),
        vault_1_mint: ctx.accounts.vault_1_mint.to_account_info(),
    };
    vault_signer!(signer, ctx.accounts.vault_state);
    let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.clmm_program.to_account_info(), cpi_accounts, signer)
        .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    cpi::increase_liquidity_v2(cpi_ctx, 0, amount_0_max, amount_1_max, Some(base_0))?;

    ctx.accounts.personal_position.reload()?;
    msg!("Liquidity increased: {} -> {}", liquidity_before, ctx.accounts.personal_position.liquidity);
    Ok(())
}

/// Collect the position fees into the vault; liquidity stays in the pool.
pub fn collect_fees<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultPosition<'info>>,
) -> Result<()> {
    let (fee_a, fee_b) = collect_and_count(ctx.accounts, ctx.remaining_accounts)?;
    msg!("Fees collected: A +{}, B +{}", fee_a, fee_b);
    Ok(())
}

/// Withdraw all liquidity and fees, burn the NFT and close the position.
/// Fees are collected (and counted) first, so `amount_0_min` / `amount_1_min` (POOL order)
/// protect only the withdrawn liquidity.
pub fn close_position<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, VaultPosition<'info>>,
    amount_0_min: u64,
    amount_1_min: u64,
) -> Result<()> {
    let (fee_a, fee_b) = collect_and_count(ctx.accounts, ctx.remaining_accounts)?;

    let liquidity = ctx.accounts.personal_position.liquidity;
    if liquidity > 0 {
        decrease_liquidity(ctx.accounts, ctx.remaining_accounts, liquidity, amount_0_min, amount_1_min)?;
    }

    let close_accounts = cpi::accounts::ClosePosition {
        nft_owner: ctx.accounts.vault_state.to_account_info(), // personal_position rent returns here
        position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
        position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
        personal_position: ctx.accounts.personal_position.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        // The NFT is Token-2022. The CPI struct types this field as Token, but it is just an
        // AccountInfo: Raydium checks the program against the NFT mint itself
        token_program: ctx.accounts.token_program_2022.to_account_info(),
    };
    vault_signer!(signer, ctx.accounts.vault_state);
    cpi::close_position(CpiContext::new_with_signer(
        ctx.accounts.clmm_program.to_account_info(),
        close_accounts,
        signer,
    ))?;

    ctx.accounts.vault_state.position_nft_mint = Pubkey::default();

    // Raydium returned the rent of personal_position and the NFT account to the vault PDA (nft_owner).
    // The admin paid it in open_position → give back everything above the vault_state minimum.
    // Lamports can be debited directly: vault_state is owned by this program.
    let vault_info = ctx.accounts.vault_state.to_account_info();
    let min_balance = Rent::get()?.minimum_balance(vault_info.data_len());
    let extra = vault_info.lamports().saturating_sub(min_balance);
    if extra > 0 {
        **vault_info.try_borrow_mut_lamports()? -= extra;
        **ctx.accounts.admin.to_account_info().try_borrow_mut_lamports()? += extra;
    }

    msg!(
        "Position closed: liquidity={}, fees A +{} B +{}, rent returned to admin={}",
        liquidity,
        fee_a,
        fee_b,
        extra
    );
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// sync_vault
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct SyncVault<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ VaultError::Unauthorized,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(address = vault_state.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(address = vault_state.vault_token_account_b @ VaultError::PairNotSet)]
    pub vault_token_account_b: Account<'info, TokenAccount>,
}

/// Back to normal mode. Allowed only when everything is TOKEN_A again: no position, TOKEN_B = 0.
/// `total_tokens` is taken from the real balance, so profit (fees) or loss
/// (swap fee, slippage) is shared by all shares.
pub fn sync_vault(ctx: Context<SyncVault>) -> Result<()> {
    require!(ctx.accounts.vault_state.position_nft_mint == Pubkey::default(), VaultError::PositionOpen);
    require!(ctx.accounts.vault_token_account_b.amount == 0, VaultError::TokenBNotZero);

    let vault = &mut ctx.accounts.vault_state;
    let before = vault.total_tokens;
    // With no shares outstanding there is nobody to credit: leftover TOKEN_A stays untracked
    // surplus (the W9 policy), otherwise quote() would see tokens without shares and block deposits.
    vault.total_tokens = if vault.total_shares == 0 { 0 } else { ctx.accounts.vault_token_account.amount };
    vault.in_market = false;

    msg!("Vault synced: total_tokens {} -> {}", before, vault.total_tokens);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_limit_is_half_of_token_a() {
        assert_eq!(max_swap_a(1_000_000_000), 500_000_000);
        assert_eq!(max_swap_a(3), 1); // rounds down
        assert_eq!(max_swap_a(1), 0); // nothing can be sold from 1 unit
        assert_eq!(max_swap_a(u64::MAX), u64::MAX / 2);
    }
}
