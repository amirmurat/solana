use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod strategy;
use strategy::*;

declare_id!("E9V9HqbFvQYYUZo4FpAnX1Eh3bP9YAxDnoSh3ZEGegmM");

#[program]
pub mod raydium_vault {
    use super::*;

    /// Создать vault для конкретного SPL-токена.
    /// Создаёт: VaultState PDA, vault_token_account PDA, share_mint PDA.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.admin = ctx.accounts.admin.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.bump = ctx.bumps.vault_state;
        vault.paused = false;
        vault.fee_wallet = ctx.accounts.fee_wallet.key();
        vault.min_deposit = 10u64
            .checked_pow(ctx.accounts.token_mint.decimals as u32)
            .ok_or(VaultError::MathOverflow)?;

        msg!("Vault initialized for mint: {}", vault.token_mint);
        Ok(())
    }

    /// Gross amount is debited once: 1% floor fee + net deposit.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let v = &ctx.accounts.vault_state;
        require!(!v.strategy_locked, VaultError::StrategyInProgress);
        require!(!v.paused, VaultError::VaultPaused);
        require!(amount > 0, VaultError::ZeroAmount);
        require!(amount >= v.min_deposit, VaultError::BelowMinimum);
        // Direct transfers into the reserve do not alter the tracked share price.
        require!(
            ctx.accounts.vault_token_account.amount >= v.total_tokens,
            VaultError::InvalidAccounting
        );
        // Direct SPL burns outside withdraw are unsupported; reject divergent supply.
        require!(
            ctx.accounts.share_mint.supply == v.total_shares,
            VaultError::InvalidAccounting
        );
        let (fee, net, shares) = quote(amount, v.total_tokens, v.total_shares)?;
        let tokens_after = v
            .total_tokens
            .checked_add(net)
            .ok_or(VaultError::MathOverflow)?;
        let shares_after = v
            .total_shares
            .checked_add(shares)
            .ok_or(VaultError::MathOverflow)?;
        let card = &ctx.accounts.user_card;
        let deposited = card
            .deposited
            .checked_add(net)
            .ok_or(VaultError::MathOverflow)?;
        let issued = card
            .shares
            .checked_add(shares)
            .ok_or(VaultError::MathOverflow)?;
        for (destination, value) in [
            (ctx.accounts.fee_wallet.to_account_info(), fee),
            (ctx.accounts.vault_token_account.to_account_info(), net),
        ] {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_account.to_account_info(),
                        to: destination,
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                value,
            )?;
        }
        let mint_key = v.token_mint;
        let bump = [v.bump];
        let seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &bump];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_share_account.to_account_info(),
                    authority: v.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;
        let v = &mut ctx.accounts.vault_state;
        v.total_tokens = tokens_after;
        v.total_shares = shares_after;
        let card = &mut ctx.accounts.user_card;
        card.deposited = deposited;
        card.shares = issued;
        emit!(Deposited {
            user: ctx.accounts.user.key(),
            amount,
            fee,
            net,
            shares
        });
        Ok(())
    }

    /// Redeem circulating SPL shares, including shares received by transfer.
    /// Withdrawals stay available while deposits are paused.
    pub fn withdraw(ctx: Context<Withdraw>, shares_amount: u64, min_tokens_out: u64) -> Result<()> {
        let vault = &ctx.accounts.vault_state;
        require!(!vault.strategy_locked, VaultError::StrategyInProgress);
        require!(ctx.accounts.share_mint.supply == vault.total_shares, VaultError::InvalidAccounting);
        require!(ctx.accounts.vault_token_account.amount >= vault.total_tokens, VaultError::InvalidAccounting);
        require!(shares_amount <= ctx.accounts.user_share_account.amount, VaultError::InsufficientShares);
        let tokens_out = quote_withdraw(shares_amount, vault.total_tokens, vault.total_shares)?;
        require!(tokens_out >= min_tokens_out, VaultError::SlippageExceeded);
        let tokens_after = vault.total_tokens.checked_sub(tokens_out).ok_or(VaultError::MathOverflow)?;
        let shares_after = vault.total_shares.checked_sub(shares_amount).ok_or(VaultError::MathOverflow)?;
        token::burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
            mint: ctx.accounts.share_mint.to_account_info(),
            from: ctx.accounts.user_share_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        }), shares_amount)?;
        let mint_key = vault.token_mint;
        let bump = [vault.bump];
        let seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &bump];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: vault.to_account_info(),
        }, &[seeds]), tokens_out)?;
        let vault = &mut ctx.accounts.vault_state;
        vault.total_tokens = tokens_after;
        vault.total_shares = shares_after;
        emit!(Withdrawn {user: ctx.accounts.user.key(), shares: shares_amount, tokens: tokens_out});
        Ok(())
    }

    pub fn configure_pool(ctx: Context<ConfigurePool>) -> Result<()> { strategy::configure(ctx) }
    pub fn start_strategy(ctx: Context<StrategyControl>) -> Result<()> { strategy::start(ctx) }
    pub fn settle_strategy(ctx: Context<StrategyControl>) -> Result<()> { strategy::settle(ctx) }
    pub fn swap_tokens<'a,'b,'c:'info,'info>(ctx: Context<'a,'b,'c,'info,SwapTokens<'info>>, amount:u64, min_out:u64, sqrt_price_limit_x64:u128, base_to_secondary:bool) -> Result<()> {
        strategy::swap(ctx,amount,min_out,sqrt_price_limit_x64,base_to_secondary)
    }
    pub fn open_clmm_position<'a,'b,'c:'info,'info>(ctx: Context<'a,'b,'c,'info,OpenClmmPosition<'info>>, lower:i32, upper:i32, array_lower:i32, array_upper:i32, liquidity:u128, max_0:u64,max_1:u64) -> Result<()> {
        strategy::open(ctx,lower,upper,array_lower,array_upper,liquidity,max_0,max_1)
    }
    pub fn collect_clmm_fees<'a,'b,'c:'info,'info>(ctx: Context<'a,'b,'c,'info,ManageClmmPosition<'info>>) -> Result<()> { strategy::manage(ctx,0,0,false) }
    pub fn close_clmm_position<'a,'b,'c:'info,'info>(ctx: Context<'a,'b,'c,'info,ManageClmmPosition<'info>>, min_0:u64,min_1:u64) -> Result<()> { strategy::manage(ctx,min_0,min_1,true) }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.vault_state.paused = paused;
        Ok(())
    }

    pub fn close_user_card(_ctx: Context<CloseUserCard>) -> Result<()> {
        Ok(())
    }

    /// Создать личную «карточку» пользователя в vault.
    /// У каждого пользователя ровно одна карточка (PDA от vault + user).
    pub fn create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
        let card = &mut ctx.accounts.user_card;
        card.vault = ctx.accounts.vault_state.key();
        card.owner = ctx.accounts.user.key();
        card.bump = ctx.bumps.user_card;
        card.created_at = Clock::get()?.unix_timestamp;

        msg!("User card created for: {}", card.owner);
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// VaultState PDA — seeds: ["vault", token_mint]
    #[account(
        init,
        payer = admin,
        space = VaultState::LEN,
        seeds = [b"vault", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Token account, принадлежащий vault PDA
    #[account(
        init,
        payer = admin,
        token::mint = token_mint,
        token::authority = vault_state,
        seeds = [b"vault_tokens", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Mint для shares — выпускается vault PDA
    #[account(
        init,
        payer = admin,
        mint::decimals = token_mint.decimals,
        mint::authority = vault_state,
        seeds = [b"share_mint", token_mint.key().as_ref()],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    /// SPL-токен, который принимает vault
    pub token_mint: Account<'info, Mint>,

    /// Fixed fee destination: an underlying-token account owned by the admin.
    #[account(token::mint = token_mint, token::authority = admin)]
    pub fee_wallet: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateUserCard<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
        constraint = !vault_state.paused @ VaultError::VaultPaused,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// UserCard PDA — seeds: ["user_card", vault_state, user]
    #[account(
        init,
        payer = user,
        space = UserCard::LEN,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct VaultState {
    pub admin: Pubkey,               // 32
    pub token_mint: Pubkey,          // 32 — SPL-токен vault'а
    pub vault_token_account: Pubkey, // 32 — PDA для токенов
    pub share_mint: Pubkey,          // 32 — mint для shares
    pub bump: u8,                    // 1
    pub paused: bool,                // 1
    pub total_tokens: u64,
    pub total_shares: u64,
    pub fee_wallet: Pubkey,
    pub min_deposit: u64,
    pub pool: Pubkey,
    pub secondary_mint: Pubkey,
    pub secondary_account: Pubkey,
    pub position_mint: Pubkey,
    pub strategy_locked: bool,
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 32 + 8 + 32 * 4 + 1;
}

/// Карточка пользователя в vault.
#[account]
#[derive(Default)]
pub struct UserCard {
    pub vault: Pubkey,   // 32 — к какому vault относится
    pub owner: Pubkey,   // 32 — владелец карточки
    pub bump: u8,        // 1
    pub created_at: i64, // 8
    pub deposited: u64,  // cumulative NET deposits; not a redeemable balance
    pub shares: u64,     // cumulative shares issued; SPL balances may be transferred
}

impl UserCard {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 8 + 8 + 8;
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump, has_one = admin @ VaultError::Unauthorized)]
    pub vault_state: Account<'info, VaultState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseUserCard<'info> {
    #[account(seeds = [b"vault", vault_state.token_mint.as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut, close = user,
        seeds = [b"user_card", vault_state.key().as_ref(), user_card.owner.as_ref()],
        bump = user_card.bump,
        constraint = user_card.vault == vault_state.key() @ VaultError::WrongVault,
        constraint = user_card.owner == user.key() @ VaultError::Unauthorized,
        constraint = user_card.deposited == 0 && user_card.shares == 0 @ VaultError::CardHasDeposits)]
    pub user_card: Account<'info, UserCard>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[error_code]
