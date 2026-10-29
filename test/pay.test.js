import { test } from "node:test"
import assert from "node:assert/strict"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { createAgentWallet, X402Client, SpendPolicy, USDC_BASE } from "../src/index.js"
import { createPaidServer } from "../src/seller.js"
import { cdpBearerToken } from "../src/cdp-auth.js"

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

async function close(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

function ed25519Secret() {
  const { privateKey } = generateKeyPairSync("ed25519")
  const jwk = privateKey.export({ format: "jwk" })
  const seed = Buffer.from(jwk.d, "base64url")
  const pub = Buffer.from(jwk.x, "base64url")
  return {
    secret: Buffer.concat([seed, pub]).toString("base64"),
    publicKey: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }),
  }
}

async function until(predicate) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail("timed out waiting for the payment hold")
}

test("a paid call settles once, records revenue, and the same signature cannot be reused", async () => {
  const buyer = createAgentWallet()
  const seller = createAgentWallet()
  let captured = null
  let settlements = 0
  const { server, stats } = createPaidServer({
    payTo: seller.address,
    priceUsd: 0.01,
    settle: async (payment) => {
      captured = payment
      settlements += 1
      return { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453" }
    },
  })
  const port = await listen(server)
  try {
    const policy = new SpendPolicy({ dailyUsd: 1, perRequestUsd: 1 })
    const client = new X402Client({
      privateKey: buyer.privateKey,
      policy,
      balanceOf: async () => 5,
    })
    const url = `http://127.0.0.1:${port}/v1/resource`
    const res = await client.fetch(url)
    assert.equal(res.paid, true)
    assert.equal(res.response.status, 200)
    assert.equal(res.amountUsd, 0.01)
    assert.equal(JSON.parse(res.body).ok, true)
    assert.equal(res.settlement.success, true)
    assert.equal(policy.report().spentUsd, 0.01)
    assert.equal(stats.revenueUsd, 0.01)
    assert.equal(stats.paid, 1)
    assert.equal(settlements, 1)
    assert.equal(res.option.asset.toLowerCase(), USDC_BASE.toLowerCase())
    assert.equal(typeof captured.payload.authorization.value, "string")

    const header = Buffer.from(JSON.stringify(captured)).toString("base64")
    const again = await fetch(url, { headers: { "payment-signature": header } })
    assert.equal(again.status, 409)
    assert.equal(settlements, 1)
  } finally {
    await close(server)
  }
})

test("spend is not recorded when the server cannot settle", async () => {
  const buyer = createAgentWallet()
  const seller = createAgentWallet()
  const { server, stats } = createPaidServer({ payTo: seller.address, priceUsd: 0.01 })
  const port = await listen(server)
  try {
    const policy = new SpendPolicy({ dailyUsd: 1, perRequestUsd: 1 })
    const client = new X402Client({
      privateKey: buyer.privateKey,
      policy,
      balanceOf: async () => 5,
    })
    const res = await client.fetch(`http://127.0.0.1:${port}/v1/resource`)
    assert.equal(res.paid, false)
    assert.equal(res.response.status, 503)
    assert.match(res.body, /not_configured/)
    assert.equal(policy.report().spentUsd, 0)
    assert.equal(policy.report().payments, 0)
    assert.equal(stats.revenueUsd, 0)
  } finally {
    await close(server)
  }
})

test("a handler failure is not settled and does not count as spend", async () => {
  const buyer = createAgentWallet()
  const seller = createAgentWallet()
  let settlements = 0
  const { server } = createPaidServer({
    payTo: seller.address,
    priceUsd: 0.25,
    routes: {
      "GET /v1/resource": async () => ({ status: 500, body: { error: "upstream" } }),
    },
    settle: async () => {
      settlements += 1
      return { success: true, transaction: "0x" + "11".repeat(32) }
    },
  })
  const port = await listen(server)
  try {
    const policy = new SpendPolicy({ dailyUsd: 5, perRequestUsd: 1 })
    const client = new X402Client({
      privateKey: buyer.privateKey,
      policy,
      balanceOf: async () => 5,
    })
    const res = await client.fetch(`http://127.0.0.1:${port}/v1/resource`)
    assert.equal(res.response.status, 500)
    assert.equal(res.paid, false)
    assert.equal(settlements, 0)
    assert.equal(policy.report().spentUsd, 0)
  } finally {
    await close(server)
  }
})

test("the policy blocks a second in-flight payment that would cross the daily cap", async () => {
  const buyer = createAgentWallet()
  const seller = createAgentWallet()
  let releaseSettle
  const gate = new Promise((resolve) => {
    releaseSettle = resolve
  })
  const { server } = createPaidServer({
    payTo: seller.address,
    priceUsd: 0.6,
    settle: async () => {
      await gate
      return { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453" }
    },
  })
  const port = await listen(server)
  try {
    const policy = new SpendPolicy({ dailyUsd: 1, perRequestUsd: 1 })
    const client = new X402Client({
      privateKey: buyer.privateKey,
      policy,
      balanceOf: async () => 5,
    })
    const url = `http://127.0.0.1:${port}/v1/resource`
    const first = client.fetch(url)
    await until(() => policy.report().spentUsd === 0.6)
    await assert.rejects(client.fetch(url), /policy blocked/)
    releaseSettle()
    const done = await first
    assert.equal(done.paid, true)
    assert.equal(policy.report().spentUsd, 0.6)
  } finally {
    releaseSettle()
    await close(server)
  }
})

test("facilitator verify and settle receive a path-bound CDP token", async () => {
  const buyer = createAgentWallet()
  const seller = createAgentWallet()
  const keys = ed25519Secret()
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization, body: JSON.parse(init.body) })
    if (url.endsWith("/verify")) return Response.json({ isValid: true, payer: buyer.address })
    if (url.endsWith("/settle")) {
      return Response.json({
        success: true,
        transaction: "0x" + "22".repeat(32),
        network: "eip155:8453",
        payer: buyer.address,
      })
    }
    throw new Error("unexpected " + url)
  }
  const { server, stats } = createPaidServer({
    payTo: seller.address,
    priceUsd: 0.02,
    facilitatorUrl: "http://127.0.0.1/facilitator",
    cdpApiKeyId: "organizations/test/apiKeys/key",
    cdpApiKeySecret: keys.secret,
    fetchImpl,
    publicUrl: "http://127.0.0.1",
  })
  const port = await listen(server)
  try {
    const client = new X402Client({ privateKey: buyer.privateKey, balanceOf: async () => 5 })
    const res = await client.fetch(`http://127.0.0.1:${port}/v1/echo`, {
      method: "POST",
      body: { hello: "world" },
    })
    assert.equal(res.paid, true)
    assert.deepEqual(JSON.parse(res.body), { echo: { hello: "world" } })
    assert.equal(stats.revenueUsd, 0.02)
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://127.0.0.1/facilitator/verify", "http://127.0.0.1/facilitator/settle"],
    )
    for (const call of calls) {
      const token = call.authorization.replace(/^Bearer /, "")
      const [header, payload, signature] = token.split(".")
      assert.equal(
        verify(null, Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url")),
        true,
      )
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
      assert.equal(claims.uris[0], `POST 127.0.0.1${new URL(call.url).pathname}`)
      assert.equal(call.body.paymentRequirements.payTo, seller.address)
      assert.equal(keys.secret.includes(token), false)
    }
    assert.equal(calls[0].body.paymentPayload.payload.authorization.value, "20000")
  } finally {
    await close(server)
  }
})

