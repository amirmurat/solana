use anchor_lang::prelude::*;
use anchor_spl::{token::{self, Approve, Revoke, Token, TokenAccount, Mint}, token_2022::Token2022, memo::Memo, associated_token::AssociatedToken, token_interface::{Mint as InterfaceMint, TokenAccount as InterfaceTokenAccount}};
use raydium_clmm_cpi::{cpi, states::{AmmConfig, PoolState, ObservationState, PersonalPositionState, TickArrayState}};
use crate::{VaultState,VaultError};

fn pair(v:&VaultState,p:&PoolState)->Result<bool>{
    let a=p.token_mint_0; let b=p.token_mint_1;
    let forward=a==v.token_mint && b==v.secondary_mint;
    require!(forward || (b==v.token_mint && a==v.secondary_mint),VaultError::WrongPool);
    Ok(forward)
}

pub fn configure(ctx:Context<ConfigurePool>)->Result<()>{
    let v=&mut ctx.accounts.vault_state;
    require!(v.pool==Pubkey::default() && !v.strategy_locked,VaultError::InvalidStrategyState);
    require!(ctx.accounts.secondary_mint.key()!=v.token_mint,VaultError::WrongPool);
    v.secondary_mint=ctx.accounts.secondary_mint.key();v.secondary_account=ctx.accounts.secondary_account.key();
    pair(v,&*ctx.accounts.pool_state.load()?)?;
    v.pool=ctx.accounts.pool_state.key();Ok(())
}

pub fn start(ctx:Context<StrategyControl>)->Result<()>{
    let v=&mut ctx.accounts.vault_state;
    require!(!v.strategy_locked && v.position_mint==Pubkey::default() && v.total_shares>0,VaultError::InvalidStrategyState);
    require!(ctx.accounts.secondary_account.amount==0,VaultError::InvalidStrategyState);
    require!(ctx.accounts.vault_token_account.amount==v.total_tokens,VaultError::InvalidAccounting);
    v.strategy_locked=true;Ok(())
}

pub fn settle(ctx:Context<StrategyControl>)->Result<()>{
    let v=&mut ctx.accounts.vault_state;
    require!(v.strategy_locked && v.position_mint==Pubkey::default(),VaultError::InvalidStrategyState);
    require!(ctx.accounts.secondary_account.amount==0 && ctx.accounts.vault_token_account.amount>0,VaultError::InvalidStrategyState);
    // Realised NAV in the base token; never value a live LP position from the cash balance.
    v.total_tokens=ctx.accounts.vault_token_account.amount;v.strategy_locked=false;Ok(())
}

pub fn swap<'a,'b,'c:'info,'info>(ctx:Context<'a,'b,'c,'info,SwapTokens<'info>>,amount:u64,min_out:u64,limit:u128,forward:bool)->Result<()>{
    require!(amount>0 && min_out>0,VaultError::ZeroAmount);
    let v=&ctx.accounts.vault_state;require!(v.strategy_locked,VaultError::InvalidStrategyState);
    let pool=ctx.accounts.pool_state.load()?;let base_is_0=pair(v,&pool)?;
    let in_0=(base_is_0 && forward)||(!base_is_0&&!forward);
    let expected_in=if in_0 {pool.token_vault_0}else{pool.token_vault_1};
    let expected_out=if in_0 {pool.token_vault_1}else{pool.token_vault_0};
    require!(ctx.accounts.input_vault.key()==expected_in && ctx.accounts.output_vault.key()==expected_out,VaultError::WrongPool);drop(pool);
    let (input,output)=if forward {(ctx.accounts.vault_token_account.to_account_info(),ctx.accounts.secondary_account.to_account_info())}else{(ctx.accounts.secondary_account.to_account_info(),ctx.accounts.vault_token_account.to_account_info())};
    let input_mint=if forward{v.token_mint}else{v.secondary_mint};let output_mint=if forward{v.secondary_mint}else{v.token_mint};
    require!(ctx.accounts.input_vault_mint.key()==input_mint && ctx.accounts.output_vault_mint.key()==output_mint,VaultError::WrongPool);
    let bump=[v.bump];let seeds:&[&[u8]]=&[b"vault",v.token_mint.as_ref(),&bump];
    cpi::swap_v2(CpiContext::new_with_signer(ctx.accounts.clmm_program.to_account_info(),cpi::accounts::SwapSingleV2{
        payer:v.to_account_info(),amm_config:ctx.accounts.amm_config.to_account_info(),pool_state:ctx.accounts.pool_state.to_account_info(),input_token_account:input,output_token_account:output,input_vault:ctx.accounts.input_vault.to_account_info(),output_vault:ctx.accounts.output_vault.to_account_info(),observation_state:ctx.accounts.observation_state.to_account_info(),token_program:ctx.accounts.token_program.to_account_info(),token_program_2022:ctx.accounts.token_program_2022.to_account_info(),memo_program:ctx.accounts.memo_program.to_account_info(),input_vault_mint:ctx.accounts.input_vault_mint.to_account_info(),output_vault_mint:ctx.accounts.output_vault_mint.to_account_info()
    },&[seeds]).with_remaining_accounts(ctx.remaining_accounts.to_vec()),amount,min_out,limit,true)?;Ok(())
}

