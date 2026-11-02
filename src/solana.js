import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREY1vzqKqZKvdp";
export const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(buffer) {
  const bytes = Buffer.from(buffer);
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < digits.length; j++) digits[j] <<= 8;
    digits[0] += bytes[i];
    let carry = 0;
    for (let j = 0; j < digits.length; j++) {
      digits[j] += carry;
      carry = (digits[j] / 58) | 0;
      digits[j] %= 58;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) digits.push(0);
  return digits.reverse().map((d) => ALPHABET[d]).join("");
}

export function createSolanaAgentWallet() {
  const kp = nacl.sign.keyPair();
  return {
    address: toBase58(kp.publicKey),
    secretKeyHex: Buffer.from(kp.secretKey).toString("hex"),
    keypair: kp,
  };
}

export function makeSolanaNonce(address, salt = Date.now()) {
  const rand = randomBytes(16).toString("hex");
  return Buffer.from(address + ":" + salt + ":" + rand).toString("hex").slice(0, 64);
}

export async function signSolanaPayment({
  keypair,
  to,
  amount,
  mint = USDC_SOLANA,
  validAfter,
  validBefore,
  nonce,
}) {
  const fromPubkey = toBase58(keypair.publicKey);
  const authMessage = {
    chain: SOLANA_MAINNET,
    asset: mint,
    from: fromPubkey,
    to,
    amount: String(amount),
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce: nonce || makeSolanaNonce(fromPubkey),
  };

  const messageBytes = Buffer.from(JSON.stringify(authMessage));
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  const signature = Buffer.from(signatureBytes).toString("base64");

  return {
    payload: {
      x402Version: 2,
      scheme: "exact",
      network: SOLANA_MAINNET,
      payload: {
        signature,
        authorization: authMessage,
      },
    },
    authorization: authMessage,
    signature,
  };
}

export async function solanaBalance(address, rpcUrl = "http://127.0.0.1:8899") {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [address],
      }),
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    return data.result?.value ?? 0;
  } catch {
    return 0;
  }
}
