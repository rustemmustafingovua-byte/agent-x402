import { test } from "node:test"
import assert from "node:assert/strict"
import { SpendPolicy } from "../src/policy.js"
import { X402Client, pickOption, parseRequirements } from "../src/index.js"

test("the policy blocks a payment before the client signs", async () => {
  const policy = new SpendPolicy({ dailyUsd: 0, perRequestUsd: 10 })
  const client = new X402Client({ policy })
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const req = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "5000000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0xabc",
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    }
    return new Response("", {
      status: 402,
      headers: { "payment-required": Buffer.from(JSON.stringify(req)).toString("base64") },
    })
  }
  try {
    await assert.rejects(() => client.fetch("https://example.com/x", { method: "POST" }), /policy blocked/)
    assert.equal(calls, 1)
    assert.equal(policy.report().spentUsd, 0)
  } finally {
    globalThis.fetch = original
  }
})

test("quote mode never signs and reports the price", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const req = {
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", payTo: "0xabc" }],
    }
    return new Response("", {
      status: 402,
      headers: { "payment-required": Buffer.from(JSON.stringify(req)).toString("base64") },
    })
  }
  try {
    const client = new X402Client({})
    const res = await client.fetch("https://example.com/x", { dryRun: true })
    assert.equal(res.paid, false)
    assert.equal(res.amountUsd, 0.001)
  } finally {
    globalThis.fetch = original
  }
})

test("requirements parse and option selection prefers Base", () => {
  const req = {
    accepts: [
      { network: "solana:5eykt", amount: "1" },
      { network: "eip155:8453", amount: "2" },
    ],
  }
  const parsed = parseRequirements(Buffer.from(JSON.stringify(req)).toString("base64"))
  assert.equal(pickOption(parsed, { network: "eip155:8453" }).amount, "2")
  assert.equal(pickOption(parsed, {}).amount, "2")
})
