/**
 * Resource server. A protected route answers 402 until the caller pays USDC
 * on Base, then the handler runs, then a facilitator settles the authorization.
 *
 * This process never holds a signing key and never broadcasts a transaction.
 * With no facilitator configured it still quotes a price, and it refuses to
 * deliver the resource.
 */
import { createServer } from "node:http"
import { getAddress, isAddress, verifyTypedData } from "viem"
import { cdpBearerToken } from "./cdp-auth.js"
import {
  BASE_NETWORK,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_BASE,
  USDC_BASE_DOMAIN,
  X402Error,
  atomicToUsd,
  chainIdFromNetwork,
  domainFor,
  parseRequirements,
  usdToAtomic,
} from "./x402.js"

const BODY_LIMIT = 64 * 1024

export function buildPaymentRequired({
  url,
  payTo,
  amount,
  description,
  network = BASE_NETWORK,
  asset = USDC_BASE,
  maxTimeoutSeconds = 60,
  extra,
}) {
  const requirement = {
    scheme: "exact",
    network,
    amount: String(amount),
    asset,
    payTo,
    maxTimeoutSeconds,
    extra: extra ?? {
      assetTransferMethod: "eip3009",
      name: USDC_BASE_DOMAIN.name,
      version: USDC_BASE_DOMAIN.version,
    },
  }
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url,
      description: description || "Paid request",
      mimeType: "application/json",
    },
    accepts: [requirement],
  }
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right)
  } catch {
    return false
  }
}

