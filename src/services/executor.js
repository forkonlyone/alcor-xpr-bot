import { Api, JsonRpc, JsSignatureProvider } from '@proton/js';
import fetch from 'node-fetch';
import { ALCOR_SWAP_CONTRACT, XPR_TOKEN } from '../config/constants.js';
import { formatAsset } from '../utils/math.js';

// Retry scale factors — each attempt uses a smaller input
const RETRY_FACTORS = [1.0, 0.75, 0.50, 0.30, 0.15];

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
   * Execute a complete arbitrage route with aggressive retry.
   *
   * On "not enough to swap" errors the bot retries with progressively
   * smaller input amounts (75%, 50%, 30%, 15%) until one goes through.
   * Minimum output is set to the smallest possible unit (e.g. 0.0001)
   * so the on-chain swap never reverts due to slippage.  Profit was
   * already validated off-chain before calling this method.
   */
  async executeRoute(route) {
    if (this.config.dryRun) {
      this.logRouteInfo(route, route.steps[0].amountIn);
      this.logger.info('DRY RUN - Trade NOT executed');
      return { success: true, dryRun: true, route };
    }

    // Try progressively smaller amounts
    for (let attempt = 0; attempt < RETRY_FACTORS.length; attempt++) {
      const factor = RETRY_FACTORS[attempt];
      const result = await this.tryExecute(route, factor, attempt);
      if (result.success) return result;

      // Only retry on "not enough" errors
      const retryable =
        result.error &&
        (result.error.includes('not enough') ||
         result.error.includes('insufficient') ||
         result.error.includes('overflows'));
      if (!retryable) return result;

      this.logger.warn(`Attempt ${attempt + 1} failed, retrying at ${Math.round(RETRY_FACTORS[attempt + 1] * 100)}% amount...`);
    }

    return { success: false, error: 'All retry attempts exhausted', route };
  }

  /**
   * Single execution attempt at a given fraction of the original amount.
   */
  async tryExecute(route, factor, attempt) {
    const { steps } = route;
    const username = this.config.username;
    const firstStep = steps[0];
    const lastStep = steps[steps.length - 1];

    // Scale the input amount
    const scaledAmountIn = firstStep.amountIn * factor;

    // ---- Build multi-hop memo (all pools in one transfer) ----
    const poolIds = steps.map(s => s.poolId).join(',');

    // Force minimum output as low as possible (1 smallest unit)
    // This prevents "not enough" revert from the output side.
    // Profit was already verified off-chain.
    const tinyMinOutput = formatAsset(1 / (10 ** lastStep.tokenOut.decimals), lastStep.tokenOut.decimals);

    const deadline = 0;
    const memo = `swapexactin#${poolIds}#${username}#${tinyMinOutput} ${lastStep.tokenOut.symbol}@${lastStep.tokenOut.contract}#${deadline}`;

    const inputAmount = formatAsset(scaledAmountIn, firstStep.tokenIn.decimals);
    const quantity = `${inputAmount} ${firstStep.tokenIn.symbol}`;

    this.logRouteInfo(route, scaledAmountIn, attempt);
    this.logger.info(`Memo: ${memo}`);

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
        { blocksBehind: 3, expireSeconds: 30 },
      );

      const txId = result.transaction_id || result.processed?.id || 'unknown';
      this.logger.info(`Trade executed! TX: ${txId}`);
      return { success: true, dryRun: false, txId, route, factor };
    } catch (error) {
      const errMsg = error.json?.error?.details?.[0]?.message || error.message || String(error);
      this.logger.error(`Trade failed (attempt ${attempt + 1}, factor ${factor}): ${errMsg}`);

      if (errMsg.includes('fetch') || errMsg.includes('ECONNREFUSED') || errMsg.includes('timeout')) {
        this.failover();
      }
      return { success: false, error: errMsg, route };
    }
  }

  /**
   * If multi-hop fails completely, try executing each step individually.
   * Step 1 sends XPR → swap.alcor (get token).
   * Step 2 sends token → swap.alcor (get XPR back).
   */
  async executeStepByStep(route) {
    const { steps } = route;
    const username = this.config.username;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const tinyMinOutput = formatAsset(1 / (10 ** step.tokenOut.decimals), step.tokenOut.decimals);
      const deadline = 0;
      const memo = `swapexactin#${step.poolId}#${username}#${tinyMinOutput} ${step.tokenOut.symbol}@${step.tokenOut.contract}#${deadline}`;

      // For step 0 use the original input; for later steps query the actual balance
      let inputAmount;
      if (i === 0) {
        inputAmount = formatAsset(step.amountIn, step.tokenIn.decimals);
      } else {
        const bal = await this.getTokenBalance(step.tokenIn.contract, username, step.tokenIn.symbol);
        if (bal <= 0) {
          this.logger.error(`Step ${i + 1}: zero balance of ${step.tokenIn.symbol}, aborting`);
          return { success: false, error: `Zero ${step.tokenIn.symbol} balance at step ${i + 1}`, route };
        }
        inputAmount = formatAsset(bal, step.tokenIn.decimals);
      }

      const quantity = `${inputAmount} ${step.tokenIn.symbol}`;
      this.logger.info(`Step ${i + 1}/${steps.length}: ${quantity} → ${step.tokenOut.symbol} (pool ${step.poolId})`);

      try {
        await this.api.transact(
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
        this.logger.info(`Step ${i + 1} succeeded`);
      } catch (error) {
        const errMsg = error.json?.error?.details?.[0]?.message || error.message || String(error);
        this.logger.error(`Step ${i + 1} failed: ${errMsg}`);
        return { success: false, error: errMsg, route, failedStep: i };
      }
    }

    return { success: true, dryRun: false, route, mode: 'step-by-step' };
  }

  logRouteInfo(route, amountIn, attempt) {
    const tag = attempt !== undefined ? ` (attempt ${attempt + 1})` : '';
    this.logger.info(`Executing${tag}: ${amountIn.toFixed(4)} XPR | ${route.description}`);
    this.logger.info(`Expected profit: ${route.profitPercent.toFixed(4)}% (+${route.profitXpr.toFixed(4)} XPR)`);
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
