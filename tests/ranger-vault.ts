import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RangerVault } from "../target/deploy/ranger_vault-keypair.json"; // Adjust path as needed
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("ranger-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RangerVault as Program<RangerVault>;

  // Accounts
  const manager = provider.wallet as anchor.Wallet;
  const user = Keypair.generate();

  let usdcMint: PublicKey;
  let vaultUsdcAccount: PublicKey;
  let managerUsdcAccount: PublicKey;
  let userUsdcAccount: PublicKey;
  let vaultStatePDA: PublicKey;
  let userPositionPDA: PublicKey;
  let strategyStatePDA: PublicKey;

  const USDC_DECIMALS = 6;
  const USDC_AMOUNT = 100 * 10 ** USDC_DECIMALS; // 100 USDC

  before(async () => {
    console.log("Setting up test accounts...");

    // Airdrop SOL to user
    const airdropSig = await provider.connection.requestAirdrop(
      user.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);
    console.log("✅ Airdropped 2 SOL to user");

    // Create fake USDC mint (for devnet testing)
    usdcMint = await createMint(
      provider.connection,
      manager.payer,
      manager.publicKey,
      null,
      USDC_DECIMALS
    );
    console.log("✅ Created USDC mint:", usdcMint.toBase58());

    // Derive vault PDA
    [vaultStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), manager.publicKey.toBuffer()],
      program.programId
    );

    // Create vault USDC token account (owned by vault PDA)
    vaultUsdcAccount = await createAccount(
      provider.connection,
      manager.payer,
      usdcMint,
      vaultStatePDA
    );
    console.log("✅ Created vault USDC account");

    // Create manager USDC account and mint some tokens
    managerUsdcAccount = await createAccount(
      provider.connection,
      manager.payer,
      usdcMint,
      manager.publicKey
    );

    // Create user USDC account
    userUsdcAccount = await createAccount(
      provider.connection,
      user,
      usdcMint,
      user.publicKey
    );

    // Mint 1000 USDC to user for testing
    await mintTo(
      provider.connection,
      manager.payer,
      usdcMint,
      userUsdcAccount,
      manager.payer,
      1000 * 10 ** USDC_DECIMALS
    );
    console.log("✅ Minted 1000 USDC to user");

    // Derive user position PDA
    [userPositionPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        vaultStatePDA.toBuffer(),
        user.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Derive strategy PDA
    [strategyStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("strategy"), vaultStatePDA.toBuffer()],
      program.programId
    );
  });

  // ─────────────────────────────────────────────
  it("Initializes the vault", async () => {
    const minDeposit = 10 * 10 ** USDC_DECIMALS;  // 10 USDC
    const maxDrawdownBps = 500;                     // 5%
    const performanceFeeBps = 1000;                 // 10%

    await program.methods
      .initializeVault(
        new anchor.BN(minDeposit),
        maxDrawdownBps,
        performanceFeeBps
      )
      .accounts({
        vaultState: vaultStatePDA,
        manager: manager.publicKey,
        usdcMint,
        vaultUsdcAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);

    assert.equal(vault.manager.toBase58(), manager.publicKey.toBase58());
    assert.equal(vault.totalShares.toNumber(), 0);
    assert.equal(vault.totalUsdc.toNumber(), 0);
    assert.equal(vault.maxDrawdownBps, 500);
    assert.equal(vault.performanceFeeBps, 1000);
    assert.equal(vault.isPaused, false);

    console.log("✅ Vault initialized");
    console.log("   Manager:", vault.manager.toBase58());
    console.log("   Max drawdown:", vault.maxDrawdownBps, "bps");
  });

  // ─────────────────────────────────────────────
  it("Deposits USDC and mints shares", async () => {
    const depositAmount = USDC_AMOUNT; // 100 USDC

    await program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        vaultState: vaultStatePDA,
        userPosition: userPositionPDA,
        user: user.publicKey,
        userUsdcAccount,
        vaultUsdcAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    const userPos = await program.account.userPosition.fetch(userPositionPDA);
    const vaultTokenAccount = await getAccount(provider.connection, vaultUsdcAccount);

    // First deposit: shares = amount (1:1)
    assert.equal(vault.totalUsdc.toNumber(), depositAmount);
    assert.equal(vault.totalShares.toNumber(), depositAmount);
    assert.equal(userPos.shares.toNumber(), depositAmount);
    assert.equal(Number(vaultTokenAccount.amount), depositAmount);

    console.log("✅ Deposit successful");
    console.log("   Deposited:", depositAmount / 10 ** USDC_DECIMALS, "USDC");
    console.log("   Shares minted:", userPos.shares.toNumber() / 10 ** USDC_DECIMALS);
  });

  // ─────────────────────────────────────────────
  it("Opens a strategy position", async () => {
    const positionSize = 50 * 10 ** USDC_DECIMALS; // $50

    await program.methods
      .openPosition(
        new anchor.BN(positionSize),
        false,  // false = short perp (earns funding)
        "SOL"
      )
      .accounts({
        vaultState: vaultStatePDA,
        strategyState: strategyStatePDA,
        manager: manager.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const strategy = await program.account.strategyState.fetch(strategyStatePDA);

    assert.equal(strategy.isOpen, true);
    assert.equal(strategy.isLong, false);
    assert.equal(strategy.asset, "SOL");
    assert.equal(strategy.positionSizeUsdc.toNumber(), positionSize);

    console.log("✅ Position opened");
    console.log("   Asset:", strategy.asset);
    console.log("   Size:", strategy.positionSizeUsdc.toNumber() / 10 ** USDC_DECIMALS, "USDC");
    console.log("   Direction: SHORT perp");
  });

  // ─────────────────────────────────────────────
  it("Closes position and records PnL + funding", async () => {
    const pnlUsdc = 5 * 10 ** USDC_DECIMALS;       // +$5 profit
    const fundingCollected = 2 * 10 ** USDC_DECIMALS; // +$2 funding fees

    await program.methods
      .closePosition(
        new anchor.BN(pnlUsdc),
        new anchor.BN(fundingCollected)
      )
      .accounts({
        vaultState: vaultStatePDA,
        strategyState: strategyStatePDA,
        manager: manager.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    const strategy = await program.account.strategyState.fetch(strategyStatePDA);

    assert.equal(strategy.isOpen, false);
    // Vault should have grown: 100 USDC + 5 PnL + 2 funding = 107 USDC
    assert.equal(
      vault.totalUsdc.toNumber(),
      100 * 10 ** USDC_DECIMALS + pnlUsdc + fundingCollected
    );

    console.log("✅ Position closed");
    console.log("   Vault USDC:", vault.totalUsdc.toNumber() / 10 ** USDC_DECIMALS);
    console.log("   Funding collected:", strategy.fundingCollected.toNumber() / 10 ** USDC_DECIMALS, "USDC");
  });

  // ─────────────────────────────────────────────
  it("Withdraws USDC by burning shares", async () => {
    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    const userPos = await program.account.userPosition.fetch(userPositionPDA);
    const sharesToBurn = userPos.shares.divn(2); // Withdraw half

    await program.methods
      .withdraw(sharesToBurn)
      .accounts({
        vaultState: vaultStatePDA,
        userPosition: userPositionPDA,
        user: user.publicKey,
        userUsdcAccount,
        vaultUsdcAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userPosAfter = await program.account.userPosition.fetch(userPositionPDA);

    assert.isTrue(userPosAfter.shares.lt(userPos.shares));

    console.log("✅ Withdraw successful");
    console.log("   Shares before:", userPos.shares.toNumber() / 10 ** USDC_DECIMALS);
    console.log("   Shares after:", userPosAfter.shares.toNumber() / 10 ** USDC_DECIMALS);
  });

  // ─────────────────────────────────────────────
  it("Triggers drawdown guard and pauses vault", async () => {
    // Simulate a 6% loss (above our 5% limit)
    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    const bigLoss = -(vault.totalUsdc.toNumber() * 0.06);

    await program.methods
      .openPosition(
        new anchor.BN(vault.totalUsdc.toNumber() * 0.5),
        false,
        "SOL"
      )
      .accounts({
        vaultState: vaultStatePDA,
        strategyState: strategyStatePDA,
        manager: manager.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .closePosition(
        new anchor.BN(Math.floor(bigLoss)),
        new anchor.BN(0)
      )
      .accounts({
        vaultState: vaultStatePDA,
        strategyState: strategyStatePDA,
        manager: manager.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultAfter = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vaultAfter.isPaused, true);

    console.log("✅ Drawdown guard triggered — vault paused");
    console.log("   Vault is paused:", vaultAfter.isPaused);
  });
});