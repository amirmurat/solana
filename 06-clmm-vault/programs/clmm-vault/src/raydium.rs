//! Weeks 12–13: the vault works with Raydium CLMM through CPI.
//!
//!   add_pair_token — set the second token of the pair (TOKEN_B of the pool)
//!   swap           — week 12: swap vault tokens through the pool
//!   sync_vault     — back to normal mode once everything is TOKEN_A again
//!
//! While funds are "in the market" (TOKEN_B on the vault), deposit and withdraw are
//! blocked: `total_tokens` does not reflect the real value of the vault then.

use anchor_lang::prelude::*;
use anchor_spl::memo::Memo;
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::token_2022::Token2022;
use raydium_clmm_cpi::{cpi, states::PoolState};

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

/// Back to normal mode. Allowed only when everything is TOKEN_A again (TOKEN_B = 0).
/// `total_tokens` is taken from the real balance, so profit (fees) or loss
/// (swap fee, slippage) is shared by all shares.
pub fn sync_vault(ctx: Context<SyncVault>) -> Result<()> {
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
