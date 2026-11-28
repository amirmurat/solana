// Какие кнопки выключить и почему — те же условия, что require!() в lib.rs.
//   deposit:          !in_market && !paused
//   withdraw(_all):   !in_market            (на паузе вывод разрешён)
//   create_user_card: !paused
export interface VaultFlags {
  paused: boolean;
  inMarket: boolean;
}

export interface Blocked {
  deposit?: string;
  withdraw?: string;
  createCard?: string;
}

const IN_MARKET = "Деньги vault сейчас в рынке (swap или позиция Raydium). Откроется после sync_vault.";
const PAUSED_DEPOSIT = "Vault на паузе: админ выключил внесение. Вывод работает.";
const PAUSED_CARD = "Vault на паузе: новые карточки не создаются.";

export function blockedActions(v: VaultFlags): Blocked {
  return {
    deposit: v.inMarket ? IN_MARKET : v.paused ? PAUSED_DEPOSIT : undefined,
    withdraw: v.inMarket ? IN_MARKET : undefined,
    createCard: v.paused ? PAUSED_CARD : undefined,
  };
}