function decimal(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

/**
 * Local check of a payment payload against the requirement this server issued.
 * Does not submit the transfer.
 */
export async function verifyAuthorization(payment, requirement, now = Math.floor(Date.now() / 1000)) {
  const accepted = payment?.accepted
  const authorization = payment?.payload?.authorization
  const signature = payment?.payload?.signature
  if (!accepted || !authorization || typeof signature !== "string") {
    return { ok: false, reason: "malformed_payload" }
  }
  if (accepted.scheme !== "exact" || requirement.scheme !== "exact") {
    return { ok: false, reason: "unsupported_scheme" }
  }
  if (accepted.network !== requirement.network) return { ok: false, reason: "network_mismatch" }
  if (!sameAddress(accepted.asset, requirement.asset)) return { ok: false, reason: "asset_mismatch" }
  if (!sameAddress(accepted.payTo, requirement.payTo) || !sameAddress(authorization.to, requirement.payTo)) {
    return { ok: false, reason: "recipient_mismatch" }
  }
  const requiredAmount = decimal(String(requirement.amount))
  const authorized = decimal(authorization.value)
  const acceptedAmount = decimal(String(accepted.amount))
  if (requiredAmount == null || authorized == null || acceptedAmount == null) {
    return { ok: false, reason: "bad_amount" }
  }
  if (authorized !== requiredAmount || acceptedAmount !== requiredAmount) {
    return { ok: false, reason: "amount_mismatch" }
  }
  const validAfter = decimal(authorization.validAfter)
  const validBefore = decimal(authorization.validBefore)
  if (validAfter == null || validBefore == null) return { ok: false, reason: "bad_window" }
  const after = Number(validAfter)
  const before = Number(validBefore)
  const timeout = Number(requirement.maxTimeoutSeconds || 60)
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(before)) {
    return { ok: false, reason: "bad_window" }
  }
  if (after > now + 10 || before <= now || before - after > timeout + 10) {
    return { ok: false, reason: "authorization_window" }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce || "")) return { ok: false, reason: "bad_nonce" }
  if (!isAddress(authorization.from)) return { ok: false, reason: "bad_payer" }
  let chainId
  try {
    chainId = chainIdFromNetwork(requirement.network)
  } catch {
    return { ok: false, reason: "unsupported_network" }
  }
  let signed = false
  try {
    signed = await verifyTypedData({
      address: authorization.from,
      domain: domainFor(requirement.asset, chainId, requirement.extra || {}),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: authorized,
        validAfter,
        validBefore,
        nonce: authorization.nonce,
      },
      signature,
    })
  } catch {
    signed = false
  }
  if (!signed) return { ok: false, reason: "invalid_signature" }
  return {
    ok: true,
    payer: getAddress(authorization.from),
    nonce: authorization.nonce.toLowerCase(),
    amountAtomic: authorized.toString(),
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("body too large"), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function assertFacilitatorUrl(url) {
  if (!url) return
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new X402Error("facilitator URL is invalid", "bad_facilitator")
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
  if (parsed.protocol === "https:") return
  if (parsed.protocol === "http:" && local) return
  throw new X402Error("facilitator URL must be https", "bad_facilitator")
}

async function postFacilitator(fetchImpl, facilitatorUrl, path, body, auth) {
  const endpoint = facilitatorUrl.replace(/\/$/, "") + path
  const headers = { "content-type": "application/json", accept: "application/json" }
  if (auth.facilitatorAuth) headers.authorization = auth.facilitatorAuth
  else if (auth.cdpApiKeyId && auth.cdpApiKeySecret) {
    headers.authorization =
      "Bearer " +
      cdpBearerToken({
        apiKeyId: auth.cdpApiKeyId,
        apiKeySecret: auth.cdpApiKeySecret,
        method: "POST",
        url: endpoint,
      })
  }
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const payload = await response.json().catch(() => ({}))
  return { response, payload, endpoint }
}

const defaultRoutes = {
  "GET /v1/resource": {
    description: "Example paid resource",
    handler: async () => ({ status: 200, body: { ok: true, service: "agent-x402" } }),
  },
  "POST /v1/echo": {
    description: "Example paid echo",
    handler: async (_req, body) => {
      if (!body.length) return { status: 200, body: { echo: null } }
      try {
        return { status: 200, body: { echo: JSON.parse(body.toString("utf8")) } }
      } catch {
        return { status: 400, body: { error: "invalid_json" } }
      }
    },
  },
}

function normalizeRoutes(routes, priceUsd) {
  const map = new Map()
  for (const [key, value] of Object.entries(routes)) {
    if (typeof value === "function") map.set(key, { priceUsd, handler: value, description: key })
    else {
      map.set(key, {
        priceUsd: value.priceUsd ?? priceUsd,
        handler: value.handler,
        description: value.description || key,
      })
    }
  }
  return map
}

/**
 * @param {object} opts
 * @param {string} opts.payTo address that receives USDC
 * @param {number} [opts.priceUsd]
 * @param {string} [opts.facilitatorUrl]
 * @param {string} [opts.facilitatorAuth] full Authorization header value, if the owner already has one
 * @param {string} [opts.cdpApiKeyId]
 * @param {string} [opts.cdpApiKeySecret]
 * @param {string} [opts.publicUrl] origin advertised in the 402, no trailing path
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(payment: object, requirement: object) => Promise<object>} [opts.settle]
 * @param {(payment: object, requirement: object) => Promise<{ok: boolean, reason?: string}>} [opts.verifyRemote]
 */
export function createPaidServer(opts) {
  if (!opts?.payTo || !isAddress(opts.payTo)) {
    throw new X402Error("payTo must be an EVM address", "bad_payee")
  }
  const payTo = getAddress(opts.payTo)
  const priceUsd = opts.priceUsd ?? 0.01
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new X402Error("priceUsd must be a positive number", "bad_amount")
  }
  assertFacilitatorUrl(opts.facilitatorUrl)
  if (opts.publicUrl) {
    const pub = new URL(opts.publicUrl)
    if (!["https:", "http:"].includes(pub.protocol)) {
      throw new X402Error("public URL must be http or https", "bad_url")
    }
  }
  const routes = normalizeRoutes(opts.routes ?? defaultRoutes, priceUsd)
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const seen = new Set()
  const inflight = new Set()
  const stats = { requests: 0, paid: 0, revenueUsd: 0, payments: [] }

  function settlementMode() {
    if (typeof opts.settle === "function") return "custom"
    if (!opts.facilitatorUrl) return "not_configured"
    if (opts.facilitatorAuth || (opts.cdpApiKeyId && opts.cdpApiKeySecret)) return "facilitator"
    return "missing_credentials"
  }

  function resourceUrl(req, path) {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/$/, "") + path
    const host = req.headers.host || "127.0.0.1"
    return `http://${host}${path}`
  }

  const server = createServer(async (req, res) => {
    const send = (status, body, extra = {}) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        ...extra,
      })
      res.end(payload)
    }

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        })
        res.end()
        return
      }

      const path = (req.url || "/").split("?")[0]
      if (req.method === "GET" && (path === "/" || path === "/health")) {
        send(200, {
          ok: true,
          payTo,
          priceUsd,
          network: BASE_NETWORK,
          asset: USDC_BASE,
          settlement: settlementMode(),
          routes: [...routes.keys()],
        })
        return
      }
      if (req.method === "GET" && path === "/stats") {
        send(200, stats)
        return
      }

      const route = routes.get(`${req.method} ${path}`)
      if (!route) {
        send(404, { error: "not_found" })
        return
      }

      const body = await readBody(req)
      const amount = usdToAtomic(route.priceUsd)
      const required = buildPaymentRequired({
        url: resourceUrl(req, path),
        payTo,
        amount,
        description: route.description,
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
      })
      const requirement = required.accepts[0]
      const header = req.headers["payment-signature"] || req.headers["x-payment"]
      if (!header || Array.isArray(header)) {
        send(402, required, {
          "payment-required": Buffer.from(JSON.stringify(required)).toString("base64"),
        })
        return
      }

      const payment = parseRequirements(header)
      const verdict = await verifyAuthorization(payment, requirement)
      if (!verdict.ok) {
        send(402, { error: verdict.reason })
        return
      }
      if (payment.resource?.url && payment.resource.url !== required.resource.url) {
        send(402, { error: "resource_mismatch" })
        return
      }
      if (seen.has(verdict.nonce) || inflight.has(verdict.nonce)) {
        send(409, { error: "replayed_payment" })
        return
      }

      const mode = settlementMode()
      if (mode === "not_configured" || mode === "missing_credentials") {
        send(503, { error: mode })
        return
      }

      inflight.add(verdict.nonce)
      try {
        const envelope = {
          x402Version: 2,
          paymentPayload: payment,
          paymentRequirements: requirement,
        }
        if (opts.facilitatorUrl && typeof opts.settle !== "function") {
          const verified = await postFacilitator(fetchImpl, opts.facilitatorUrl, "/verify", envelope, opts)
          if (!verified.response.ok || verified.payload.isValid === false) {
            send(402, { error: verified.payload.invalidReason || "verify_failed" })
            return
          }
        } else if (opts.verifyRemote) {
          const remote = await opts.verifyRemote(payment, requirement)
          if (!remote?.ok) {
            send(402, { error: remote?.reason || "verify_failed" })
            return
          }
        }

        const handled = await route.handler(req, body, {
          payer: verdict.payer,
          amountUsd: atomicToUsd(verdict.amountAtomic),
        })
        const status = handled?.status ?? 200
        if (status < 200 || status >= 300) {
          send(status, handled?.body ?? { error: "handler_failed" })
          return
        }

        let settled
        if (typeof opts.settle === "function") settled = await opts.settle(payment, requirement)
        else {
          const response = await postFacilitator(fetchImpl, opts.facilitatorUrl, "/settle", envelope, opts)
          settled =
            response.response.ok && response.payload.success !== false
              ? response.payload
              : { success: false, errorReason: response.payload.errorReason || "settle_failed" }
        }
        if (!settled?.success) {
          send(502, { error: settled?.errorReason || "settle_failed" })
          return
        }

        seen.add(verdict.nonce)
        const amountUsd = atomicToUsd(verdict.amountAtomic)
        stats.requests += 1
        stats.paid += 1
        stats.revenueUsd = Math.round((stats.revenueUsd + amountUsd) * 1e6) / 1e6
        stats.payments.push({
          amountUsd,
          payer: verdict.payer,
          transaction: settled.transaction || null,
          ts: Date.now(),
        })
        if (stats.payments.length > 50) stats.payments.shift()
        const settlement = {
          success: true,
          transaction: settled.transaction || "",
          network: settled.network || requirement.network,
          payer: verdict.payer,
        }
        send(status, handled.body ?? { ok: true }, {
          "payment-response": Buffer.from(JSON.stringify(settlement)).toString("base64"),
        })
      } finally {
        inflight.delete(verdict.nonce)
      }
    } catch (error) {
      if (res.headersSent || res.writableEnded) return
      const status = error?.status === 413 ? 413 : 500
      send(status, { error: status === 413 ? "body_too_large" : "internal_error" })
    }
  })

  return { server, stats, payTo, priceUsd, settlementMode, routes: [...routes.keys()] }
}