pub fn open<'a,'b,'c:'info,'info>(ctx:Context<'a,'b,'c,'info,OpenClmmPosition<'info>>,lower:i32,upper:i32,array_lower:i32,array_upper:i32,liquidity:u128,max_0:u64,max_1:u64)->Result<()>{
    let v=&ctx.accounts.vault_state;
    require!(v.strategy_locked && v.position_mint==Pubkey::default(),VaultError::InvalidStrategyState);
    let pool=ctx.accounts.pool_state.load()?;let base_is_0=pair(v,&pool)?;let spacing=pool.tick_spacing as i32;
    require!(spacing>0 && liquidity>0 && lower<upper && lower%spacing==0 && upper%spacing==0,VaultError::InvalidRange);
    require!(max_0>0 && max_1>0,VaultError::ZeroAmount);
    require!(ctx.accounts.token_vault_0.key()==pool.token_vault_0 && ctx.accounts.token_vault_1.key()==pool.token_vault_1,VaultError::WrongPool);
    require!(ctx.accounts.vault_0_mint.key()==pool.token_mint_0 && ctx.accounts.vault_1_mint.key()==pool.token_mint_1,VaultError::WrongPool);drop(pool);
    let bump=[v.bump];let seeds:&[&[u8]]=&[b"vault",v.token_mint.as_ref(),&bump];
    // Grant a bounded delegate only inside this atomic instruction; revoke after the CPI.
    for (acct,amount) in [(&ctx.accounts.vault_token_account,if base_is_0{max_0}else{max_1}),(&ctx.accounts.secondary_account,if base_is_0{max_1}else{max_0})]{
        token::approve(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),Approve{to:acct.to_account_info(),delegate:ctx.accounts.admin.to_account_info(),authority:v.to_account_info()},&[seeds]),amount)?;
    }
    let (a,b)=if base_is_0{(ctx.accounts.vault_token_account.to_account_info(),ctx.accounts.secondary_account.to_account_info())}else{(ctx.accounts.secondary_account.to_account_info(),ctx.accounts.vault_token_account.to_account_info())};
    cpi::open_position_with_token22_nft(CpiContext::new_with_signer(ctx.accounts.clmm_program.to_account_info(),cpi::accounts::OpenPositionWithToken22Nft{
        payer:ctx.accounts.admin.to_account_info(),position_nft_owner:v.to_account_info(),position_nft_mint:ctx.accounts.position_nft_mint.to_account_info(),position_nft_account:ctx.accounts.position_nft_account.to_account_info(),pool_state:ctx.accounts.pool_state.to_account_info(),protocol_position:ctx.accounts.personal_position.to_account_info(),tick_array_lower:ctx.accounts.tick_array_lower.to_account_info(),tick_array_upper:ctx.accounts.tick_array_upper.to_account_info(),personal_position:ctx.accounts.personal_position.to_account_info(),token_account_0:a,token_account_1:b,token_vault_0:ctx.accounts.token_vault_0.to_account_info(),token_vault_1:ctx.accounts.token_vault_1.to_account_info(),rent:ctx.accounts.rent.to_account_info(),system_program:ctx.accounts.system_program.to_account_info(),token_program:ctx.accounts.token_program.to_account_info(),associated_token_program:ctx.accounts.associated_token_program.to_account_info(),token_program_2022:ctx.accounts.token_program_2022.to_account_info(),vault_0_mint:ctx.accounts.vault_0_mint.to_account_info(),vault_1_mint:ctx.accounts.vault_1_mint.to_account_info()
    },&[seeds]).with_remaining_accounts(ctx.remaining_accounts.to_vec()),lower,upper,array_lower,array_upper,liquidity,max_0,max_1,false,None)?;
    for acct in [&ctx.accounts.vault_token_account,&ctx.accounts.secondary_account]{token::revoke(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),Revoke{source:acct.to_account_info(),authority:v.to_account_info()},&[seeds]))?;}
    ctx.accounts.vault_state.position_mint=ctx.accounts.position_nft_mint.key();Ok(())
}

