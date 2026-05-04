import fetch from 'node-fetch';

/**
 * Fetches and manages pool data from the Alcor API.
 */
export class AlcorApi {
  constructor(baseUrl, logger) {
    this.baseUrl = baseUrl;
    this.logger = logger;
    this.pools = [];
    this.poolMap = new Map();
    this.tokenPools = new Map(); // tokenId → [pool]
  }

  /**
   * Fetch all swap pools from Alcor API.
   */
  async fetchPools() {
    const url = `${this.baseUrl}/swap/pools`;
    this.logger.debug(`Fetching pools from ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch pools: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    this.pools = data;

    // Build lookup maps
    this.poolMap.clear();
    this.tokenPools.clear();

    for (const pool of this.pools) {
      this.poolMap.set(pool.id, pool);

      const tokenAId = `${pool.tokenA.symbol}-${pool.tokenA.contract}`;
      const tokenBId = `${pool.tokenB.symbol}-${pool.tokenB.contract}`;

      if (!this.tokenPools.has(tokenAId)) this.tokenPools.set(tokenAId, []);
      if (!this.tokenPools.has(tokenBId)) this.tokenPools.set(tokenBId, []);

      this.tokenPools.get(tokenAId).push(pool);
      this.tokenPools.get(tokenBId).push(pool);
    }

    this.logger.info(`Loaded ${this.pools.length} pools, ${this.tokenPools.size} unique tokens`);
    return this.pools;
  }

  /**
   * Get pools that contain a specific token.
   */
  getPoolsForToken(symbol, contract) {
    const tokenId = `${symbol}-${contract}`;
    return this.tokenPools.get(tokenId) || [];
  }

  /**
   * Get pool by ID.
   */
  getPool(poolId) {
    return this.poolMap.get(poolId);
  }

  /**
   * Filter pools by minimum TVL.
   */
  getPoolsWithMinTvl(minTvl) {
    return this.pools.filter(p => p.tvlUSD >= minTvl);
  }

  /**
   * Get XPR pools with sufficient liquidity.
   */
  getXprPools(minTvl = 0) {
    return this.pools.filter(p => {
      const hasXpr =
        (p.tokenA.symbol === 'XPR' && p.tokenA.contract === 'eosio.token') ||
        (p.tokenB.symbol === 'XPR' && p.tokenB.contract === 'eosio.token');
      return hasXpr && p.tvlUSD >= minTvl && BigInt(p.liquidity) > 0n;
    });
  }

  /**
   * Refresh a single pool's on-chain data from an RPC endpoint.
   * Used to get the freshest sqrtPrice/liquidity right before a trade.
   */
  async refreshPoolFromChain(poolId, rpc) {
    try {
      const result = await rpc.get_table_rows({
        code: 'swap.alcor',
        scope: 'swap.alcor',
        table: 'pools',
        lower_bound: poolId,
        upper_bound: poolId,
        limit: 1,
        json: true,
      });
      if (result.rows.length > 0) {
        const row = result.rows[0];
        const pool = this.poolMap.get(poolId);
        if (pool) {
          pool.liquidity = row.currSlot?.liquidity || row.liquidity || pool.liquidity;
          pool.sqrtPriceX64 = row.currSlot?.sqrtPriceX64 || row.sqrtPriceX64 || pool.sqrtPriceX64;
          pool.tick = row.currSlot?.tick ?? row.tick ?? pool.tick;
        }
        return pool;
      }
    } catch (err) {
      this.logger.debug(`Failed to refresh pool ${poolId} from chain: ${err.message}`);
    }
    return this.poolMap.get(poolId);
  }

  /**
   * For a given pool, determine which side is XPR and which is the other token.
   */
  static getXprSide(pool) {
    if (pool.tokenA.symbol === 'XPR' && pool.tokenA.contract === 'eosio.token') {
      return { xprSide: 'A', otherToken: pool.tokenB };
    }
    if (pool.tokenB.symbol === 'XPR' && pool.tokenB.contract === 'eosio.token') {
      return { xprSide: 'B', otherToken: pool.tokenA };
    }
    return null;
  }
}
