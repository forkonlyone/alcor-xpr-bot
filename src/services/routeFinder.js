import { estimateSwapOutput, profitPercent } from '../utils/math.js';
import { AlcorApi } from './alcorApi.js';
import { XPR_TOKEN } from '../config/constants.js';

/**
 * Finds profitable arbitrage routes on Alcor Exchange.
 *
 * Strategies:
 * 1. Direct Round-Trip: XPR → Token → XPR (same or different pool)
 * 2. Triangular: XPR → TokenA → TokenB → XPR
 */
export class RouteFinder {
  constructor(alcorApi, config, logger) {
    this.api = alcorApi;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Find all profitable routes starting and ending with XPR.
   * Returns routes sorted by profit (highest first).
   */
  findProfitableRoutes(amountXpr) {
    const routes = [];

    // Strategy 1: Direct round-trip (XPR → Token → XPR)
    const directRoutes = this.findDirectRoutes(amountXpr);
    routes.push(...directRoutes);

    // Strategy 2: Triangular arbitrage (XPR → TokenA → TokenB → XPR)
    if (this.config.maxRouteHops >= 3) {
      const triangularRoutes = this.findTriangularRoutes(amountXpr);
      routes.push(...triangularRoutes);
    }

    // Sort by profit (highest first) and filter by minimum profit
    return routes
      .filter(r => r.profitPercent >= this.config.minProfitPercent)
      .sort((a, b) => b.profitPercent - a.profitPercent);
  }

  /**
   * Strategy 1: Find direct round-trip routes.
   * For each token paired with XPR, check if buying then selling back yields profit.
   * Also checks across different fee-tier pools for the same pair.
   */
  findDirectRoutes(amountXpr) {
    const routes = [];
    const xprPools = this.api.getXprPools(this.config.minPoolTvlUsd);

    // Group pools by the non-XPR token
    const tokenPoolGroups = new Map();
    for (const pool of xprPools) {
      const side = AlcorApi.getXprSide(pool);
      if (!side) continue;
      const tokenId = `${side.otherToken.symbol}-${side.otherToken.contract}`;
      if (!tokenPoolGroups.has(tokenId)) tokenPoolGroups.set(tokenId, []);
      tokenPoolGroups.get(tokenId).push({ pool, xprSide: side.xprSide, otherToken: side.otherToken });
    }

    for (const [_tokenId, poolEntries] of tokenPoolGroups) {
      // Try all combinations of buy/sell pools
      for (const buyEntry of poolEntries) {
        for (const sellEntry of poolEntries) {
          const route = this.evaluateDirectRoute(amountXpr, buyEntry, sellEntry);
          if (route) routes.push(route);
        }
      }
    }

    return routes;
  }

  /**
   * Evaluate a direct round-trip: XPR → Token (via buyPool) → XPR (via sellPool).
   */
  evaluateDirectRoute(amountXpr, buyEntry, sellEntry) {
    const { pool: buyPool, xprSide: buyXprSide, otherToken } = buyEntry;
    const { pool: sellPool, xprSide: sellXprSide } = sellEntry;

    // Step 1: Calculate how many tokens we get for amountXpr
    const inputIsTokenA_buy = buyXprSide === 'A';
    const tokensReceived = estimateSwapOutput(amountXpr, buyPool, inputIsTokenA_buy);
    if (tokensReceived <= 0) return null;

    // Step 2: Calculate how many XPR we get back for those tokens
    const inputIsTokenA_sell = sellXprSide !== 'A'; // we're selling the other token, so input is not XPR side
    const xprReceived = estimateSwapOutput(tokensReceived, sellPool, inputIsTokenA_sell);
    if (xprReceived <= 0) return null;

    const profit = profitPercent(amountXpr, xprReceived);

    return {
      type: 'direct',
      amountIn: amountXpr,
      amountOut: xprReceived,
      profitPercent: profit,
      profitXpr: xprReceived - amountXpr,
      steps: [
        {
          poolId: buyPool.id,
          action: 'buy',
          tokenIn: { symbol: XPR_TOKEN.symbol, contract: XPR_TOKEN.contract, decimals: XPR_TOKEN.decimals },
          tokenOut: { symbol: otherToken.symbol, contract: otherToken.contract, decimals: otherToken.decimals },
          amountIn: amountXpr,
          amountOut: tokensReceived,
          fee: buyPool.fee,
        },
        {
          poolId: sellPool.id,
          action: 'sell',
          tokenIn: { symbol: otherToken.symbol, contract: otherToken.contract, decimals: otherToken.decimals },
          tokenOut: { symbol: XPR_TOKEN.symbol, contract: XPR_TOKEN.contract, decimals: XPR_TOKEN.decimals },
          amountIn: tokensReceived,
          amountOut: xprReceived,
          fee: sellPool.fee,
        },
      ],
      description: `XPR → ${otherToken.symbol} (pool ${buyPool.id}) → XPR (pool ${sellPool.id})`,
    };
  }

  /**
   * Strategy 2: Triangular arbitrage.
   * XPR → TokenA → TokenB → XPR
   * Finds routes through an intermediate token.
   */
  findTriangularRoutes(amountXpr) {
    const routes = [];
    const xprPools = this.api.getXprPools(this.config.minPoolTvlUsd);
    const minTvl = this.config.minPoolTvlUsd;

    // For each XPR→TokenA pool
    for (const poolAB of xprPools) {
      const sideA = AlcorApi.getXprSide(poolAB);
      if (!sideA) continue;
      const tokenA = sideA.otherToken;


      // Step 1: XPR → TokenA
      const inputIsTokenA_step1 = sideA.xprSide === 'A';
      const tokenAReceived = estimateSwapOutput(amountXpr, poolAB, inputIsTokenA_step1);
      if (tokenAReceived <= 0) continue;

      // Find pools containing TokenA (non-XPR pools)
      const tokenAPools = this.api.getPoolsForToken(tokenA.symbol, tokenA.contract);
      for (const poolBC of tokenAPools) {
        if (poolBC.tvlUSD < minTvl || BigInt(poolBC.liquidity) === 0n) continue;
        // Skip if this pool also has XPR (would be a direct route)
        const hasXpr =
          (poolBC.tokenA.symbol === 'XPR' && poolBC.tokenA.contract === 'eosio.token') ||
          (poolBC.tokenB.symbol === 'XPR' && poolBC.tokenB.contract === 'eosio.token');
        if (hasXpr) continue;

        // Determine TokenB (the other side)
        let tokenB, inputIsTokenA_step2;
        if (poolBC.tokenA.symbol === tokenA.symbol && poolBC.tokenA.contract === tokenA.contract) {
          tokenB = poolBC.tokenB;
          inputIsTokenA_step2 = true;
        } else {
          tokenB = poolBC.tokenA;
          inputIsTokenA_step2 = false;
        }


        // Step 2: TokenA → TokenB
        const tokenBReceived = estimateSwapOutput(tokenAReceived, poolBC, inputIsTokenA_step2);
        if (tokenBReceived <= 0) continue;

        // Step 3: TokenB → XPR
        // Find pools with TokenB and XPR
        const tokenBPools = this.api.getPoolsForToken(tokenB.symbol, tokenB.contract);
        for (const poolCA of tokenBPools) {
          if (poolCA.tvlUSD < minTvl || BigInt(poolCA.liquidity) === 0n) continue;
          const sideC = AlcorApi.getXprSide(poolCA);
          if (!sideC) continue;
          if (sideC.otherToken.symbol !== tokenB.symbol || sideC.otherToken.contract !== tokenB.contract) continue;

          const inputIsTokenA_step3 = sideC.xprSide !== 'A';
          const xprReceived = estimateSwapOutput(tokenBReceived, poolCA, inputIsTokenA_step3);
          if (xprReceived <= 0) continue;

          const profit = profitPercent(amountXpr, xprReceived);

          routes.push({
            type: 'triangular',
            amountIn: amountXpr,
            amountOut: xprReceived,
            profitPercent: profit,
            profitXpr: xprReceived - amountXpr,
            steps: [
              {
                poolId: poolAB.id,
                action: 'buy',
                tokenIn: { symbol: XPR_TOKEN.symbol, contract: XPR_TOKEN.contract, decimals: XPR_TOKEN.decimals },
                tokenOut: { symbol: tokenA.symbol, contract: tokenA.contract, decimals: tokenA.decimals },
                amountIn: amountXpr,
                amountOut: tokenAReceived,
                fee: poolAB.fee,
              },
              {
                poolId: poolBC.id,
                action: 'swap',
                tokenIn: { symbol: tokenA.symbol, contract: tokenA.contract, decimals: tokenA.decimals },
                tokenOut: { symbol: tokenB.symbol, contract: tokenB.contract, decimals: tokenB.decimals },
                amountIn: tokenAReceived,
                amountOut: tokenBReceived,
                fee: poolBC.fee,
              },
              {
                poolId: poolCA.id,
                action: 'sell',
                tokenIn: { symbol: tokenB.symbol, contract: tokenB.contract, decimals: tokenB.decimals },
                tokenOut: { symbol: XPR_TOKEN.symbol, contract: XPR_TOKEN.contract, decimals: XPR_TOKEN.decimals },
                amountIn: tokenBReceived,
                amountOut: xprReceived,
                fee: poolCA.fee,
              },
            ],
            description: `XPR → ${tokenA.symbol}(${poolAB.id}) → ${tokenB.symbol}(${poolBC.id}) → XPR(${poolCA.id})`,
          });
        }
      }
    }

    return routes;
  }
}
