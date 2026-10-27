/**
 * x402 protocol client.
 *
 * Flow (per the x402 spec, v2 "exact" scheme on Base):
 *   1. request the endpoint -> 402 with a `payment-required` header
 *   2. parse the accepted payment options
 *   3. check the wallet balance and the spend policy
 *   4. sign an EIP-3009 `transferWithAuthorization` for USDC
 *   5. retry with the signed payment in `SIGN-IN-WITH-X` (Venice) /
 *      `X-PAYMENT` / `PAYMENT-SIGNATURE` (other servers)
 *
 * No account, no API key, no subscription: the buyer pays per call.
 */

import { createPublicClient, http, erc20Abi, formatUnits } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { base } from "viem/chains"
import { randomBytes } from "node:crypto"

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

export class X402Error extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/** Create a fresh EVM wallet for agent payments. */
export function createAgentWallet() {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  return { address: account.address, privateKey, account }
}

/** Parse the `payment-required` header (base64 JSON). */
export function parseRequirements(header) {
  if (!header) return null
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"))
  } catch {
    try {
      return JSON.parse(header)
    } catch {
      return null
    }
  }
}

/** Pick the payment option we can satisfy. */
export function pickOption(requirements, { network } = {}) {
  const accepts = requirements?.accepts || []
  if (network) return accepts.find((a) => (a.network || "").includes(network)) || null
  return accepts.find((a) => (a.network || "").includes("8453")) || accepts[0] || null
}

/** EIP-3009 domain for a token. */
export function domainFor(asset, chainId = 8453) {
  return { name: "USD Coin", version: "2", chainId, verifyingContract: asset }
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
}

/**
 * Sign a USDC transferWithAuthorization.
 * @returns {Promise<{payload: object, authorization: object, signature: string}>}
 */
export async function signPayment({ account, asset, to, amount, validAfter, validBefore, nonce }) {
  const value = BigInt(amount)
  const message = {
    from: account.address,
    to,
    value,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  }
  const signature = await account.signTypedData({
    domain: domainFor(asset),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  })
  return {
    payload: { x402Version: 2, scheme: "exact", payload: { signature, authorization: message } },
    authorization: message,
    signature,
  }
}

/** Build a random 32-byte nonce. */
export function makeNonce(address, salt = Date.now()) {
  const rand = randomBytes(16).toString("hex")
  const hex = Buffer.from(`${address}:${salt}:${rand}`).toString("hex")
  return "0x" + hex.slice(0, 64).padEnd(64, "0")
}

/** USDC balance of an address on Base. */
export async function usdcBalance(address, chain = base) {
  const client = createPublicClient({ chain, transport: http() })
  const raw = await client.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  })
  return Number(formatUnits(raw, 6))
}

/**
 * A reusable x402 client.
 */
export class X402Client {
  /**
   * @param {object} opts
   * @param {string} [opts.privateKey] agent wallet private key
   * @param {import("./policy.js").SpendPolicy} [opts.policy]
   * @param {string} [opts.network] preferred network, e.g. "eip155:8453"
   * @param {string} [opts.headerName] header used to carry the payment
   */
  constructor(opts = {}) {
    if (opts.privateKey && !/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) {
      throw new X402Error("privateKey must be a 0x-prefixed 64-hex-character string", "bad_private_key")
    }
    this.account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null
    this.policy = opts.policy ?? null
    this.network = opts.network ?? "eip155:8453"
    this.headerName = opts.headerName ?? "SIGN-IN-WITH-X"
    this.chain = opts.chain ?? base
    /** @type {Array<object>} */
    this.log = []
  }

  get address() {
    return this.account?.address ?? null
  }

  /**
   * Perform a request, paying with x402 when the server asks for it.
   *
   * @param {string} url
   * @param {object} [init]
   * @param {string} [init.method]
   * @param {object} [init.body] JSON body
   * @param {object} [init.headers]
   * @param {boolean} [init.dryRun] parse the 402 but do not pay
   */
  async fetch(url, init = {}) {
    const parsed = new URL(url)
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new X402Error(`unsupported URL protocol: ${parsed.protocol}`, "bad_url")
    }
    const method = (init.method || "GET").toUpperCase()
    const headers = { "Content-Type": "application/json", ...(init.headers || {}) }
    const doRequest = async (extra = {}) => {
      const h = { ...headers, ...extra }
      const body = init.body == null ? undefined : JSON.stringify(init.body)
      return fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) })
    }

    let res = await doRequest()
    if (res.status !== 402) return { response: res, paid: false, body: await res.text() }

    const req = parseRequirements(res.headers.get("payment-required"))
    if (!req) throw new X402Error("server returned 402 without payment requirements", "bad_requirements")
    const opt = pickOption(req, { network: this.network })
    if (!opt) throw new X402Error("no acceptable payment option in the response", "no_option")
    const amount = Number(opt.amount ?? opt.maxAmountRequired ?? 0)
    const amountUsd = amount / 1e6

    if (init.dryRun) {
      return {
        response: res,
        paid: false,
        dryRun: true,
        requirements: req,
        option: opt,
        amountUsd,
      }
    }

    if (this.policy) {
      const verdict = this.policy.check({
        amount: amountUsd,
        payTo: opt.payTo,
        asset: opt.asset,
        network: opt.network,
      })
      if (!verdict.allowed) throw new X402Error(`policy blocked the payment: ${verdict.reason}`, "policy")
    }

    if (!this.account) throw new X402Error("no wallet configured for this client", "no_wallet")
    const bal = await usdcBalance(this.account.address, this.chain)
    if (bal < amountUsd)
      throw new X402Error(
        `insufficient USDC: need ${amountUsd}, wallet holds ${bal}`,
        "insufficient_funds",
      )

    const now = Math.floor(Date.now() / 1000)
    const { payload } = await signPayment({
      account: this.account,
      asset: opt.asset,
      to: opt.payTo,
      amount,
      validAfter: String(now - 60),
      validBefore: String(now + 3600),
      nonce: makeNonce(this.account.address),
    })
    const encoded = Buffer.from(JSON.stringify({ ...payload, resource: req.resource })).toString("base64")
    res = await doRequest({
      [this.headerName]: encoded,
      "X-PAYMENT": encoded,
      "PAYMENT-SIGNATURE": encoded,
    })
    const text = await res.text()
    this.log.push({ url, amountUsd, network: opt.network, status: res.status })
    if (this.policy) {
      this.policy.commit({ amount: amountUsd, network: opt.network })
    }
    return { response: res, paid: true, body: text, amountUsd, option: opt }
  }
}
