import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchTool } from "../src/mcp.js"
import { createPaidServer, createAgentWallet, SpendPolicy } from "../src/index.js"
import { readWallet } from "../src/config.js"

function text(result) {
  return result.content.map((part) => part.text).join("\n")
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

test("wallet tool creates a key file and does not return the key", async () => {
  const home = mkdtempSync(join(tmpdir(), "ax402-mcp-"))
  const result = await dispatchTool("x402-wallet", {}, { home, balanceOf: async () => 1.25 })
  assert.equal(result.isError, undefined)
  const body = JSON.parse(text(result))
  assert.equal(body.usdc, 1.25)
  assert.equal("privateKey" in body, false)
  const stored = readWallet(home)
  assert.equal(stored.address, body.address)
  assert.equal(text(result).includes(stored.privateKey), false)
  assert.equal(statSync(join(home, ".config", "agent-x402", "wallet.json")).mode & 0o777, 0o600)
})

test("policy set is enforced on the next pay, and a blocked pay does not sign", async () => {
  const home = mkdtempSync(join(tmpdir(), "ax402-mcp-policy-"))
  await dispatchTool("x402-wallet", {}, { home, balanceOf: async () => 10 })
  const updated = await dispatchTool(
    "x402-policy",
    { action: "set", daily_usd: 0.001, per_request_usd: 0.001 },
    { home },
  )
  assert.match(text(updated), /policy updated/)
  assert.equal(statSync(join(home, ".config", "agent-x402", "policy.json")).mode & 0o777, 0o600)
  const saved = JSON.parse(readFileSync(join(home, ".config", "agent-x402", "policy.json"), "utf8"))
  assert.equal(saved.dailyUsd, 0.001)

  const seller = createAgentWallet()
  let settlements = 0
  const { server } = createPaidServer({
    payTo: seller.address,
    priceUsd: 0.05,
    settle: async () => {
      settlements += 1
      return { success: true, transaction: "0x" + "55".repeat(32), network: "eip155:8453" }
    },
  })
  const port = await listen(server)
  try {
    const quote = await dispatchTool(
      "x402-quote",
      { url: `http://127.0.0.1:${port}/v1/resource` },
      { home },
    )
    assert.match(text(quote), /0\.05/)
    const pay = await dispatchTool(
      "x402-pay",
      { url: `http://127.0.0.1:${port}/v1/resource` },
      { home, balanceOf: async () => 10 },
    )
    assert.equal(pay.isError, true)
    assert.match(text(pay), /policy/)
    assert.equal(settlements, 0)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("x402-pay persists a successful payment against the policy file", async () => {
  const home = mkdtempSync(join(tmpdir(), "ax402-mcp-pay-"))
  await dispatchTool("x402-wallet", {}, { home, balanceOf: async () => 10 })
  await dispatchTool("x402-policy", { action: "set", daily_usd: 2, per_request_usd: 1 }, { home })
  const seller = createAgentWallet()
  const { server } = createPaidServer({
    payTo: seller.address,
    priceUsd: 0.2,
    settle: async () => ({ success: true, transaction: "0x" + "66".repeat(32), network: "eip155:8453" }),
  })
  const port = await listen(server)
  try {
    const pay = await dispatchTool(
      "x402-pay",
      { url: `http://127.0.0.1:${port}/v1/resource` },
      { home, balanceOf: async () => 10 },
    )
    assert.equal(pay.isError, undefined)
    assert.match(text(pay), /paid 0\.2 USDC/)
    const saved = SpendPolicy.restore(
      JSON.parse(readFileSync(join(home, ".config", "agent-x402", "policy.json"), "utf8")),
    )
    assert.equal(saved.report().spentUsd, 0.2)
    assert.equal(text(pay).includes(readWallet(home).privateKey), false)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})
