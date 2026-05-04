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
 * Estimate output amount for a concentrated liquidity swap (simplified).
 * Uses the constant-product formula within the current tick range.
 *
 * For a swap of tokenA → tokenB:
 *   amountOut ≈ liquidity * (1/sqrtPrice_before - 1/sqrtPrice_after)
 *   where sqrtPrice_after = sqrtPrice * liquidity / (liquidity + amountIn * sqrtPrice)
 *
 * This is an approximation that works well for small trades relative to pool liquidity.
 */
export function estimateSwapOutput(amountIn, pool, inputIsTokenA) {
  const liquidity = BigInt(pool.liquidity);
  if (liquidity === 0n) return 0;

  const sqrtPriceX64 = BigInt(pool.sqrtPriceX64);
  const feeRate = pool.fee / 1_000_000;
  const amountInAfterFee = amountIn * (1 - feeRate);

  if (inputIsTokenA) {
    // Swap tokenA → tokenB
    const decimalsA = pool.tokenA.decimals;
    const amountInRaw = BigInt(Math.floor(amountInAfterFee * (10 ** decimalsA)));

    // New sqrtPrice after swap
    // sqrtPriceNew = sqrtPrice * L / (L + amountIn * sqrtPrice / 2^64)
    const numerator = sqrtPriceX64 * liquidity;
    const denominator = liquidity + (amountInRaw * sqrtPriceX64) / Q64;
    if (denominator === 0n) return 0;
    const sqrtPriceNewX64 = numerator / denominator;

    // amountOut = L * (sqrtPrice - sqrtPriceNew) / (sqrtPrice * sqrtPriceNew / 2^64)
    const deltaSqrtPrice = sqrtPriceX64 - sqrtPriceNewX64;
    const amountOutRaw = (liquidity * deltaSqrtPrice) / Q64;

    const decimalsB = pool.tokenB.decimals;
    return Number(amountOutRaw) / (10 ** decimalsB);
  } else {
    // Swap tokenB → tokenA
    const decimalsB = pool.tokenB.decimals;
    const amountInRaw = BigInt(Math.floor(amountInAfterFee * (10 ** decimalsB)));

    // sqrtPriceNew = sqrtPrice + amountIn * 2^64 / L
    const sqrtPriceNewX64 = sqrtPriceX64 + (amountInRaw * Q64) / liquidity;

    // amountOut = L * (1/sqrtPriceNew - 1/sqrtPrice) in tokenA terms
    // = L * (sqrtPrice - sqrtPriceNew) ... wait, price goes up, so:
    // amountOut = L * (sqrtPriceNew - sqrtPrice) / (sqrtPrice * sqrtPriceNew / 2^64)
    // Simplified: amountOut = L * 2^64 * (sqrtPriceNew - sqrtPrice) / (sqrtPrice * sqrtPriceNew)
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
