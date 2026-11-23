import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { SpendPolicy } from "../src/policy.js"
import { X402Client, pickOption, parseRequirements, createMcpServer, MCP_TOOLS } from "../src/index.js"

const MCP_BIN = fileURLToPath(new URL("../bin/ax402-mcp.js", import.meta.url))

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agent-x402-mcp-"))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

test("the policy blocks a payment before the client signs", async () => {
  const policy = new SpendPolicy({ dailyUsd: 0, perRequestUsd: 10 })
  const client = new X402Client({ policy })
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const req = {
      x402Version: 2,
      accepts: [
        {
          network: "eip155:8453",
          amount: "5000000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0xabc",
        },
      ],
    }
    return new Response("", {
      status: 402,
      headers: { "payment-required": Buffer.from(JSON.stringify(req)).toString("base64") },
    })
  }
  try {
    await assert.rejects(
      () => client.fetch("https://example.com/x", { method: "POST" }),
      /policy blocked|insufficient/i,
    )
  } finally {
    globalThis.fetch = original
  }
})

test("quote mode never signs and reports the price", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const req = { x402Version: 2, accepts: [{ network: "eip155:8453", amount: "1000", payTo: "0xabc" }] }
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
  const req = { accepts: [{ network: "solana:5eykt", amount: "1" }, { network: "eip155:8453", amount: "2" }] }
  const parsed = parseRequirements(Buffer.from(JSON.stringify(req)).toString("base64"))
  assert.equal(pickOption(parsed, { network: "eip155:8453" }).amount, "2")
  assert.equal(pickOption(parsed, {}).amount, "2")
})

test("MCP server exposes x402-balance, x402-quote, x402-pay and x402-policy", () => {
  const names = MCP_TOOLS.map((t) => t.name)
  assert.deepEqual(names, ["x402-balance", "x402-quote", "x402-pay", "x402-policy"])
})

test("x402-balance returns address and balance without leaking the private key", async () => {
  await withTempDir(async (dir) => {
    const { handleToolCall } = createMcpServer({
      dir,
      balanceFn: async () => 12.34,
    })
    const res = await handleToolCall("x402-balance", {})
    assert.ok(!res.isError)
    const body = res.content[0].text
    const parsed = JSON.parse(body)
    assert.match(parsed.address, /^0x[0-9a-fA-F]{40}$/)
    assert.equal(parsed.usdc, 12.34)
    assert.equal(parsed.privateKey, undefined)

    const stored = JSON.parse(readFileSync(join(dir, "wallet.json"), "utf8"))
    assert.equal(stored.address, parsed.address)
    assert.ok(!body.includes(stored.privateKey), "private key must never leave the host process")
  })
})

test("x402-policy updates persist both limits and spend state across instances", async () => {
  await withTempDir(async (dir) => {
    const s1 = createMcpServer({ dir, balanceFn: async () => 10 })
    const setRes = await s1.handleToolCall("x402-policy", {
      action: "set",
      daily_usd: 2.5,
      per_request_usd: 0.5,
      max_payments: 4,
      allow_payees: ["0xAbC123"],
    })
    assert.ok(!setRes.isError)
    assert.match(setRes.content[0].text, /policy updated/)

    const s2 = createMcpServer({ dir, balanceFn: async () => 10 })
    const showRes = await s2.handleToolCall("x402-policy", { action: "show" })
    const snap = JSON.parse(showRes.content[0].text)
    assert.equal(snap.dailyUsd, 2.5)
    assert.equal(snap.perRequestUsd, 0.5)
    assert.equal(snap.maxPayments, 4)
    assert.deepEqual(snap.allowPayees, ["0xabc123"])
  })
})