pub enum VaultError {
    #[msg("Only the account owner or configured administrator may perform this action")]
    Unauthorized,
    #[msg("Vault is paused")]
    VaultPaused,
    #[msg("Card belongs to another vault")]
    WrongVault,
    #[msg("Amount must be nonzero")]
    ZeroAmount,
    #[msg("Minimum gross deposit is one whole underlying token")]
    BelowMinimum,
    #[msg("Deposit rounds to zero shares")]
    SharesTooSmall,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Inconsistent accounting or external share burn")]
    InvalidAccounting,
    #[msg("Cannot close a card with deposit history")]
    CardHasDeposits,
    #[msg("Source and destination accounts must differ")]
    AliasedAccount,
    #[msg("Vault has no circulating shares")] VaultEmpty,
    #[msg("Withdrawal rounds to zero tokens")] WithdrawTooSmall,
    #[msg("User or vault has fewer shares than requested")] InsufficientShares,
    #[msg("Quoted tokens are below the user minimum")] SlippageExceeded,
    #[msg("Settle the strategy in the base token before user operations")] StrategyInProgress,
    #[msg("Invalid pool, mint, reserve or position relationship")] WrongPool,
    #[msg("Invalid strategy lifecycle transition")] InvalidStrategyState,
    #[msg("Invalid tick range or liquidity")] InvalidRange,
}