pub fn manage<'a,'b,'c:'info,'info>(ctx:Context<'a,'b,'c,'info,ManageClmmPosition<'info>>,min_0:u64,min_1:u64,close:bool)->Result<()>{
    let v=&ctx.accounts.vault_state;require!(v.strategy_locked && v.position_mint==ctx.accounts.position_nft_mint.key(),VaultError::InvalidStrategyState);
    let pool=ctx.accounts.pool_state.load()?;let base_is_0=pair(v,&pool)?;
    require!(ctx.accounts.token_vault_0.key()==pool.token_vault_0 && ctx.accounts.token_vault_1.key()==pool.token_vault_1,VaultError::WrongPool);
    require!(ctx.accounts.vault_0_mint.key()==pool.token_mint_0 && ctx.accounts.vault_1_mint.key()==pool.token_mint_1,VaultError::WrongPool);drop(pool);
    let bump=[v.bump];let seeds:&[&[u8]]=&[b"vault",v.token_mint.as_ref(),&bump];
    let (a,b)=if base_is_0{(ctx.accounts.vault_token_account.to_account_info(),ctx.accounts.secondary_account.to_account_info())}else{(ctx.accounts.secondary_account.to_account_info(),ctx.accounts.vault_token_account.to_account_info())};
    let liquidity=if close{ctx.accounts.personal_position.liquidity}else{0};
    cpi::decrease_liquidity_v2(CpiContext::new_with_signer(ctx.accounts.clmm_program.to_account_info(),cpi::accounts::DecreaseLiquidityV2{
        nft_owner:v.to_account_info(),nft_account:ctx.accounts.position_nft_account.to_account_info(),personal_position:ctx.accounts.personal_position.to_account_info(),pool_state:ctx.accounts.pool_state.to_account_info(),protocol_position:ctx.accounts.personal_position.to_account_info(),token_vault_0:ctx.accounts.token_vault_0.to_account_info(),token_vault_1:ctx.accounts.token_vault_1.to_account_info(),tick_array_lower:ctx.accounts.tick_array_lower.to_account_info(),tick_array_upper:ctx.accounts.tick_array_upper.to_account_info(),recipient_token_account_0:a,recipient_token_account_1:b,token_program:ctx.accounts.token_program.to_account_info(),token_program_2022:ctx.accounts.token_program_2022.to_account_info(),memo_program:ctx.accounts.memo_program.to_account_info(),vault_0_mint:ctx.accounts.vault_0_mint.to_account_info(),vault_1_mint:ctx.accounts.vault_1_mint.to_account_info()
    },&[seeds]).with_remaining_accounts(ctx.remaining_accounts.to_vec()),liquidity,min_0,min_1)?;
    if close {cpi::close_position(CpiContext::new_with_signer(ctx.accounts.clmm_program.to_account_info(),cpi::accounts::ClosePosition{nft_owner:v.to_account_info(),position_nft_mint:ctx.accounts.position_nft_mint.to_account_info(),position_nft_account:ctx.accounts.position_nft_account.to_account_info(),personal_position:ctx.accounts.personal_position.to_account_info(),system_program:ctx.accounts.system_program.to_account_info(),token_program:ctx.accounts.token_program_2022.to_account_info()},&[seeds]))?;ctx.accounts.vault_state.position_mint=Pubkey::default();}
    Ok(())
}

