/**
 * x402 protocol client.
 *
 * Flow (x402 v2 "exact" scheme, EIP-3009 on Base mainnet):
 *   1. request the endpoint -> 402 with a base64 `PAYMENT-REQUIRED` header
 *   2. parse the accepted payment options
 *   3. check the spend policy, then the USDC balance
 *   4. sign an EIP-3009 transferWithAuthorization
 *   5. retry with the signed payment in `PAYMENT-SIGNATURE`
 *
 * The buyer pays per call. Nothing is broadcast from this process: the
 * resource server's facilitator submits the authorization.
 */

import { createPublicClient, http, erc20Abi, formatUnits } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { base } from "viem/chains"
import { randomBytes } from "node:crypto"

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
export const USDC_BASE_DOMAIN = { name: "USD Coin", version: "2" }
export const BASE_NETWORK = "eip155:8453"
const USDC_DECIMALS = 6

export class X402Error extends Error {
  constructor(message, code) {
    super(message)
    this.name = "X402Error"
    this.code = code
  }
}

/** Create a fresh EVM wallet for agent payments. */
export function createAgentWallet() {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  return { address: account.address, privateKey, account }
}

/** Parse a base64 JSON payment header, or a raw JSON header. */
export function parseRequirements(header) {
  if (!header || typeof header !== "string") return null
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

/** True for Base mainnet. Base Sepolia (84532) does not match. */
export function isBaseNetwork(network) {
  return /(^|:)8453$/.test(String(network || ""))
}

/** Pick the exact-scheme option we can satisfy. */
export function pickOption(requirements, { network } = {}) {
  const accepts = requirements?.accepts || []
  const exact = accepts.filter((option) => !option.scheme || option.scheme === "exact")
  const pool = exact.length ? exact : accepts
  if (network) {
    return (
      pool.find((option) => option.network === network || String(option.network || "").endsWith(":" + network)) ||
      null
    )
  }
  return pool.find((option) => isBaseNetwork(option.network)) || null
}

/** EIP-3009 domain for a token. `extra` carries the name and version the server advertised. */
export function domainFor(asset, chainId = 8453, extra = {}) {
  return {
    name: extra.name || USDC_BASE_DOMAIN.name,
    version: extra.version || USDC_BASE_DOMAIN.version,
    chainId,
    verifyingContract: asset,
  }
}

export function chainIdFromNetwork(network = BASE_NETWORK) {
  const match = /^eip155:(\d+)$/.exec(String(network || ""))
  if (!match) throw new X402Error(`unsupported network ${network}`, "unsupported_network")
  return Number(match[1])
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
 * Authorization fields are decimal strings so the payload survives JSON.stringify.
 */
export async function signPayment({ account, asset, to, amount, validAfter, validBefore, nonce, network, extra }) {
  const chainId = chainIdFromNetwork(network || BASE_NETWORK)
  const message = {
    from: account.address,
    to,
    value: BigInt(amount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  }
  const signature = await account.signTypedData({
    domain: domainFor(asset, chainId, extra),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  })
  const authorization = {
    from: account.address,
    to,
    value: message.value.toString(),
    validAfter: message.validAfter.toString(),
    validBefore: message.validBefore.toString(),
    nonce,
  }
  return {
    signature,
    authorization,
    payload: { signature, authorization },
  }
}

/** 32-byte CSPRNG nonce. Address and salt are ignored so the nonce is not derived from predictable inputs. */
export function makeNonce(_address, _salt) {
  return "0x" + randomBytes(32).toString("hex")
}

export function usdToAtomic(usd, decimals = USDC_DECIMALS) {
  const amount = Number(usd)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new X402Error("price must be a positive finite number", "bad_amount")
  }
  const scale = 10 ** decimals
  const atomic = Math.round(amount * scale)
  if (!Number.isSafeInteger(atomic) || atomic < 1) {
    throw new X402Error("price is outside the supported USDC range", "bad_amount")
  }
  return String(atomic)
}

export function atomicToUsd(atomic, decimals = USDC_DECIMALS) {
  const value = typeof atomic === "bigint" ? atomic : BigInt(atomic)
  const negative = value < 0n
  const abs = negative ? -value : value
  const scale = 10n ** BigInt(decimals)
  const whole = abs / scale
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "")
  const text = fraction ? `${whole.toString()}.${fraction}` : whole.toString()
  const amount = Number(text)
  if (!Number.isFinite(amount)) throw new X402Error("amount is too large", "bad_amount")
  return negative ? -amount : amount
}

/** USDC balance of an address on Base. */
export async function usdcBalance(address, chain = base, rpcUrl) {
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl || undefined, { timeout: 10_000 }),
  })
  const raw = await client.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  })
  return Number(formatUnits(raw, USDC_DECIMALS))
}