/// Integer-only quote. Rounding is down, never issue unbacked fractional shares.
pub fn quote(amount: u64, total_tokens: u64, total_shares: u64) -> Result<(u64, u64, u64)> {
    require!(amount > 0, VaultError::ZeroAmount);
    let fee = amount / 100;
    let net = amount.checked_sub(fee).ok_or(VaultError::MathOverflow)?;
    require!(
        (total_tokens == 0) == (total_shares == 0),
        VaultError::InvalidAccounting
    );
    let shares = if total_shares == 0 {
        net
    } else {
        u64::try_from(
            (net as u128)
                .checked_mul(total_shares as u128)
                .and_then(|x| x.checked_div(total_tokens as u128))
                .ok_or(VaultError::MathOverflow)?,
        )
        .map_err(|_| error!(VaultError::MathOverflow))?
    };
    require!(shares > 0, VaultError::SharesTooSmall);
    Ok((fee, net, shares))
}

#[event]
pub struct Deposited {
    pub user: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub net: u64,
    pub shares: u64,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [b"vault", vault_state.token_mint.as_ref()], bump = vault_state.bump,
        has_one = vault_token_account, has_one = share_mint, has_one = fee_wallet)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut, seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump, constraint = user_card.owner == user.key() @ VaultError::Unauthorized,
        constraint = user_card.vault == vault_state.key() @ VaultError::WrongVault)]
    pub user_card: Account<'info, UserCard>,
    #[account(mut, seeds = [b"vault_tokens", vault_state.token_mint.as_ref()], bump,
        token::mint = vault_state.token_mint, token::authority = vault_state)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"share_mint", vault_state.token_mint.as_ref()], bump,
        mint::authority = vault_state)]
    pub share_mint: Account<'info, Mint>,
    #[account(mut, token::mint = vault_state.token_mint, token::authority = user,
        constraint = user_token_account.key() != fee_wallet.key() @ VaultError::AliasedAccount)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = share_mint, token::authority = user)]
    pub user_share_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vault_state.token_mint,
        constraint = fee_wallet.key() != vault_token_account.key() @ VaultError::AliasedAccount)]
    pub fee_wallet: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn three_users() {
        let mut tokens = 0;
        let mut shares = 0;
        for amount in [100_000_000, 50_000_000, 25_000_000] {
            let (fee, net, issued) = quote(amount, tokens, shares).unwrap();
            assert_eq!(fee, amount / 100);
            assert_eq!(net, issued);
            tokens += net;
            shares += issued;
        }
        assert_eq!((tokens, shares), (173_250_000, 173_250_000));
    }
    #[test]
    fn rounding() {
        assert_eq!(quote(101, 3, 2).unwrap(), (1, 100, 66));
    }
    #[test]
    fn zero_shares_rejected() {
        assert!(quote(1, 1000, 1).is_err());
    }
    #[test]
    fn inconsistent_state_rejected() {
        assert!(quote(100, 0, 1).is_err());
        assert!(quote(100, 1, 0).is_err());
    }
    #[test]
    fn zero_rejected() {
        assert!(quote(0, 0, 0).is_err());
    }
    #[test]
    fn large_product_uses_u128() {
        let (_, net, s) = quote(u64::MAX, u64::MAX, u64::MAX).unwrap();
        assert_eq!(net, s);
    }
    #[test]
    fn output_overflow_rejected() {
        assert!(quote(u64::MAX, 1, u64::MAX).is_err());
    }
    #[test]
    fn sizes() {
        assert_eq!(VaultState::LEN, 323);
        assert_eq!(UserCard::LEN, 97);
    }
}

