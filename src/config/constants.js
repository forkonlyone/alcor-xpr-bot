// Proton chain constants for Alcor Exchange

export const PROTON_CHAIN_ID = '384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0';

export const DEFAULT_RPC_ENDPOINTS = [
  'https://proton.eosusa.io',
  'https://api.protonnz.com',
  'https://proton.cryptolions.io',
  'https://proton.eoscafeblock.com',
  'https://proton.protonuk.io',
];

export const ALCOR_API_URL = 'https://proton.alcor.exchange/api/v2';

// Alcor swap contract on Proton
export const ALCOR_SWAP_CONTRACT = 'swap.alcor';

// XPR token info
export const XPR_TOKEN = {
  contract: 'eosio.token',
  symbol: 'XPR',
  decimals: 4,
};

// Fee tiers in Alcor V3 pools (in 1/1_000_000 units)
// fee=500 → 0.05%, fee=3000 → 0.3%, fee=10000 → 1%
export const FEE_TIERS = {
  500: 0.0005,
  3000: 0.003,
  10000: 0.01,
};

// Q64.64 fixed-point constant
export const Q64 = BigInt(2) ** BigInt(64);
export const Q128 = BigInt(2) ** BigInt(128);