#[derive(Accounts)]
pub struct ConfigurePool<'info>{
    #[account(mut,seeds=[b"vault",vault_state.token_mint.as_ref()],bump=vault_state.bump,has_one=admin @ VaultError::Unauthorized)] pub vault_state:Box<Account<'info,VaultState>>,
    pub secondary_mint:Account<'info,Mint>,
    #[account(init,payer=admin,seeds=[b"secondary",vault_state.key().as_ref()],bump,token::mint=secondary_mint,token::authority=vault_state)] pub secondary_account:Account<'info,TokenAccount>,
    pub pool_state:AccountLoader<'info,PoolState>,
    #[account(mut)] pub admin:Signer<'info>,pub token_program:Program<'info,Token>,pub system_program:Program<'info,System>,
}
#[derive(Accounts)]
pub struct StrategyControl<'info>{
    #[account(mut,seeds=[b"vault",vault_state.token_mint.as_ref()],bump=vault_state.bump,has_one=admin @ VaultError::Unauthorized,has_one=vault_token_account,has_one=secondary_account)] pub vault_state:Box<Account<'info,VaultState>>,
    #[account(mut,token::mint=vault_state.token_mint,token::authority=vault_state)] pub vault_token_account:Box<Account<'info,TokenAccount>>,
    #[account(mut,token::mint=vault_state.secondary_mint,token::authority=vault_state)] pub secondary_account:Box<Account<'info,TokenAccount>>,
