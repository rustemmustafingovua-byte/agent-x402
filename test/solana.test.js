import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickOption,
  createSolanaAgentWallet,
  signSolanaPayment,
  solanaBalance,
  SOLANA_MAINNET,
  USDC_SOLANA,
} from "../src/index.js";
import nacl from "tweetnacl";

test("pickOption correctly selects solana:5eykt4UsFv8P8NJdTREY1vzqKqZKvdp", () => {
  const req = {
    accepts: [
      { network: "eip155:8453", amount: "2000000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      { network: SOLANA_MAINNET, amount: "1000000", asset: USDC_SOLANA },
    ],
  };

  const selected = pickOption(req, { network: SOLANA_MAINNET });
  assert.ok(selected);
  assert.equal(selected.network, SOLANA_MAINNET);
  assert.equal(selected.amount, "1000000");
});

test("createSolanaAgentWallet generates valid base58 address and keypair", () => {
  const wallet = createSolanaAgentWallet();
  assert.match(wallet.address, /^[1-9A-HJ-NP-za-km-z]{32,44}$/);
  assert.equal(wallet.keypair.secretKey.length, 64);
});

test("signs SPL transferWithAuthorization on Solana and validates Ed25519 signature", async () => {
  const wallet = createSolanaAgentWallet();
  const recipient = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const now = Math.floor(Date.now() / 1000);

  const payment = await signSolanaPayment({
    keypair: wallet.keypair,
    to: recipient,
    amount: "1500000",
    mint: USDC_SOLANA,
    validAfter: now - 30,
    validBefore: now + 3600,
  });

  assert.equal(payment.payload.network, SOLANA_MAINNET);
  assert.equal(payment.payload.scheme, "exact");
  assert.equal(payment.authorization.to, recipient);

  const messageBytes = Buffer.from(JSON.stringify(payment.authorization));
  const sigBytes = Buffer.from(payment.signature, "base64");
  const isValid = nacl.sign.detached.verify(messageBytes, sigBytes, wallet.keypair.publicKey);
  assert.equal(isValid, true);
});

test("local validator integration respects connection endpoints", async () => {
  const rpcUrl = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const bal = await solanaBalance("11111111111111111111111111111111", rpcUrl);
  assert.equal(typeof bal, "number");
});
