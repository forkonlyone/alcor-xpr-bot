import { Api, JsonRpc, JsSignatureProvider } from '@proton/js';
import fetch from 'node-fetch';
import { ALCOR_SWAP_CONTRACT, XPR_TOKEN } from '../config/constants.js';
import { formatAsset, maxInputFromTicks, estimatePoolCapacity } from '../utils/math.js';

// When pool capacity is unknown we retry with these fractions
const RETRY_FACTORS = [1.0, 0.60, 0.30, 0.10, 0.05];

export class SwapExecutor {
  constructor(config, logger, alcorApi) {
    this.config = config;
    this.logger = logger;
    this.alcorApi = alcorApi;
    this.rpc = null;
    this.api = null;
    this.currentEndpointIndex = 0;
  }

  initialize() {
    const endpoint = this.config.rpcEndpoints[this.currentEndpointIndex];
    this.logger.info(`Connecting to RPC: ${endpoint}`);

    this.rpc = new JsonRpc([endpoint], { fetch });
    const signatureProvider = new JsSignatureProvider([this.config.privateKey]);
    this.api = new Api({
      rpc: this.rpc,
      signatureProvider,
      textDecoder: new TextDecoder(),
      textEncoder: new TextEncoder(),
    });
  }

  failover() {
    this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.config.rpcEndpoints.length;
    this.logger.warn(`Failing over to RPC: ${this.config.rpcEndpoints[this.currentEndpointIndex]}`);
    this.initialize();
  }

  /**
   * Execute route — always step-by-step for maximum reliability.
   * Before each step:
   *   1. Refresh pool state from chain
   *   2. Fetch tick data to determine max capacity
   *   3. Auto-cap input to what the pool can actually handle
   *   4. Set minimum output to 1 smallest unit (forced success)
   *   5. If step still fails, retry with smaller fractions
   */
  async executeRoute(route) {
    if (this.config.dryRun) {
      this.logger.info(`DRY RUN: ${route.description} | +${route.profitXpr.toFixed(4)} XPR (${route.profitPercent.toFixed(2)}%)`);
      return { success: true, dryRun: true, route };
    }

    const { steps } = route;
    const username = this.config.username;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      this.logger.info(`Step ${i + 1}/${steps.length}: ${step.tokenIn.symbol} → ${step.tokenOut.symbol} (pool ${step.poolId})`);

      // 1. Refresh pool from chain
      const pool = await this.alcorApi.refreshPoolFromChain(step.poolId, this.rpc);

      // 2. Fetch tick data to find real capacity
      const ticks = await this.alcorApi.fetchPoolTicks(step.poolId, this.rpc);

      // 3. Determine the input amount
      let desiredInput;
      if (i === 0) {
        desiredInput = step.amountIn;
      } else {
        // For subsequent steps, use actual token balance
        const bal = await this.getTokenBalance(step.tokenIn.contract, username, step.tokenIn.symbol);
        if (bal <= 0) {
          this.logger.error(`Zero ${step.tokenIn.symbol} balance at step ${i + 1}`);
          return { success: false, error: `Zero ${step.tokenIn.symbol} balance`, route, failedStep: i };
        }
        desiredInput = bal;
      }

      // 4. Cap to pool capacity
      const inputIsTokenA = this.isTokenA(pool, step.tokenIn);
      let maxInput = Infinity;

      if (ticks.length > 0 && pool) {
        const tickMax = maxInputFromTicks(pool, ticks, inputIsTokenA);
        if (tickMax > 0) maxInput = tickMax;
      }
      if (maxInput === Infinity && pool) {
        // Fallback heuristic capacity
        const cap = estimatePoolCapacity(pool);
        const heurMax = inputIsTokenA ? cap.maxInputA : cap.maxInputB;
        if (heurMax > 0) maxInput = heurMax;
      }

      const cappedInput = maxInput < Infinity ? Math.min(desiredInput, maxInput) : desiredInput;
      if (cappedInput < desiredInput) {
        this.logger.warn(`Capping input from ${desiredInput.toFixed(4)} to ${cappedInput.toFixed(4)} ${step.tokenIn.symbol} (pool capacity)`);
      }

      // 5. Execute with retry
      const ok = await this.executeStep(step, cappedInput, username);
      if (!ok) {
        // Retry with smaller fractions
        let succeeded = false;
        for (let r = 1; r < RETRY_FACTORS.length; r++) {
          const retryAmount = cappedInput * RETRY_FACTORS[r];
          this.logger.warn(`Retrying step ${i + 1} at ${Math.round(RETRY_FACTORS[r] * 100)}% (${retryAmount.toFixed(4)} ${step.tokenIn.symbol})`);
          const retryOk = await this.executeStep(step, retryAmount, username);
          if (retryOk) { succeeded = true; break; }
        }
        if (!succeeded) {
          return { success: false, error: `Step ${i + 1} failed after all retries`, route, failedStep: i };
        }
      }
    }

    this.logger.info(`All ${steps.length} steps completed successfully!`);
    return { success: true, dryRun: false, route, mode: 'step-by-step' };
  }

  /**
   * Execute a single swap step.
   */
  async executeStep(step, inputAmount, username) {
    // Minimum output = 1 smallest unit → force the swap through
    const tinyMinOutput = formatAsset(1 / (10 ** step.tokenOut.decimals), step.tokenOut.decimals);
    const memo = `swapexactin#${step.poolId}#${username}#${tinyMinOutput} ${step.tokenOut.symbol}@${step.tokenOut.contract}#0`;
    const quantity = `${formatAsset(inputAmount, step.tokenIn.decimals)} ${step.tokenIn.symbol}`;

    this.logger.info(`  Swap: ${quantity} → min ${tinyMinOutput} ${step.tokenOut.symbol}`);
    this.logger.debug(`  Memo: ${memo}`);

    try {
      const result = await this.api.transact(
        {
          actions: [
            {
              account: step.tokenIn.contract,
              name: 'transfer',
              authorization: [{ actor: username, permission: 'active' }],
              data: { from: username, to: ALCOR_SWAP_CONTRACT, quantity, memo },
            },
          ],
        },
        { blocksBehind: 3, expireSeconds: 30 },
      );
      const txId = result.transaction_id || result.processed?.id || 'unknown';
      this.logger.info(`  TX: ${txId}`);
      return true;
    } catch (error) {
      const errMsg = error.json?.error?.details?.[0]?.message || error.message || String(error);
      this.logger.error(`  Failed: ${errMsg}`);

      if (errMsg.includes('fetch') || errMsg.includes('ECONNREFUSED') || errMsg.includes('timeout')) {
        this.failover();
      }
      return false;
    }
  }

  /**
   * Determine if a token is tokenA or tokenB of the pool.
   */
  isTokenA(pool, token) {
    if (!pool) return true;
    return pool.tokenA?.symbol === token.symbol && pool.tokenA?.contract === token.contract;
  }

  async getXprBalance() {
    try {
      const result = await this.rpc.get_currency_balance(XPR_TOKEN.contract, this.config.username, XPR_TOKEN.symbol);
      if (result.length > 0) return parseFloat(result[0].split(' ')[0]);
      return 0;
    } catch (error) {
      this.logger.error(`Failed to get balance: ${error.message}`);
      return 0;
    }
  }

  async getTokenBalance(contract, account, symbol) {
    try {
      const result = await this.rpc.get_currency_balance(contract, account, symbol);
      if (result.length > 0) return parseFloat(result[0].split(' ')[0]);
      return 0;
    } catch (error) {
      this.logger.error(`Failed to get ${symbol} balance: ${error.message}`);
      return 0;
    }
  }
}
