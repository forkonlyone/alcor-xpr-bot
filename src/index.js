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

  // Initialize services
  const alcorApi = new AlcorApi(config.alcorApiUrl, logger);
  const finder = new RouteFinder(alcorApi, config, logger);
  const executor = new SwapExecutor(config, logger);
  executor.initialize();

  // Check initial balance
  const balance = await executor.getXprBalance();
  logger.info(`XPR Balance: ${balance.toFixed(4)} XPR`);
  if (balance < config.tradeAmountXpr && !config.dryRun) {
    logger.error(`Insufficient balance! Need ${config.tradeAmountXpr} XPR, have ${balance.toFixed(4)} XPR`);
    process.exit(1);
  }

  // Statistics
  let totalScans = 0;
  let totalOpportunities = 0;
  let totalTradesExecuted = 0;
  let totalProfitXpr = 0;
  let consecutiveErrors = 0;

  logger.info('Starting scan loop... Press Ctrl+C to stop.\n');

  // Graceful shutdown
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
      // Refresh pool data each cycle
      await alcorApi.fetchPools();
      totalScans++;

      // Find profitable routes
      const routes = finder.findProfitableRoutes(config.tradeAmountXpr);

      if (routes.length > 0) {
        totalOpportunities += routes.length;
        const best = routes[0];

        logger.info(`[Scan #${totalScans}] Found ${routes.length} route(s). Best: ${best.profitPercent.toFixed(4)}% (+${best.profitXpr.toFixed(4)} XPR)`);
        logger.info(`  Route: ${best.description}`);

        // Double-check: verify the best route is still within acceptable bounds
        if (best.profitXpr <= 0) {
          logger.warn('Best route has non-positive profit after recalculation. Skipping.');
        } else {
          // Execute the best route
          const result = await executor.executeRoute(best);

          if (result.success) {
            totalTradesExecuted++;
            totalProfitXpr += best.profitXpr;
            logger.info(`Trade ${result.dryRun ? '(simulated)' : ''} successful! Cumulative profit: ${totalProfitXpr.toFixed(4)} XPR`);

            // Brief cooldown after successful trade to let pools rebalance
            await sleep(2000);

            // Re-check balance after trade
            if (!config.dryRun) {
              const newBalance = await executor.getXprBalance();
              logger.info(`Updated balance: ${newBalance.toFixed(4)} XPR`);
            }
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
