import { Q64, Q128 } from '../config/constants.js';

/**
 * Calculate token price from sqrtPriceX64.
 * tokenA price in terms of tokenB:
 *   sqrtPriceX64^2 / 2^128 * 10^(precisionA - precisionB)
 */
export function calcPriceAinB(sqrtPriceX64, decimalsA, decimalsB) {
  const sqrtPrice = BigInt(sqrtPriceX64);
  const numerator = sqrtPrice * sqrtPrice;
  const precisionShift = 10 ** (decimalsA - decimalsB);
  return (Number(numerator) / Number(Q128)) * precisionShift;
}

/**
 * Calculate token price from sqrtPriceX64.
 * tokenB price in terms of tokenA:
 *   2^128 / sqrtPriceX64^2 * 10^(precisionB - precisionA)
 */
export function calcPriceBinA(sqrtPriceX64, decimalsA, decimalsB) {
  const sqrtPrice = BigInt(sqrtPriceX64);
  const numerator = sqrtPrice * sqrtPrice;
  const precisionShift = 10 ** (decimalsB - decimalsA);
  return (Number(Q128) / Number(numerator)) * precisionShift;
}

/**
 * Estimate the maximum input amount a pool can handle within its current tick range.
 * Returns the max raw input for each side (tokenA, tokenB).
 *
 * For tokenA input: the pool can absorb up to ~(L / sqrtPrice) tokens before
 * price hits 0 (realistically limited by tick boundaries).
 * For tokenB input: the pool can absorb up to ~(L * sqrtPrice / 2^64) tokens.
 *
 * We use a conservative 80% of theoretical max to stay within range.
 */
export function estimatePoolCapacity(pool) {
  const liquidity = BigInt(pool.liquidity);
  if (liquidity === 0n) return { maxInputA: 0, maxInputB: 0 };

  const sqrtPriceX64 = BigInt(pool.sqrtPriceX64);
  if (sqrtPriceX64 === 0n) return { maxInputA: 0, maxInputB: 0 };

  // Max tokenA input ≈ L * 2^64 / sqrtPrice (conservative: 50%)
  const maxInputARaw = (liquidity * Q64) / sqrtPriceX64 / 2n;
  const maxInputA = Number(maxInputARaw) / (10 ** pool.tokenA.decimals);

  // Max tokenB input ≈ L * sqrtPrice / 2^64 (conservative: 50%)
  const maxInputBRaw = (liquidity * sqrtPriceX64) / Q64 / 2n;
  const maxInputB = Number(maxInputBRaw) / (10 ** pool.tokenB.decimals);

  return { maxInputA, maxInputB };
}

/**
 * Check if a given input amount is within the pool's capacity.
 */
export function isWithinPoolCapacity(amountIn, pool, inputIsTokenA) {
  const { maxInputA, maxInputB } = estimatePoolCapacity(pool);
  if (inputIsTokenA) {
    return amountIn <= maxInputA && maxInputA > 0;
  }
  return amountIn <= maxInputB && maxInputB > 0;
}

/**
 * Estimate output amount for a concentrated liquidity swap (simplified).
 * Uses the constant-product formula within the current tick range.
 *
 * Returns 0 if the input amount exceeds pool capacity.
 */
export function estimateSwapOutput(amountIn, pool, inputIsTokenA) {
  const liquidity = BigInt(pool.liquidity);
  if (liquidity === 0n) return 0;

  const sqrtPriceX64 = BigInt(pool.sqrtPriceX64);
  if (sqrtPriceX64 === 0n) return 0;

  const feeRate = pool.fee / 1_000_000;
  const amountInAfterFee = amountIn * (1 - feeRate);

  // Check capacity first
  if (!isWithinPoolCapacity(amountInAfterFee, pool, inputIsTokenA)) {
    return 0;
  }

  if (inputIsTokenA) {
    const decimalsA = pool.tokenA.decimals;
    const amountInRaw = BigInt(Math.floor(amountInAfterFee * (10 ** decimalsA)));
    if (amountInRaw <= 0n) return 0;

    const numerator = sqrtPriceX64 * liquidity;
    const denominator = liquidity + (amountInRaw * sqrtPriceX64) / Q64;
    if (denominator === 0n) return 0;
    const sqrtPriceNewX64 = numerator / denominator;

    if (sqrtPriceNewX64 >= sqrtPriceX64) return 0;
    const deltaSqrtPrice = sqrtPriceX64 - sqrtPriceNewX64;
    const amountOutRaw = (liquidity * deltaSqrtPrice) / Q64;

    const decimalsB = pool.tokenB.decimals;
    return Number(amountOutRaw) / (10 ** decimalsB);
  } else {
    const decimalsB = pool.tokenB.decimals;
    const amountInRaw = BigInt(Math.floor(amountInAfterFee * (10 ** decimalsB)));
    if (amountInRaw <= 0n) return 0;

    const sqrtPriceNewX64 = sqrtPriceX64 + (amountInRaw * Q64) / liquidity;

    if (sqrtPriceNewX64 <= sqrtPriceX64) return 0;
    const deltaSqrtPrice = sqrtPriceNewX64 - sqrtPriceX64;
    if (sqrtPriceX64 === 0n || sqrtPriceNewX64 === 0n) return 0;
    const amountOutRaw = (liquidity * Q64 * deltaSqrtPrice) / (sqrtPriceX64 * sqrtPriceNewX64);

    const decimalsA = pool.tokenA.decimals;
    return Number(amountOutRaw) / (10 ** decimalsA);
  }
}

/**
 * Format a number to a fixed-decimal asset string for EOSIO.
 * e.g. formatAsset(100.5, 4) → "100.5000"
 */
export function formatAsset(amount, decimals) {
  return amount.toFixed(decimals);
}

/**
 * Calculate profit percentage.
 */
export function profitPercent(amountIn, amountOut) {
  if (amountIn === 0) return 0;
  return ((amountOut - amountIn) / amountIn) * 100;
}
