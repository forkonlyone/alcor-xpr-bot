import { Api, JsonRpc, JsSignatureProvider } from '@proton/js';
import fetch from 'node-fetch';
import { ALCOR_SWAP_CONTRACT, XPR_TOKEN } from '../config/constants.js';
import { formatAsset } from '../utils/math.js';

/**
 * Executes swap transactions on the Proton chain via Alcor's swap contract.
 *
 * Swap mechanism:
 *   Transfer input token to swap.alcor with memo:
 *   "swapexactin#<PoolIDs>#<Recipient>#<MinOutput Token@Contract>#<Deadline>"
 */
export class SwapExecutor {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.rpc = null;
    this.api = null;
    this.currentEndpointIndex = 0;
  }

  /**
   * Initialize the RPC connection and API.
   */
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

  /**
   * Switch to next RPC endpoint on failure.
   */
  failover() {
    this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.config.rpcEndpoints.length;
    this.logger.warn(`Failing over to RPC: ${this.config.rpcEndpoints[this.currentEndpointIndex]}`);
    this.initialize();
  }

  /**
   * Execute a complete arbitrage route (all steps atomically).
   *
   * For Alcor swaps, each step is a token transfer to swap.alcor with a memo.
   * Multi-hop swaps can be done in a single transfer by chaining pool IDs.
   */
  async executeRoute(route) {
    const { steps } = route;
    const username = this.config.username;

    // Build the pool chain (pool IDs joined by commas for multi-hop)
    const poolIds = steps.map(s => s.poolId).join(',');

    // The first step's input token and amount
    const firstStep = steps[0];
    const lastStep = steps[steps.length - 1];

    // Calculate minimum output with slippage protection
    const slippageFactor = 1 - this.config.maxSlippagePercent / 100;
    const minOutput = lastStep.amountOut * slippageFactor;
    const minOutputFormatted = formatAsset(minOutput, lastStep.tokenOut.decimals);

    // Build the memo for swap.alcor
    // Format: swapexactin#<PoolIDs>#<Recipient>#<MinOutput Token@Contract>#<Deadline>
    const deadline = 0; // 0 = no deadline
    const memo = `swapexactin#${poolIds}#${username}#${minOutputFormatted} ${lastStep.tokenOut.symbol}@${lastStep.tokenOut.contract}#${deadline}`;

    const inputAmount = formatAsset(firstStep.amountIn, firstStep.tokenIn.decimals);
    const quantity = `${inputAmount} ${firstStep.tokenIn.symbol}`;

    this.logger.info(`Executing swap: ${quantity} → min ${minOutputFormatted} ${lastStep.tokenOut.symbol}`);
    this.logger.info(`Memo: ${memo}`);
    this.logger.info(`Route: ${route.description}`);
    this.logger.info(`Expected profit: ${route.profitPercent.toFixed(4)}% (${route.profitXpr.toFixed(4)} XPR)`);

    if (this.config.dryRun) {
      this.logger.info('🔍 DRY RUN - Trade NOT executed');
      return { success: true, dryRun: true, route };
    }

    // Execute the transfer action
    try {
      const result = await this.api.transact(
        {
          actions: [
            {
              account: firstStep.tokenIn.contract,
              name: 'transfer',
              authorization: [{ actor: username, permission: 'active' }],
              data: {
                from: username,
                to: ALCOR_SWAP_CONTRACT,
                quantity,
                memo,
              },
            },
          ],
        },
        {
          blocksBehind: 3,
          expireSeconds: 30,
        },
      );

      const txId = result.transaction_id || result.processed?.id || 'unknown';
      this.logger.info(`Trade executed! TX: ${txId}`);
      this.logger.info(`Route: ${route.description} | Profit: ${route.profitPercent.toFixed(4)}%`);

      return { success: true, dryRun: false, txId, route };
    } catch (error) {
      const errMsg = error.json?.error?.details?.[0]?.message || error.message || String(error);
      this.logger.error(`Trade failed: ${errMsg}`);

      // Failover on connection issues
      if (errMsg.includes('fetch') || errMsg.includes('ECONNREFUSED') || errMsg.includes('timeout')) {
        this.failover();
      }

      return { success: false, error: errMsg, route };
    }
  }

  /**
   * Check XPR balance for the configured account.
   */
  async getXprBalance() {
    try {
      const result = await this.rpc.get_currency_balance(
        XPR_TOKEN.contract,
        this.config.username,
        XPR_TOKEN.symbol,
      );
      if (result.length > 0) {
        return parseFloat(result[0].split(' ')[0]);
      }
      return 0;
    } catch (error) {
      this.logger.error(`Failed to get balance: ${error.message}`);
      return 0;
    }
  }

  /**
   * Check balance of any token.
   */
  async getTokenBalance(contract, account, symbol) {
    try {
      const result = await this.rpc.get_currency_balance(contract, account, symbol);
      if (result.length > 0) {
        return parseFloat(result[0].split(' ')[0]);
      }
      return 0;
    } catch (error) {
      this.logger.error(`Failed to get ${symbol} balance: ${error.message}`);
      return 0;
    }
  }
}