test("an ES256 CDP token verifies and does not embed the secret", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const pem = privateKey.export({ type: "sec1", format: "pem" })
  const token = cdpBearerToken({
    apiKeyId: "key-id",
    apiKeySecret: pem,
    method: "POST",
    url: "https://api.cdp.coinbase.com/platform/v2/x402/settle",
    now: 1_700_000_000,
  })
  const [header, payload, signature] = token.split(".")
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
    true,
  )
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
  assert.deepEqual(claims.aud, ["cdp_service"])
  assert.equal(claims.uris[0], "POST api.cdp.coinbase.com/platform/v2/x402/settle")
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "ES256")
  assert.equal(token.includes("BEGIN EC PRIVATE KEY"), false)

  const escaped = cdpBearerToken({
    apiKeyId: "key-id",
    apiKeySecret: pem.replace(/\n/g, "\\n"),
    method: "POST",
    url: "https://api.cdp.coinbase.com/platform/v2/x402/settle",
    now: 1_700_000_000,
  })
  const [h2, p2, s2] = escaped.split(".")
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${h2}.${p2}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s2, "base64url"),
    ),
    true,
  )
})

test("a tampered authorization value is rejected before settlement", async () => {
  const buyer = createAgentWallet()
  const seller = createAgentWallet()
  let settlements = 0
  let captured = null
  const { server } = createPaidServer({
    payTo: seller.address,
    priceUsd: 0.01,
    settle: async (payment) => {
      captured = payment
      settlements += 1
      return { success: true, transaction: "0x" + "ee".repeat(32), network: "eip155:8453" }
    },
  })
  const port = await listen(server)
  try {
    const client = new X402Client({ privateKey: buyer.privateKey, balanceOf: async () => 5 })
    const url = `http://127.0.0.1:${port}/v1/resource`
    const res = await client.fetch(url)
    assert.equal(res.paid, true)
    captured.payload.authorization.value = "1"
    const header = Buffer.from(JSON.stringify(captured)).toString("base64")
    const again = await fetch(url, { headers: { "payment-signature": header } })
    assert.equal(again.status, 402)
    const body = await again.json()
    assert.equal(body.error, "amount_mismatch")
    assert.equal(settlements, 1)
  } finally {
    await close(server)
  }
})
