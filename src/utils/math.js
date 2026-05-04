import { Q64, Q128 } from '../config/constants.js';

/**
 * tokenA price in terms of tokenB.
 */
export function calcPriceAinB(sqrtPriceX64, decimalsA, decimalsB) {
  const sqrtPrice = BigInt(sqrtPriceX64);
  const numerator = sqrtPrice * sqrtPrice;
  const precisionShift = 10 ** (decimalsA - decimalsB);
  return (Number(numerator) / Number(Q128)) * precisionShift;
}

/**
 * tokenB price in terms of tokenA.
 */
export function calcPriceBinA(sqrtPriceX64, decimalsA, decimalsB) {
  const sqrtPrice = BigInt(sqrtPriceX64);
  const numerator = sqrtPrice * sqrtPrice;
  const precisionShift = 10 ** (decimalsB - decimalsA);
  return (Number(Q128) / Number(numerator)) * precisionShift;
}

/**
 * Calculate the maximum input a pool can handle within its CURRENT tick range
 * by reading actual tick boundaries.
 *
 * @param {Object} pool - Pool data with sqrtPriceX64, liquidity
 * @param {Array}  ticks - Sorted tick rows from chain [{id, liquidityNet, ...}]
 * @param {boolean} inputIsTokenA - Direction of the swap
 * @returns {number} Maximum human-readable input amount
 */
export function maxInputFromTicks(pool, ticks, inputIsTokenA) {
  const liquidity = BigInt(pool.liquidity || pool.currSlot?.liquidity || '0');
  if (liquidity === 0n) return 0;

  const sqrtPriceX64 = BigInt(pool.sqrtPriceX64 || pool.currSlot?.sqrtPriceX64 || '0');
  if (sqrtPriceX64 === 0n) return 0;

  const currentTick = Number(pool.tick ?? pool.currSlot?.tick ?? 0);

  if (inputIsTokenA) {
    // Swapping A→B moves the price DOWN (sqrtPrice decreases, tick decreases)
    // Find the next initialized tick BELOW current tick
    const lowerTicks = ticks.filter(t => t.id < currentTick).sort((a, b) => b.id - a.id);
    if (lowerTicks.length === 0) return 0;
    const nextTickBelow = lowerTicks[0].id;

    // sqrtPrice at lower tick boundary
    const sqrtPriceLowerX64 = tickToSqrtPriceX64(nextTickBelow);
    if (sqrtPriceLowerX64 >= sqrtPriceX64) return 0;

    // Max tokenA input to reach that tick: L * (1/sqrtPriceLower - 1/sqrtPriceCurrent) in X64
    // = L * 2^64 * (sqrtPriceCurrent - sqrtPriceLower) / (sqrtPriceLower * sqrtPriceCurrent)
    const delta = sqrtPriceX64 - sqrtPriceLowerX64;
    const maxRaw = (liquidity * Q64 * delta) / (sqrtPriceLowerX64 * sqrtPriceX64);

    const decimalsA = pool.tokenA?.decimals ?? 4;
    // Use 90% to stay safely within the range
    return (Number(maxRaw) / (10 ** decimalsA)) * 0.9;
  } else {
    // Swapping B→A moves the price UP (sqrtPrice increases, tick increases)
    const upperTicks = ticks.filter(t => t.id > currentTick).sort((a, b) => a.id - b.id);
    if (upperTicks.length === 0) return 0;
    const nextTickAbove = upperTicks[0].id;

    const sqrtPriceUpperX64 = tickToSqrtPriceX64(nextTickAbove);
    if (sqrtPriceUpperX64 <= sqrtPriceX64) return 0;

    // Max tokenB input: L * (sqrtPriceUpper - sqrtPriceCurrent) / 2^64
    const delta = sqrtPriceUpperX64 - sqrtPriceX64;
    const maxRaw = (liquidity * delta) / Q64;

    const decimalsB = pool.tokenB?.decimals ?? 4;
    return (Number(maxRaw) / (10 ** decimalsB)) * 0.9;
  }
}

