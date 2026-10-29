#!/usr/bin/env node
/**
 * Paid resource server. Quotes an x402 price and, once a facilitator is configured,
 * settles USDC to X402_PAY_TO. No private key is read from disk.
 *
 *   X402_PAY_TO=0x... X402_PRICE_USD=0.01 \
 *   X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402 \
 *   CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... \
 *   X402_PUBLIC_URL=https://pay.example.com \
 *   ax402-serve
 */
import { createPaidServer } from "../src/seller.js"
import { isAddress } from "viem"

const payTo = process.env.X402_PAY_TO || ""
if (!isAddress(payTo)) {
  console.error("Set X402_PAY_TO to the Base address that should receive USDC.")
  process.exit(1)
}
const priceUsd = Number(process.env.X402_PRICE_USD || "0.01")
if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
  console.error("X402_PRICE_USD must be a positive number of USDC per call.")
  process.exit(1)
}

const { server, settlementMode } = createPaidServer({
  payTo,
  priceUsd,
  publicUrl: process.env.X402_PUBLIC_URL || undefined,
  facilitatorUrl: process.env.X402_FACILITATOR_URL || undefined,
  facilitatorAuth: process.env.X402_FACILITATOR_AUTH || undefined,
  cdpApiKeyId: process.env.CDP_API_KEY_ID || undefined,
  cdpApiKeySecret: process.env.CDP_API_KEY_SECRET || undefined,
  description: process.env.X402_DESCRIPTION || "Paid agent-x402 endpoint",
})

const port = Number(process.env.PORT || 8787)
const host = process.env.X402_HOST || "127.0.0.1"
server.listen(port, host, () => {
  const actual = server.address()
  console.log(`[agent-x402] listening on ${host}:${actual.port}`)
  console.log(`[agent-x402] payTo ${payTo} · ${priceUsd} USDC · settlement ${settlementMode()}`)
})
