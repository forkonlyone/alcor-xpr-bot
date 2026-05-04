import dotenv from 'dotenv';
import { DEFAULT_RPC_ENDPOINTS, ALCOR_API_URL } from './constants.js';

dotenv.config();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export function loadConfig() {
  const username = requireEnv('PROTON_USERNAME');
  const privateKey = requireEnv('PROTON_PRIVATE_KEY');

  const rpcEndpoints = process.env.PROTON_RPC_ENDPOINTS
    ? process.env.PROTON_RPC_ENDPOINTS.split(',').map(e => e.trim())
    : DEFAULT_RPC_ENDPOINTS;

  return {
    username,
    privateKey,
    rpcEndpoints,
    alcorApiUrl: process.env.ALCOR_API_URL || ALCOR_API_URL,

    tradeAmountXpr: parseFloat(process.env.TRADE_AMOUNT_XPR || '100'),
    minProfitPercent: parseFloat(process.env.MIN_PROFIT_PERCENT || '0.5'),
    maxSlippagePercent: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || '1.0'),
    minPoolTvlUsd: parseFloat(process.env.MIN_POOL_TVL_USD || '100'),
    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '5000', 10),
    dryRun: (process.env.DRY_RUN || 'true').toLowerCase() === 'true',
    maxConcurrentRoutes: parseInt(process.env.MAX_CONCURRENT_ROUTES || '10', 10),
    maxRouteHops: parseInt(process.env.MAX_ROUTE_HOPS || '3', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}
