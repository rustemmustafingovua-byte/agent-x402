#!/usr/bin/env node
/**
 * ax402 — buyer CLI.
 *
 *   ax402 new                 create an agent wallet (mode 600)
 *   ax402 balance             USDC balance on Base
 *   ax402 quote <url>         read the 402 price, pay nothing
 *   ax402 pay <url> [json]    call the endpoint and pay if asked
 *   ax402 policy              show the spend report
 *
 * The private key stays in ~/.config/agent-x402/wallet.json. It is never printed.
 */
import { createRequire } from "node:module"
import { statSync } from "node:fs"
import { X402Client, createAgentWallet, usdcBalance } from "../src/index.js"
import { readPolicy, readWallet, walletFile, writePolicy, writeWallet } from "../src/config.js"

const version = createRequire(import.meta.url)("../package.json").version
const HELP = `ax402 — x402 micropayments for AI agents, with a spend policy.

USAGE
  ax402 new [--force]          create an agent wallet
  ax402 balance                USDC balance on Base
  ax402 quote <url> [METHOD]   what this call would cost (pays nothing)
  ax402 pay <url> [json]       call the endpoint and pay with USDC if asked
  ax402 policy                 show today's spend

The private key stays in ${walletFile()} (mode 600) and is never printed.
Payments are recorded against the policy only after the paid call succeeds.
x402 payments are irreversible once a facilitator settles them.

MIT · https://github.com/rustemmustafingovua-byte/agent-x402`

const ok = (s) => `\x1b[32m${s}\x1b[0m`
const bad = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP)
  process.exit(0)
}
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(version)
  process.exit(0)
}

function requireWallet() {
  const wallet = readWallet()
  if (!wallet) {
    console.error(bad("no wallet yet: ax402 new"))
    process.exit(1)
  }
  return wallet
}

const cmd = process.argv[2] || "balance"
const force = process.argv.includes("--force")

try {
  switch (cmd) {
    case "new": {
      if (readWallet() && !force) {
        console.error(bad("wallet already exists. Pass --force to replace it."))
        process.exit(1)
      }
      const wallet = createAgentWallet()
      writeWallet(wallet)
      const mode = statSync(walletFile()).mode & 0o777
      console.log(ok(`wallet created: ${wallet.address}`))
      console.log(dim(`  key file: ${walletFile()} (mode ${mode.toString(8)})`))
      console.log(dim("  send USDC on Base to that address, then run: ax402 balance"))
      break
    }
    case "balance": {
      const wallet = requireWallet()
      const usdc = await usdcBalance(wallet.address)
      console.log(`USDC (Base) ${wallet.address}: ${usdc}`)
      break
    }
    case "quote": {
      const url = process.argv[3]
      const method = (process.argv[4] || "GET").toUpperCase()
      if (!url) {
        console.error("usage: ax402 quote <url> [METHOD]")
        process.exit(1)
      }
      const wallet = readWallet()
      const policy = readPolicy()
      const client = new X402Client({ privateKey: wallet?.privateKey, policy })
      const res = await client.fetch(url, { method, body: method === "POST" ? {} : undefined, dryRun: true })
      if (!res.option) {
        console.log(`no payment required (HTTP ${res.response.status})`)
        if (res.body) console.log(String(res.body).slice(0, 2000))
        break
      }
      console.log(ok(`price: ${res.amountUsd} USDC (${res.option.network})`))
      console.log(dim(`  payee: ${res.option.payTo}`))
      console.log(dim(`  asset: ${res.option.asset}`))
      break
    }
    case "pay": {
      const url = process.argv[3]
      const bodyJson = process.argv[4]
      if (!url) {
        console.error("usage: ax402 pay <url> [json body]")
        process.exit(1)
      }
      let body
      if (bodyJson) {
        try {
          body = JSON.parse(bodyJson)
        } catch (error) {
          console.error(bad("invalid JSON: " + error.message))
          process.exit(1)
        }
      }
      const wallet = requireWallet()
      const policy = readPolicy()
      const client = new X402Client({ privateKey: wallet.privateKey, policy })
      const res = await client.fetch(url, { method: body ? "POST" : "GET", body })
      if (res.paid) writePolicy(policy)
      const paid = res.paid ? ` (paid ${res.amountUsd} USDC)` : ""
      console.log(ok(`HTTP ${res.response.status}${paid}`))
      console.log(res.body?.slice(0, 4000) ?? "")
      console.log(dim(JSON.stringify(policy.report(), null, 2)))
      if (!res.paid || !res.response.ok) process.exit(1)
      break
    }
    case "policy": {
      console.log(JSON.stringify(readPolicy().report(), null, 2))
      break
    }
    default:
      console.error(HELP)
      process.exit(1)
  }
} catch (error) {
  console.error(bad(`${error.code ?? "error"}: ${error.message}`))
  process.exit(1)
}
