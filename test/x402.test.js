import { test } from "node:test"
import assert from "node:assert/strict"
import { SpendPolicy } from "../src/policy.js"
import { parseRequirements, pickOption, makeNonce, createAgentWallet, X402Client, domainFor } from "../src/index.js"

test("policy enforces per-request and daily caps", () => {
  const p = new SpendPolicy({ dailyUsd: 1, perRequestUsd: 0.3 })
  assert.equal(p.check({ amount: 0.2 }).allowed, true)
  assert.equal(p.check({ amount: 0.5 }).allowed, false)
  p.commit({ amount: 0.2, network: "eip155:8453" })
  p.commit({ amount: 0.2, network: "eip155:8453" })
  p.commit({ amount: 0.2, network: "eip155:8453" })
  p.commit({ amount: 0.2, network: "eip155:8453" })
  const v = p.check({ amount: 0.25 })
  assert.equal(v.allowed, false)
  assert.match(v.reason, /daily cap/)
})

test("policy blocks payees outside the allow-list and blocked assets", () => {
  const p = new SpendPolicy({
    allowPayees: ["0xabc"],
    blockContracts: ["0xdead"],
    perRequestUsd: 10,
    dailyUsd: 10,
  })
  assert.equal(p.check({ amount: 1, payTo: "0xDEF" }).allowed, false)
  assert.equal(p.check({ amount: 1, payTo: "0xabc" }).allowed, true)
  assert.equal(p.check({ amount: 1, payTo: "0xabc", asset: "0xDEAD" }).allowed, false)
})

test("policy resets when the UTC day changes", () => {
  const p = new SpendPolicy({ dailyUsd: 1, perRequestUsd: 1 })
  p.commit({ amount: 1, network: "n" }, new Date("2026-10-20T10:00:00Z"))
  assert.equal(p.check({ amount: 1 }, new Date("2026-10-20T23:59:00Z")).allowed, false)
  assert.equal(p.check({ amount: 1 }, new Date("2026-10-21T00:01:00Z")).allowed, true)
})

test("payment requirements are parsed from the base64 header", () => {
  const req = { x402Version: 2, accepts: [{ network: "eip155:8453", amount: "5000000" }] }
  const header = Buffer.from(JSON.stringify(req)).toString("base64")
  const parsed = parseRequirements(header)
  assert.equal(parsed.accepts.length, 1)
  assert.equal(pickOption(parsed, { network: "eip155:8453" }).amount, "5000000")
})

test("nonce is unique and 32 bytes", () => {
  const a = makeNonce("0xabc", 1)
  const b = makeNonce("0xabc", 2)
  assert.equal(a.length, 66)
  assert.notEqual(a, b)
})

test("a fresh agent wallet is generated with a usable address", () => {
  const w = createAgentWallet()
  assert.match(w.address, /^0x[0-9a-fA-F]{40}$/)
  assert.equal(w.privateKey.length, 66)
})

test("X402Client rejects an invalid private key", () => {
  assert.throws(() => new X402Client({ privateKey: "not-a-key" }), /privateKey must be a 0x-prefixed 64-hex-character string/)
  assert.throws(() => new X402Client({ privateKey: "0x1234" }), /privateKey must be a 0x-prefixed 64-hex-character string/)
})

test("X402Client accepts a valid private key", () => {
  const w = createAgentWallet()
  const client = new X402Client({ privateKey: w.privateKey })
  assert.equal(client.address, w.address)
})

test("makeNonce uses a CSPRNG (two nonces with same salt differ)", () => {
  const a = makeNonce("0xabc", 1)
  const b = makeNonce("0xabc", 1)
  assert.equal(a.length, 66)
  assert.notEqual(a, b)
})

test("domainFor returns the correct EIP-3009 domain", () => {
  const d = domainFor("0xdeadbeef", 8453)
  assert.deepEqual(d, {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: "0xdeadbeef",
  })
})

test("SpendPolicy rejects non-positive amounts", () => {
  const p = new SpendPolicy({ dailyUsd: 1, perRequestUsd: 1 })
  assert.equal(p.check({ amount: -1 }).allowed, false)
  assert.equal(p.check({ amount: 0 }).allowed, false)
  assert.equal(p.check({ amount: NaN }).allowed, false)
  assert.equal(p.check({ amount: Infinity }).allowed, false)
})

test("SpendPolicy enforces per-provider caps", () => {
  const p = new SpendPolicy({ dailyUsd: 10, perRequestUsd: 10, perProviderUsd: { "eip155:8453": 0.5 } })
  assert.equal(p.check({ amount: 0.3, network: "eip155:8453" }).allowed, true)
  p.commit({ amount: 0.3, network: "eip155:8453" })
  assert.equal(p.check({ amount: 0.3, network: "eip155:8453" }).allowed, false)
  assert.match(p.check({ amount: 0.3, network: "eip155:8453" }).reason, /provider cap/)
})

test("SpendPolicy toJSON and load round-trip", () => {
  const p = new SpendPolicy({ dailyUsd: 2, perRequestUsd: 0.5 })
  p.commit({ amount: 0.5, network: "eip155:8453" })
  const json = p.toJSON()
  assert.equal(json.spentUsd, 0.5)
  const p2 = new SpendPolicy()
  p2.load(json)
  assert.equal(p2.report().spentUsd, 0.5)
})

test("X402Client.fetch rejects non-HTTP(S) URLs", async () => {
  const client = new X402Client()
  await assert.rejects(() => client.fetch("file:///etc/passwd"), /unsupported URL protocol/)
  await assert.rejects(() => client.fetch("ftp://example.com"), /unsupported URL protocol/)
})
