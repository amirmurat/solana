use anchor_lang::prelude::*;

declare_id!("53LECgzYssC16Gib3H8NByJpDCnRjE3UyGzt3QW1aZxJ");

#[program]
pub mod w6_profile {
    use super::*;

    pub fn initialize_profile(ctx: Context<InitializeProfile>, name: String, bio: String) -> Result<()> {
        validate(&name, &bio)?;
        let profile = &mut ctx.accounts.profile;
        profile.owner = ctx.accounts.owner.key();
        profile.name = name;
        profile.bio = bio;
        profile.bump = ctx.bumps.profile;
        Ok(())
    }

    pub fn update_profile(ctx: Context<UpdateProfile>, name: String, bio: String) -> Result<()> {
        validate(&name, &bio)?;
        ctx.accounts.profile.name = name;
        ctx.accounts.profile.bio = bio;
        Ok(())
    }
}

fn validate(name: &str, bio: &str) -> Result<()> {
    require!(name.len() <= 32, ProfileError::NameTooLong);
    require!(bio.len() <= 256, ProfileError::BioTooLong);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeProfile<'info> {
    #[account(init, payer = owner, space = 8 + Profile::INIT_SPACE,
        seeds = [b"profile", owner.key().as_ref()], bump)]
    pub profile: Account<'info, Profile>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProfile<'info> {
    #[account(mut, has_one = owner @ ProfileError::Unauthorized,
        seeds = [b"profile", profile.owner.as_ref()], bump = profile.bump)]
    pub profile: Account<'info, Profile>,
    pub owner: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub owner: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(256)]
    pub bio: String,
    pub bump: u8,
}

#[error_code]
pub enum ProfileError {
    #[msg("Only the profile owner can update it")]
    Unauthorized,
    #[msg("Name exceeds 32 UTF-8 bytes")]
    NameTooLong,
    #[msg("Bio exceeds 256 UTF-8 bytes")]
    BioTooLong,
}
