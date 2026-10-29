import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPaidServer } from "../src/seller.js"
import { createAgentWallet } from "../src/index.js"

function run(args, env = {}) {
  const base = { ...process.env }
  delete base.CDP_API_KEY_ID
  delete base.CDP_API_KEY_SECRET
  delete base.X402_FACILITATOR_AUTH
  delete base.PRIVATE_KEY
  delete base.AX402_HOME
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["bin/ax402.js", ...args], {
      cwd: process.cwd(),
      env: { ...base, ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

test("ax402 new writes a mode-600 wallet and does not print the key", async () => {
  const home = mkdtempSync(join(tmpdir(), "ax402-"))
  const created = await run(["new"], { AX402_HOME: home })
  assert.equal(created.code, 0, created.stderr)
  const file = join(home, ".config", "agent-x402", "wallet.json")
  const wallet = JSON.parse(readFileSync(file, "utf8"))
  assert.match(wallet.address, /^0x[0-9a-fA-F]{40}$/)
  assert.match(wallet.privateKey, /^0x[0-9a-fA-F]{64}$/)
  assert.equal(created.stdout.includes(wallet.privateKey), false)
  assert.equal(created.stderr.includes(wallet.privateKey), false)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const again = await run(["new"], { AX402_HOME: home })
  assert.equal(again.code, 1)
  assert.match(again.stderr, /already exists/)
  const policy = await run(["policy"], { AX402_HOME: home })
  assert.equal(policy.code, 0)
  assert.match(policy.stdout, /spentUsd/)
})

test("ax402 --help and --version exit 0", async () => {
  const help = await run(["--help"])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /ax402 new/)
  const version = await run(["--version"])
  assert.equal(version.code, 0)
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/)
})

test("ax402 quote reads the price from a local paid server and does not pay", async () => {
  const home = mkdtempSync(join(tmpdir(), "ax402-quote-"))
  const seller = createAgentWallet()
  let settlements = 0
  const { server } = createPaidServer({
    payTo: seller.address,
    priceUsd: 0.05,
    settle: async () => {
      settlements += 1
      return { success: true, transaction: "0x" + "44".repeat(32), network: "eip155:8453" }
    },
  })
  const port = await listen(server)
  try {
    const quote = await run(["quote", `http://127.0.0.1:${port}/v1/resource`], { AX402_HOME: home })
    assert.equal(quote.code, 0, quote.stderr)
    assert.match(quote.stdout, /0\.05 USDC/)
    assert.match(quote.stdout, new RegExp(seller.address))
    assert.equal(settlements, 0)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})
