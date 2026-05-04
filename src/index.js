/**
 * Alcor XPR Arbitrage Trading Bot
 *
 * Continuously scans Alcor Exchange pools on the Proton chain for
 * profitable arbitrage opportunities. Calculates profit BEFORE executing
 * any trade. Only executes when net XPR return exceeds the configured
 * minimum profit threshold.
 *
 * Strategies:
 *  1. Direct round-trip: XPR → Token → XPR (same or cross fee-tier pools)
 *  2. Triangular arbitrage: XPR → TokenA → TokenB → XPR
 */

import { loadConfig } from './config/env.js';
import { AlcorApi } from './services/alcorApi.js';
import { RouteFinder } from './services/routeFinder.js';
import { SwapExecutor } from './services/executor.js';
import { createLogger } from './utils/logger.js';

let running = true;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info('╔══════════════════════════════════════════════╗');
  logger.info('║   Alcor XPR Arbitrage Bot - Proton Chain     ║');
  logger.info('╚══════════════════════════════════════════════╝');
  logger.info(`Account: ${config.username}`);
  logger.info(`Trade amount: ${config.tradeAmountXpr} XPR`);
  logger.info(`Min profit: ${config.minProfitPercent}%`);
  logger.info(`Max slippage: ${config.maxSlippagePercent}%`);
  logger.info(`Min pool TVL: $${config.minPoolTvlUsd}`);
  logger.info(`Scan interval: ${config.scanIntervalMs}ms`);
  logger.info(`Max hops: ${config.maxRouteHops}`);
  logger.info(`Mode: ${config.dryRun ? 'DRY RUN (simulation)' : 'LIVE TRADING'}`);
  logger.info('');

  const alcorApi = new AlcorApi(config.alcorApiUrl, logger);
  const finder = new RouteFinder(alcorApi, config, logger);
  const executor = new SwapExecutor(config, logger, alcorApi);
  executor.initialize();

  const balance = await executor.getXprBalance();
  logger.info(`XPR Balance: ${balance.toFixed(4)} XPR`);
  if (balance < config.tradeAmountXpr && !config.dryRun) {
    logger.error(`Insufficient balance! Need ${config.tradeAmountXpr} XPR, have ${balance.toFixed(4)} XPR`);
    process.exit(1);
  }

  let totalScans = 0;
  let totalOpportunities = 0;
  let totalTradesExecuted = 0;
  let totalProfitXpr = 0;
  let consecutiveErrors = 0;

  logger.info('Starting scan loop... Press Ctrl+C to stop.\n');

  process.on('SIGINT', () => {
    logger.info('\nShutting down...');
    logger.info(`Total scans: ${totalScans}`);
    logger.info(`Opportunities found: ${totalOpportunities}`);
    logger.info(`Trades executed: ${totalTradesExecuted}`);
    logger.info(`Total profit: ${totalProfitXpr.toFixed(4)} XPR`);
    running = false;
  });

  while (running) {
    try {
      await alcorApi.fetchPools();
      totalScans++;

      const routes = finder.findProfitableRoutes(config.tradeAmountXpr);

      if (routes.length > 0) {
        totalOpportunities += routes.length;

        // Try routes in order until one succeeds
        let traded = false;
        for (let i = 0; i < Math.min(routes.length, 5) && !traded; i++) {
          const route = routes[i];
          if (route.profitXpr <= 0) continue;

          logger.info(`[Scan #${totalScans}] Trying route #${i + 1}/${routes.length}: ${route.profitPercent.toFixed(4)}% | ${route.description}`);

          const result = await executor.executeRoute(route);

          if (result.success) {
            totalTradesExecuted++;
            totalProfitXpr += route.profitXpr;
            traded = true;
            logger.info(`Trade ${result.dryRun ? '(simulated)' : ''} successful! Cumulative profit: ${totalProfitXpr.toFixed(4)} XPR`);

            await sleep(2000);

            if (!config.dryRun) {
              const newBalance = await executor.getXprBalance();
              logger.info(`Updated balance: ${newBalance.toFixed(4)} XPR`);
            }
          } else {
            logger.warn(`Route #${i + 1} failed: ${result.error}. Trying next route...`);
          }
        }

        consecutiveErrors = 0;
      } else {
        if (totalScans % 10 === 0) {
          logger.debug(`[Scan #${totalScans}] No profitable routes found.`);
        }
        consecutiveErrors = 0;
      }
    } catch (error) {
      consecutiveErrors++;
      logger.error(`Scan error (${consecutiveErrors}): ${error.message}`);

      if (consecutiveErrors >= 5) {
        logger.error('Too many consecutive errors. Waiting 30s before retry...');
        await sleep(30000);
        consecutiveErrors = 0;
        executor.failover();
      }
    }

    await sleep(config.scanIntervalMs);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