test("x402-quote reports price and policy eligibility without signing", async () => {
  await withTempDir(async (dir) => {
    const original = globalThis.fetch
    globalThis.fetch = async () => {
      const req = {
        x402Version: 2,
        accepts: [
          {
            network: "eip155:8453",
            amount: "250000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x1111111111111111111111111111111111111111",
          },
        ],
      }
      return new Response("", {
        status: 402,
        headers: { "payment-required": Buffer.from(JSON.stringify(req)).toString("base64") },
      })
    }
    try {
      const { handleToolCall } = createMcpServer({ dir })
      await handleToolCall("x402-policy", { action: "set", daily_usd: 1, per_request_usd: 0.1 })
      const res = await handleToolCall("x402-quote", { url: "https://api.example.com/v1/test" })
      assert.ok(!res.isError)
      const parsed = JSON.parse(res.content[0].text)
      assert.equal(parsed.amountUsd, 0.25)
      assert.equal(parsed.policyAllowed, false)
      assert.match(parsed.policyReason, /per-request cap/)
    } finally {
      globalThis.fetch = original
    }
  })
})

test("x402-pay enforces spend policy before signing and persists spend across calls", async () => {
  await withTempDir(async (dir) => {
    let signedCalls = 0
    const { handleToolCall } = createMcpServer({
      dir,
      clientFactory: ({ privateKey, policy }) => ({
        async fetch(url) {
          const amountUsd = 0.6
          const verdict = policy.check({
            amount: amountUsd,
            payTo: "0x2222222222222222222222222222222222222222",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            network: "eip155:8453",
          })
          if (!verdict.allowed) {
            const err = new Error(`policy blocked the payment: ${verdict.reason}`)
            err.code = "policy"
            throw err
          }
          signedCalls += 1
          policy.commit({ amount: amountUsd, network: "eip155:8453" })
          // Include privateKey in a synthetic body check to confirm redaction guard
          return {
            response: { status: 200 },
            paid: true,
            amountUsd,
            body: JSON.stringify({ ok: true, url, leakedAttempt: privateKey }),
          }
        },
      }),
    })

    await handleToolCall("x402-policy", { action: "set", daily_usd: 1.0, per_request_usd: 0.75 })

    // First call (0.60 <= 0.75 per-request and <= 1.00 daily) succeeds
    const first = await handleToolCall("x402-pay", { url: "https://api.example.com/paid" })
    assert.ok(!first.isError)
    assert.equal(signedCalls, 1)
    assert.match(first.content[0].text, /paid 0\.6 USDC/)
    const storedWallet = JSON.parse(readFileSync(join(dir, "wallet.json"), "utf8"))
    assert.ok(!first.content[0].text.includes(storedWallet.privateKey), "private key must be redacted")

    // Second call (0.60 + 0.60 = 1.20 > 1.00 daily) must be blocked BEFORE signing
    const second = await handleToolCall("x402-pay", { url: "https://api.example.com/paid" })
    assert.equal(second.isError, true)
    assert.equal(signedCalls, 1, "blocked payment must never sign")
    assert.match(second.content[0].text, /daily cap/)
  })
})

test("ax402-mcp stdio binary boots and answers initialize + tools/list", async () => {
  await withTempDir(async (dir) => {
    const child = spawn(process.execPath, [MCP_BIN], {
      env: { ...process.env, AGENT_X402_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const responses = []
    let buf = ""
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const lines = buf.split("\n")
      buf = lines.pop() || ""
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line))
      }
    })

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n")
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      },
    })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MCP stdio timeout")), 5000)
      const check = setInterval(() => {
        if (responses.some((r) => r.id === 2)) {
          clearTimeout(timeout)
          clearInterval(check)
          resolve()
        }
      }, 25)
      child.on("exit", (code) => {
        if (!responses.some((r) => r.id === 2)) {
          clearTimeout(timeout)
          clearInterval(check)
          reject(new Error(`ax402-mcp exited early with code ${code}`))
        }
      })
    })
    child.kill("SIGTERM")

    const listResp = responses.find((r) => r.id === 2)
    assert.ok(listResp?.result?.tools)
    assert.deepEqual(
      listResp.result.tools.map((t) => t.name),
      ["x402-balance", "x402-quote", "x402-pay", "x402-policy"],
    )
  })
})