/**
 * Convert a tick index to sqrtPriceX64.
 * sqrtPrice = 1.0001^(tick/2) * 2^64
 */
export function tickToSqrtPriceX64(tick) {
  const sqrtPrice = Math.pow(1.0001, tick / 2) * (2 ** 64);
  return BigInt(Math.floor(sqrtPrice));
}

/**
 * Estimate pool capacity without tick data (fallback heuristic).
 */
export function estimatePoolCapacity(pool) {
  const liquidity = BigInt(pool.liquidity || '0');
  if (liquidity === 0n) return { maxInputA: 0, maxInputB: 0 };

  const sqrtPriceX64 = BigInt(pool.sqrtPriceX64 || '0');
  if (sqrtPriceX64 === 0n) return { maxInputA: 0, maxInputB: 0 };

  // Conservative: use 30% of theoretical single-tick max
  const maxInputARaw = (liquidity * Q64) / sqrtPriceX64 * 3n / 10n;
  const maxInputA = Number(maxInputARaw) / (10 ** (pool.tokenA?.decimals ?? 4));

  const maxInputBRaw = (liquidity * sqrtPriceX64) / Q64 * 3n / 10n;
  const maxInputB = Number(maxInputBRaw) / (10 ** (pool.tokenB?.decimals ?? 4));

  return { maxInputA, maxInputB };
}

/**
 * Estimate output amount for a concentrated liquidity swap.
 * Returns 0 if the pool cannot handle the amount.
 */
export function estimateSwapOutput(amountIn, pool, inputIsTokenA) {
  const liquidity = BigInt(pool.liquidity || '0');
  if (liquidity === 0n) return 0;

  const sqrtPriceX64 = BigInt(pool.sqrtPriceX64 || '0');
  if (sqrtPriceX64 === 0n) return 0;

  const feeRate = pool.fee / 1_000_000;
  const amountInAfterFee = amountIn * (1 - feeRate);

  // Rough capacity check
  const { maxInputA, maxInputB } = estimatePoolCapacity(pool);
  if (inputIsTokenA && amountInAfterFee > maxInputA && maxInputA > 0) return 0;
  if (!inputIsTokenA && amountInAfterFee > maxInputB && maxInputB > 0) return 0;

  if (inputIsTokenA) {
    const decimalsA = pool.tokenA?.decimals ?? 4;
    const amountInRaw = BigInt(Math.floor(amountInAfterFee * (10 ** decimalsA)));
    if (amountInRaw <= 0n) return 0;

    const numerator = sqrtPriceX64 * liquidity;
    const denominator = liquidity + (amountInRaw * sqrtPriceX64) / Q64;
    if (denominator === 0n) return 0;
    const sqrtPriceNewX64 = numerator / denominator;

    if (sqrtPriceNewX64 >= sqrtPriceX64) return 0;
    const deltaSqrtPrice = sqrtPriceX64 - sqrtPriceNewX64;
    const amountOutRaw = (liquidity * deltaSqrtPrice) / Q64;

    const decimalsB = pool.tokenB?.decimals ?? 4;
    return Number(amountOutRaw) / (10 ** decimalsB);
  } else {
    const decimalsB = pool.tokenB?.decimals ?? 4;
    const amountInRaw = BigInt(Math.floor(amountInAfterFee * (10 ** decimalsB)));
    if (amountInRaw <= 0n) return 0;

    const sqrtPriceNewX64 = sqrtPriceX64 + (amountInRaw * Q64) / liquidity;

    if (sqrtPriceNewX64 <= sqrtPriceX64) return 0;
    const deltaSqrtPrice = sqrtPriceNewX64 - sqrtPriceX64;
    if (sqrtPriceX64 === 0n || sqrtPriceNewX64 === 0n) return 0;
    const amountOutRaw = (liquidity * Q64 * deltaSqrtPrice) / (sqrtPriceX64 * sqrtPriceNewX64);

    const decimalsA = pool.tokenA?.decimals ?? 4;
    return Number(amountOutRaw) / (10 ** decimalsA);
  }
}

/**
 * Format a number to a fixed-decimal asset string for EOSIO.
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
