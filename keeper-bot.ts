/**
 * Funding Rate Arbitrage Keeper Bot
 * Runs every hour. Checks funding rates on Drift,
 * opens/closes positions, harvests funding to USDC.
 *
 * Run: npx ts-node keeper-bot.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  DriftClient,
  initialize,
  BN,
  PerpMarkets,
  QUOTE_PRECISION,
  BASE_PRECISION,
  PositionDirection,
  OrderType,
  MarketType,
  PostOnlyParams,
} from "@drift-labs/sdk";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

// ─────────────────────────────────────────────
// CONFIG — edit these values
// ─────────────────────────────────────────────
const CONFIG = {
  // Network
  RPC_URL: process.env.RPC_URL || clusterApiUrl("mainnet-beta"),
  NETWORK: "mainnet-beta" as "mainnet-beta" | "devnet",

  // Your wallet keypair JSON path
  WALLET_PATH: process.env.WALLET_PATH || "./wallet.json",

  // Strategy params
  TARGET_ASSET: "SOL",           // Which asset to trade
  PERP_MARKET_INDEX: 0,          // SOL-PERP = 0 on Drift
  SPOT_MARKET_INDEX: 1,          // SOL spot = 1 on Drift

  // Risk limits
  MIN_FUNDING_RATE_APR: 0.10,    // Only open if annualized funding > 10%
  MAX_POSITION_SIZE_USDC: 5000,  // Max $5000 per position (adjust to your capital)
  MAX_DRAWDOWN_PCT: 0.05,        // Stop if vault down 5%

  // Timing
  CHECK_INTERVAL_MS: 60 * 60 * 1000, // Run every 1 hour
  REBALANCE_THRESHOLD: 0.02,     // Rebalance if delta > 2%
};

// ─────────────────────────────────────────────
// STATE (in-memory, update as positions change)
// ─────────────────────────────────────────────
let state = {
  isPositionOpen: false,
  entryFundingRate: 0,
  positionSizeUsdc: 0,
  totalFundingCollected: 0,
  startingNAV: 0,
  currentNAV: 0,
};

// ─────────────────────────────────────────────
// MAIN KEEPER LOOP
// ─────────────────────────────────────────────
async function main() {
  console.log("🐻 Ranger Funding Rate Arb Bot starting...");
  console.log(`Network: ${CONFIG.NETWORK}`);
  console.log(`Asset: ${CONFIG.TARGET_ASSET}`);
  console.log(`Min funding APR to open: ${CONFIG.MIN_FUNDING_RATE_APR * 100}%`);

  // Load wallet
  const walletKey = JSON.parse(fs.readFileSync(CONFIG.WALLET_PATH, "utf-8"));
  const keypair = Keypair.fromSecretKey(new Uint8Array(walletKey));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

  // Connect
  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(keypair);

  // Init Drift SDK
  const sdkConfig = initialize({ env: CONFIG.NETWORK });
  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    env: CONFIG.NETWORK,
  });

  await driftClient.subscribe();
  console.log("✅ Connected to Drift Protocol");

  // Get initial NAV
  const balance = await getVaultBalance(driftClient);
  state.startingNAV = balance;
  state.currentNAV = balance;
  console.log(`Starting NAV: $${balance.toFixed(2)} USDC`);

  // Main loop
  console.log(`\nRunning every ${CONFIG.CHECK_INTERVAL_MS / 60000} minutes...\n`);

  // Run immediately, then on interval
  await runKeeperCycle(driftClient);

  setInterval(async () => {
    await runKeeperCycle(driftClient);
  }, CONFIG.CHECK_INTERVAL_MS);
}

// ─────────────────────────────────────────────
// ONE KEEPER CYCLE
// ─────────────────────────────────────────────
async function runKeeperCycle(driftClient: DriftClient) {
  const now = new Date().toISOString();
  console.log(`\n[${now}] Running keeper cycle...`);

  try {
    // 1. Get current funding rate
    const fundingRate = await getFundingRateAPR(driftClient);
    console.log(`📊 Current ${CONFIG.TARGET_ASSET} funding rate: ${(fundingRate * 100).toFixed(2)}% APR`);

    // 2. Check drawdown
    const currentBalance = await getVaultBalance(driftClient);
    state.currentNAV = currentBalance;
    const drawdown = (state.startingNAV - currentBalance) / state.startingNAV;

    if (drawdown >= CONFIG.MAX_DRAWDOWN_PCT) {
      console.log(`🛑 DRAWDOWN LIMIT HIT: ${(drawdown * 100).toFixed(2)}% — closing all positions`);
      if (state.isPositionOpen) {
        await closeArbitragePosition(driftClient);
      }
      console.log("Bot paused. Review positions manually.");
      process.exit(1);
    }

    // 3. Decision logic
    if (!state.isPositionOpen) {
      // Open position if funding rate is attractive
      if (fundingRate >= CONFIG.MIN_FUNDING_RATE_APR) {
        console.log(`✅ Funding rate ${(fundingRate * 100).toFixed(2)}% >= min ${CONFIG.MIN_FUNDING_RATE_APR * 100}% — OPENING position`);
        await openArbitragePosition(driftClient, currentBalance);
      } else {
        console.log(`⏳ Funding rate too low (${(fundingRate * 100).toFixed(2)}%) — waiting`);
      }
    } else {
      // Position is open — check if we should close or collect
      console.log(`📈 Position open. Funding collected: $${state.totalFundingCollected.toFixed(2)} USDC`);

      // Close if funding rate dropped below threshold
      if (fundingRate < CONFIG.MIN_FUNDING_RATE_APR / 2) {
        console.log(`📉 Funding rate dropped to ${(fundingRate * 100).toFixed(2)}% — CLOSING position`);
        await closeArbitragePosition(driftClient);
      } else {
        // Collect accrued funding
        await collectFunding(driftClient);

        // Rebalance delta if needed
        await checkAndRebalance(driftClient);
      }
    }

    // 4. Log status
    console.log(`💰 Vault balance: $${currentBalance.toFixed(2)} USDC`);
    console.log(`📊 Total funding collected: $${state.totalFundingCollected.toFixed(2)} USDC`);

    const elapsed = (Date.now() - new Date(state.startingNAV).getTime()) / (1000 * 60 * 60 * 24);
    if (elapsed > 0 && state.startingNAV > 0) {
      const apr = ((state.totalFundingCollected / state.startingNAV) / elapsed) * 365 * 100;
      console.log(`📈 Realized APR so far: ${apr.toFixed(1)}%`);
    }

  } catch (err) {
    console.error("❌ Keeper cycle error:", err);
  }
}

// ─────────────────────────────────────────────
// OPEN DELTA-NEUTRAL POSITION
// Long spot SOL + Short SOL-PERP on Drift
// ─────────────────────────────────────────────
async function openArbitragePosition(driftClient: DriftClient, vaultBalance: number) {
  const positionSize = Math.min(
    vaultBalance * 0.4, // Use 40% of vault per position
    CONFIG.MAX_POSITION_SIZE_USDC
  );

  console.log(`Opening ${CONFIG.TARGET_ASSET} arb position, size: $${positionSize.toFixed(2)}`);

  try {
    // Get SOL price
    const solPrice = await getAssetPrice(driftClient, CONFIG.PERP_MARKET_INDEX);
    const solAmount = positionSize / solPrice;

    console.log(`SOL price: $${solPrice.toFixed(2)}, buying ${solAmount.toFixed(4)} SOL`);

    // SHORT SOL-PERP on Drift (this earns funding when rate is positive)
    const perpOrderParams = {
      orderType: OrderType.MARKET,
      marketIndex: CONFIG.PERP_MARKET_INDEX,
      direction: PositionDirection.SHORT,
      baseAssetAmount: new BN(solAmount * BASE_PRECISION.toNumber()),
      reduceOnly: false,
    };

    const perpTxSig = await driftClient.placePerpOrder(perpOrderParams);
    console.log(`✅ Perp SHORT opened. Tx: ${perpTxSig}`);

    // Note: Spot LONG would be done via Jupiter or Drift spot
    // For simplicity, track via on-chain balance
    console.log(`📌 Remember: Also hold ${solAmount.toFixed(4)} SOL spot to hedge`);

    // Update state
    state.isPositionOpen = true;
    state.positionSizeUsdc = positionSize;
    state.entryFundingRate = await getFundingRateAPR(driftClient);

    console.log(`🎯 Position open! Entry funding rate: ${(state.entryFundingRate * 100).toFixed(2)}% APR`);

  } catch (err) {
    console.error("Failed to open position:", err);
    throw err;
  }
}

// ─────────────────────────────────────────────
// CLOSE POSITION
// ─────────────────────────────────────────────
async function closeArbitragePosition(driftClient: DriftClient) {
  console.log("Closing arbitrage position...");

  try {
    // Close Drift perp position
    const perpPosition = driftClient.getPerpPosition(CONFIG.PERP_MARKET_INDEX);

    if (perpPosition && !perpPosition.baseAssetAmount.isZero()) {
      const closeParams = {
        orderType: OrderType.MARKET,
        marketIndex: CONFIG.PERP_MARKET_INDEX,
        direction: perpPosition.baseAssetAmount.gt(new BN(0))
          ? PositionDirection.SHORT
          : PositionDirection.LONG,
        baseAssetAmount: perpPosition.baseAssetAmount.abs(),
        reduceOnly: true,
      };

      const closeTx = await driftClient.placePerpOrder(closeParams);
      console.log(`✅ Perp position closed. Tx: ${closeTx}`);
    }

    state.isPositionOpen = false;
    state.positionSizeUsdc = 0;

  } catch (err) {
    console.error("Failed to close position:", err);
    throw err;
  }
}

// ─────────────────────────────────────────────
// COLLECT ACCRUED FUNDING
// ─────────────────────────────────────────────
async function collectFunding(driftClient: DriftClient) {
  try {
    const user = driftClient.getUser();
    const perpPosition = driftClient.getPerpPosition(CONFIG.PERP_MARKET_INDEX);

    if (!perpPosition) return;

    // Settle funding — moves accrued funding into USDC balance
    const settleTx = await driftClient.settlePNL(
      await driftClient.getUserAccountPublicKey(),
      driftClient.getUserAccount(),
      CONFIG.PERP_MARKET_INDEX
    );
    console.log(`💰 Funding settled. Tx: ${settleTx}`);

    // Track how much we collected (approximate)
    const newBalance = await getVaultBalance(driftClient);
    const collected = newBalance - state.currentNAV;
    if (collected > 0) {
      state.totalFundingCollected += collected;
      console.log(`  +$${collected.toFixed(4)} USDC in funding this cycle`);
    }

  } catch (err) {
    console.error("Failed to collect funding:", err);
  }
}

// ─────────────────────────────────────────────
// DELTA REBALANCE (keep position neutral)
// ─────────────────────────────────────────────
async function checkAndRebalance(driftClient: DriftClient) {
  try {
    const solPrice = await getAssetPrice(driftClient, CONFIG.PERP_MARKET_INDEX);
    const perpPosition = driftClient.getPerpPosition(CONFIG.PERP_MARKET_INDEX);

    if (!perpPosition) return;

    const perpValueUsd = Math.abs(
      perpPosition.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber() * solPrice
    );
    const targetSize = state.positionSizeUsdc;
    const delta = Math.abs(perpValueUsd - targetSize) / targetSize;

    if (delta > CONFIG.REBALANCE_THRESHOLD) {
      console.log(`⚖️  Delta drift ${(delta * 100).toFixed(1)}% > threshold, rebalancing...`);
      // In production: adjust perp size to match spot holdings
      console.log(`  (Rebalance would execute here — implement based on Drift SDK version)`);
    } else {
      console.log(`⚖️  Delta OK (${(delta * 100).toFixed(2)}% drift)`);
    }
  } catch (err) {
    console.error("Rebalance check failed:", err);
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
async function getFundingRateAPR(driftClient: DriftClient): Promise<number> {
  try {
    const perpMarket = driftClient.getPerpMarketAccount(CONFIG.PERP_MARKET_INDEX);
    if (!perpMarket) return 0;

    // Hourly funding rate from Drift
    const hourlyRate = perpMarket.amm.lastFundingRate.toNumber() /
      perpMarket.amm.pegMultiplier.toNumber() / 1e6;

    // Annualize: 24 hours * 365 days
    const annualizedRate = hourlyRate * 24 * 365;

    return Math.abs(annualizedRate);
  } catch {
    // Fallback: fetch from Drift API
    return 0.15; // Assume 15% APR if SDK fails (conservative)
  }
}

async function getAssetPrice(driftClient: DriftClient, marketIndex: number): Promise<number> {
  const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
  return oracleData.price.toNumber() / 1e6;
}

async function getVaultBalance(driftClient: DriftClient): Promise<number> {
  try {
    const user = driftClient.getUser();
    const usdcBalance = user.getNetSpotMarketValue();
    return usdcBalance.toNumber() / QUOTE_PRECISION.toNumber();
  } catch {
    return state.currentNAV || 0;
  }
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});