pub admin:Signer<'info>,
}
#[derive(Accounts)]
pub struct SwapTokens<'info>{
    #[account(mut,seeds=[b"vault",vault_state.token_mint.as_ref()],bump=vault_state.bump,has_one=admin @ VaultError::Unauthorized,has_one=vault_token_account,has_one=secondary_account)] pub vault_state:Box<Account<'info,VaultState>>,
    #[account(mut,token::mint=vault_state.token_mint,token::authority=vault_state)] pub vault_token_account:Box<Account<'info,TokenAccount>>,
    #[account(mut,token::mint=vault_state.secondary_mint,token::authority=vault_state)] pub secondary_account:Box<Account<'info,TokenAccount>>,
    #[account(mut,address=vault_state.pool)] pub pool_state:AccountLoader<'info,PoolState>,
    #[account(address=pool_state.load()?.amm_config)] pub amm_config:Box<Account<'info,AmmConfig>>,
    #[account(mut)] pub input_vault:Box<Account<'info,TokenAccount>>,
    #[account(mut)] pub output_vault:Box<Account<'info,TokenAccount>>,
    #[account(mut,address=pool_state.load()?.observation_key)] pub observation_state:AccountLoader<'info,ObservationState>,
    pub input_vault_mint:Account<'info,Mint>,pub output_vault_mint:Account<'info,Mint>,pub admin:Signer<'info>,
    /// CHECK: fixed official Raydium Devnet executable, not a caller-selected program.
    #[account(address=raydium_clmm_cpi::id(),executable)] pub clmm_program:UncheckedAccount<'info>,
    pub token_program:Program<'info,Token>,pub token_program_2022:Program<'info,Token2022>,
    pub memo_program:Program<'info,Memo>,
}
#[derive(Accounts)]
pub struct OpenClmmPosition<'info>{
    #[account(mut,seeds=[b"vault",vault_state.token_mint.as_ref()],bump=vault_state.bump,has_one=admin @ VaultError::Unauthorized,has_one=vault_token_account,has_one=secondary_account)] pub vault_state:Box<Account<'info,VaultState>>,
    #[account(mut,token::mint=vault_state.token_mint,token::authority=vault_state)] pub vault_token_account:Box<Account<'info,TokenAccount>>,
    #[account(mut,token::mint=vault_state.secondary_mint,token::authority=vault_state)] pub secondary_account:Box<Account<'info,TokenAccount>>,
    #[account(mut,address=vault_state.pool)] pub pool_state:AccountLoader<'info,PoolState>,
    #[account(mut)] pub position_nft_mint:Signer<'info>,
    /// CHECK: derived and created by Raydium CPI, assigned to the vault PDA.
    #[account(mut)] pub position_nft_account:UncheckedAccount<'info>,
    /// CHECK: derived and created by Raydium CPI from the NFT mint.
    #[account(mut)] pub personal_position:UncheckedAccount<'info>,
    /// CHECK: Raydium validates PDA, index and pool on creation.
    #[account(mut)] pub tick_array_lower:UncheckedAccount<'info>,
    /// CHECK: Raydium validates PDA, index and pool on creation.
    #[account(mut)] pub tick_array_upper:UncheckedAccount<'info>,
    #[account(mut)] pub token_vault_0:Box<Account<'info,TokenAccount>>,
    #[account(mut)] pub token_vault_1:Box<Account<'info,TokenAccount>>,
    pub vault_0_mint:Account<'info,Mint>,pub vault_1_mint:Account<'info,Mint>,
    #[account(mut)] pub admin:Signer<'info>,
    /// CHECK: fixed official Raydium Devnet executable, not a caller-selected program.
    #[account(address=raydium_clmm_cpi::id(),executable)] pub clmm_program:UncheckedAccount<'info>,
    pub token_program:Program<'info,Token>,pub token_program_2022:Program<'info,Token2022>,
    pub associated_token_program:Program<'info,AssociatedToken>,pub system_program:Program<'info,System>,pub rent:Sysvar<'info,Rent>,
}
#[derive(Accounts)]
pub struct ManageClmmPosition<'info>{
    #[account(mut,seeds=[b"vault",vault_state.token_mint.as_ref()],bump=vault_state.bump,has_one=admin @ VaultError::Unauthorized,has_one=vault_token_account,has_one=secondary_account)] pub vault_state:Box<Account<'info,VaultState>>,
    #[account(mut,token::mint=vault_state.token_mint,token::authority=vault_state)] pub vault_token_account:Box<Account<'info,TokenAccount>>,
    #[account(mut,token::mint=vault_state.secondary_mint,token::authority=vault_state)] pub secondary_account:Box<Account<'info,TokenAccount>>,
    #[account(mut,address=vault_state.pool)] pub pool_state:AccountLoader<'info,PoolState>,
    #[account(mut,address=vault_state.position_mint)] pub position_nft_mint:Box<InterfaceAccount<'info,InterfaceMint>>,
    #[account(mut,token::mint=position_nft_mint,token::authority=vault_state,constraint=position_nft_account.amount==1 @ VaultError::WrongPool)] pub position_nft_account:Box<InterfaceAccount<'info,InterfaceTokenAccount>>,
    #[account(mut,constraint=personal_position.pool_id==pool_state.key() @ VaultError::WrongPool,constraint=personal_position.nft_mint==position_nft_mint.key() @ VaultError::WrongPool)] pub personal_position:Box<Account<'info,PersonalPositionState>>,
    #[account(mut,constraint=tick_array_lower.load()?.pool_id==pool_state.key() @ VaultError::WrongPool)] pub tick_array_lower:AccountLoader<'info,TickArrayState>,
    #[account(mut,constraint=tick_array_upper.load()?.pool_id==pool_state.key() @ VaultError::WrongPool)] pub tick_array_upper:AccountLoader<'info,TickArrayState>,
    #[account(mut)] pub token_vault_0:Box<Account<'info,TokenAccount>>,
    #[account(mut)] pub token_vault_1:Box<Account<'info,TokenAccount>>,
    pub vault_0_mint:Account<'info,Mint>,pub vault_1_mint:Account<'info,Mint>,
    #[account(mut)] pub admin:Signer<'info>,
    /// CHECK: fixed official Raydium Devnet executable, not a caller-selected program.
    #[account(address=raydium_clmm_cpi::id(),executable)] pub clmm_program:UncheckedAccount<'info>,
    pub token_program:Program<'info,Token>,pub token_program_2022:Program<'info,Token2022>,
    pub memo_program:Program<'info,Memo>,pub system_program:Program<'info,System>,
}
