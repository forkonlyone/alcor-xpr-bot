/**
 * Standalone scanner - scans for profitable routes without executing trades.
 * Usage: node src/scanner.js
 */
import { loadConfig } from './config/env.js';
import { AlcorApi } from './services/alcorApi.js';
import { RouteFinder } from './services/routeFinder.js';
import { createLogger } from './utils/logger.js';

async function main() {
  const config = {
    ...loadConfig(),
    dryRun: true,
  };
  const logger = createLogger(config.logLevel);

  logger.info('=== Alcor XPR Arbitrage Scanner ===');
  logger.info(`Trade amount: ${config.tradeAmountXpr} XPR`);
  logger.info(`Min profit: ${config.minProfitPercent}%`);
  logger.info(`Min pool TVL: $${config.minPoolTvlUsd}`);
  logger.info(`Max hops: ${config.maxRouteHops}`);

  const alcorApi = new AlcorApi(config.alcorApiUrl, logger);
  await alcorApi.fetchPools();

  const xprPools = alcorApi.getXprPools(config.minPoolTvlUsd);
  logger.info(`XPR pools with TVL >= $${config.minPoolTvlUsd}: ${xprPools.length}`);

  const finder = new RouteFinder(alcorApi, config, logger);

  logger.info('\nScanning for profitable routes...\n');
  const routes = finder.findProfitableRoutes(config.tradeAmountXpr);

  if (routes.length === 0) {
    logger.info('No profitable routes found at current prices.');
    logger.info('This is normal - arbitrage opportunities are fleeting.');
    logger.info('The bot continuously scans to catch them when they appear.');
  } else {
    logger.info(`Found ${routes.length} profitable route(s):\n`);
    for (let i = 0; i < Math.min(routes.length, 20); i++) {
      const r = routes[i];
      logger.info(`#${i + 1} [${r.type}] ${r.description}`);
      logger.info(`    In: ${r.amountIn.toFixed(4)} XPR → Out: ${r.amountOut.toFixed(4)} XPR`);
      logger.info(`    Profit: ${r.profitPercent.toFixed(4)}% (+${r.profitXpr.toFixed(4)} XPR)`);
      for (const step of r.steps) {
        logger.info(`    Step: ${step.amountIn.toFixed(4)} ${step.tokenIn.symbol} → ${step.amountOut.toFixed(4)} ${step.tokenOut.symbol} (pool ${step.poolId}, fee ${step.fee / 10000}%)`);
      }
      logger.info('');
    }
  }

  logger.info('Scan complete.');
}

main().catch(err => {
  console.error('Scanner error:', err);
  process.exit(1);
});