/// Round down for partial withdrawals; full redemption takes the remaining tracked assets.
pub fn quote_withdraw(shares: u64, tokens: u64, supply: u64) -> Result<u64> {
    require!(shares > 0, VaultError::ZeroAmount);
    require!(supply > 0, VaultError::VaultEmpty);
    require!(shares <= supply, VaultError::InsufficientShares);
    require!(tokens > 0, VaultError::InvalidAccounting);
    let out = u64::try_from((shares as u128).checked_mul(tokens as u128)
        .and_then(|v| v.checked_div(supply as u128)).ok_or(VaultError::MathOverflow)?)
        .map_err(|_| error!(VaultError::MathOverflow))?;
    require!(out > 0, VaultError::WithdrawTooSmall);
    Ok(out)
}

#[event]
pub struct Withdrawn {pub user: Pubkey, pub shares: u64, pub tokens: u64}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"vault", vault_state.token_mint.as_ref()], bump = vault_state.bump,
        has_one = vault_token_account, has_one = share_mint)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut, seeds = [b"vault_tokens", vault_state.token_mint.as_ref()], bump,
        token::mint = vault_state.token_mint, token::authority = vault_state)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"share_mint", vault_state.token_mint.as_ref()], bump,
        mint::authority = vault_state)]
    pub share_mint: Account<'info, Mint>,
    #[account(mut, token::mint = vault_state.token_mint, token::authority = user)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = share_mint, token::authority = user)]
    pub user_share_account: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[cfg(test)]
mod withdraw_tests {
    use super::*;
    #[test] fn partial_rounding_and_last_redemption() {assert_eq!(quote_withdraw(1,10,3).unwrap(),3);assert_eq!(quote_withdraw(2,7,2).unwrap(),7);}
    #[test] fn rejects_zero_and_empty() {assert!(quote_withdraw(0,10,10).is_err());assert!(quote_withdraw(1,0,0).is_err());}
    #[test] fn rejects_excess_shares() {assert!(quote_withdraw(11,10,10).is_err());}
    #[test] fn rejects_dust_and_inconsistent_assets() {assert!(quote_withdraw(1,1,10).is_err());assert!(quote_withdraw(1,0,10).is_err());}
    #[test] fn large_product_safe() {assert_eq!(quote_withdraw(u64::MAX,u64::MAX,u64::MAX).unwrap(),u64::MAX);}
    #[test] fn three_users_exit() {let(mut t,mut s)=(173_250_000,173_250_000);for n in [99_000_000,49_500_000,24_750_000] {let out=quote_withdraw(n,t,s).unwrap();assert_eq!(out,n);t-=out;s-=n;}assert_eq!((t,s),(0,0));}
}
