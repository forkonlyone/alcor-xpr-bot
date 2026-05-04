import fetch from 'node-fetch';

/**
 * Fetches and manages pool data from the Alcor API and on-chain.
 */
export class AlcorApi {
  constructor(baseUrl, logger) {
    this.baseUrl = baseUrl;
    this.logger = logger;
    this.pools = [];
    this.poolMap = new Map();
    this.tokenPools = new Map();
  }

  async fetchPools() {
    const url = `${this.baseUrl}/swap/pools`;
    this.logger.debug(`Fetching pools from ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch pools: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    this.pools = data;

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

  getPoolsForToken(symbol, contract) {
    const tokenId = `${symbol}-${contract}`;
    return this.tokenPools.get(tokenId) || [];
  }

  getPool(poolId) {
    return this.poolMap.get(poolId);
  }

  getPoolsWithMinTvl(minTvl) {
    return this.pools.filter(p => p.tvlUSD >= minTvl);
  }

  getXprPools(minTvl = 0) {
    return this.pools.filter(p => {
      const hasXpr =
        (p.tokenA.symbol === 'XPR' && p.tokenA.contract === 'eosio.token') ||
        (p.tokenB.symbol === 'XPR' && p.tokenB.contract === 'eosio.token');
      return hasXpr && p.tvlUSD >= minTvl && BigInt(p.liquidity) > 0n;
    });
  }

  /**
   * Refresh pool state directly from the blockchain (freshest data).
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
          pool.liquidity = String(row.currSlot?.liquidity || row.liquidity || pool.liquidity);
          pool.sqrtPriceX64 = String(row.currSlot?.sqrtPriceX64 || row.sqrtPriceX64 || pool.sqrtPriceX64);
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
   * Fetch initialized tick data for a pool from the blockchain.
   * Returns array of {id, liquidityNet, liquidityGross, ...}.
   */
  async fetchPoolTicks(poolId, rpc) {
    try {
      const result = await rpc.get_table_rows({
        code: 'swap.alcor',
        scope: String(poolId),
        table: 'ticks',
        limit: 100,
        json: true,
      });
      return result.rows || [];
    } catch (err) {
      this.logger.debug(`Failed to fetch ticks for pool ${poolId}: ${err.message}`);
      return [];
    }
  }

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