function domainExtra(option) {
  const known =
    String(option.asset || "").toLowerCase() === USDC_BASE.toLowerCase() ? USDC_BASE_DOMAIN : null
  const name = option.extra?.name || known?.name
  const version = option.extra?.version || known?.version
  if (!name || !version) {
    throw new X402Error(
      "server did not include the token EIP-712 name and version",
      "bad_requirements",
    )
  }
  return { name, version }
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
   * @param {string} [opts.rpcUrl] Base JSON-RPC URL. Defaults to the public endpoint, or BASE_RPC_URL.
   * @param {(address: string) => Promise<number>} [opts.balanceOf] override the USDC balance read (tests)
   */
  constructor(opts = {}) {
    if (opts.privateKey && !/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) {
      throw new X402Error("privateKey must be a 0x-prefixed 64-hex-character string", "bad_private_key")
    }
    this.account = opts.privateKey ? privateKeyToAccount(opts.privateKey) : null
    this.policy = opts.policy ?? null
    this.network = opts.network ?? BASE_NETWORK
    this.headerName = opts.headerName ?? "PAYMENT-SIGNATURE"
    this.chain = opts.chain ?? base
    this.rpcUrl = opts.rpcUrl ?? process.env.BASE_RPC_URL ?? undefined
    this.balanceOf =
      opts.balanceOf ?? ((address) => usdcBalance(address, this.chain, this.rpcUrl))
    /** @type {Array<object>} */
    this.log = []
  }

  get address() {
    return this.account?.address ?? null
  }

  /**
   * Perform a request, paying with x402 when the server asks for it.
   * Spend is recorded only after the paid response succeeds.
   *
   * @param {string} url
   * @param {object} [init]
   * @param {boolean} [init.dryRun] parse the 402 but do not pay
   */
  async fetch(url, init = {}) {
    const parsed = new URL(url)
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new X402Error(`unsupported URL protocol: ${parsed.protocol}`, "bad_url")
    }
    const method = (init.method || "GET").toUpperCase()
    const headers = { accept: "application/json", ...(init.headers || {}) }
    if (init.body != null && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json"
    }
    const doRequest = async (extra = {}) => {
      const body = init.body == null ? undefined : JSON.stringify(init.body)
      return fetch(url, {
        method,
        headers: { ...headers, ...extra },
        body,
        signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
      })
    }

    let res = await doRequest()
    if (res.status !== 402) return { response: res, paid: false, body: await res.text() }
    await res.arrayBuffer().catch(() => {})

    const required = parseRequirements(res.headers.get("payment-required"))
    if (!required) throw new X402Error("server returned 402 without payment requirements", "bad_requirements")
    const option = pickOption(required, { network: this.network })
    if (!option) throw new X402Error("no acceptable payment option in the response", "no_option")

    let atomic
    try {
      atomic = BigInt(option.amount ?? option.maxAmountRequired)
    } catch {
      throw new X402Error("payment amount is not an integer", "bad_amount")
    }
    if (atomic <= 0n) throw new X402Error("payment amount must be positive", "bad_amount")
    const decimals = Number(option.extra?.decimals ?? USDC_DECIMALS)
    const amountUsd = atomicToUsd(atomic, decimals)

    if (init.dryRun) {
      return {
        response: res,
        paid: false,
        dryRun: true,
        requirements: required,
        option,
        amountUsd,
      }
    }

    if (!isBaseNetwork(option.network)) {
      throw new X402Error(
        `only Base mainnet (${BASE_NETWORK}) is supported, got ${option.network || "unknown"}`,
        "unsupported_network",
      )
    }
    if (!option.asset || option.asset.toLowerCase() !== USDC_BASE.toLowerCase()) {
      throw new X402Error(`unsupported asset ${option.asset || "unknown"}`, "unsupported_asset")
    }
    if (!option.payTo) throw new X402Error("payment option is missing payTo", "bad_requirements")

    let releaseHold = null
    if (this.policy) {
      try {
        releaseHold = this.policy.reserve({
          amount: amountUsd,
          payTo: option.payTo,
          asset: option.asset,
          network: option.network,
        })
      } catch (error) {
        throw new X402Error(`policy blocked the payment: ${error.message}`, "policy")
      }
    }

    if (!this.account) {
      releaseHold?.()
      throw new X402Error("no wallet configured for this client", "no_wallet")
    }

    let paid = false
    try {
      const bal = await this.balanceOf(this.account.address)
      if (bal < amountUsd) {
        throw new X402Error(`insufficient USDC: need ${amountUsd}, wallet holds ${bal}`, "insufficient_funds")
      }

      const now = Math.floor(Date.now() / 1000)
      const timeout = Number(option.maxTimeoutSeconds || 60)
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new X402Error("invalid maxTimeoutSeconds", "bad_requirements")
      }
      const extra = domainExtra(option)
      const { signature, authorization } = await signPayment({
        account: this.account,
        asset: option.asset,
        to: option.payTo,
        amount: atomic.toString(),
        validAfter: String(now),
        validBefore: String(now + timeout),
        nonce: makeNonce(),
        network: option.network,
        extra,
      })
      const paymentPayload = {
        x402Version: 2,
        resource: required.resource,
        accepted: option,
        payload: { signature, authorization },
      }
      const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString("base64")
      res = await doRequest({
        [this.headerName]: encoded,
        "PAYMENT-SIGNATURE": encoded,
        "X-PAYMENT": encoded,
      })
      const text = await res.text()
      const settlement = parseRequirements(res.headers.get("payment-response"))
      paid = res.ok
      if (paid) this.log.push({ url, amountUsd, network: option.network, status: res.status })
      return { response: res, paid, body: text, amountUsd, option, settlement }
    } finally {
      if (!paid) releaseHold?.()
    }
  }
}
