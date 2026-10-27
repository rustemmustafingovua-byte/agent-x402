#!/usr/bin/env node
/**
 * agent-x402 MCP server — wallet and policy operations as agent tools.
 *
 * The private key never leaves this process. The `x402-pay` tool enforces the
 * spend policy *before* signing, so a model cannot talk its way past a cap.
 *
 *   { "mcp": { "agent-x402": { "type": "local", "command": ["ax402-mcp"], "enabled": true } } }
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { X402Client, SpendPolicy, createAgentWallet, usdcBalance } from "./index.js"

const DIR = join(homedir(), ".config", "agent-x402")
const KEY_FILE = join(DIR, "wallet.json")
const POLICY_FILE = join(DIR, "policy.json")

const ok = (t) => ({ content: [{ type: "text", text: t }] })
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true })

function loadWallet() {
  if (!existsSync(KEY_FILE)) return null
  try {
    return JSON.parse(readFileSync(KEY_FILE, "utf8"))
  } catch {
    return null
  }
}

function loadPolicy() {
  const opts = existsSync(POLICY_FILE) ? JSON.parse(readFileSync(POLICY_FILE, "utf8")) : {}
  return new SpendPolicy(opts)
}

function savePolicy(policy) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2))
  chmodSync(POLICY_FILE, 0o600)
}

function ensureWallet() {
  let w = loadWallet()
  if (!w) {
    const created = createAgentWallet()
    mkdirSync(DIR, { recursive: true })
    writeFileSync(KEY_FILE, JSON.stringify({ address: created.address, privateKey: created.privateKey }, null, 2))
    chmodSync(KEY_FILE, 0o600)
    w = { address: created.address, privateKey: created.privateKey }
  }
  return w
}

const tools = [
  {
    name: "x402-wallet",
    description:
      "Show the agent wallet address and its USDC balance on Base. Never returns the private key.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "x402-quote",
    description:
      "Ask what a call to an x402 endpoint would cost. Pays nothing — it performs the request, reads the 402 terms and reports the price.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Endpoint URL" },
        method: { type: "string", description: "HTTP method (default GET)" },
      },
      required: ["url"],
    },
  },
  {
    name: "x402-pay",
    description:
      "Call an endpoint and pay with USDC (x402) if the server asks for it. The spend policy is enforced before signing: daily cap, per-request cap, payee allow-list.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", description: "HTTP method (default GET)" },
        body: { type: "object", description: "JSON body for POST requests" },
      },
      required: ["url"],
    },
  },
  {
    name: "x402-policy",
    description:
      "Show or update the spend policy: daily cap, per-request cap, payment count, payee allow-list, blocked contracts, per-network cap.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "show (default) | set" },
        daily_usd: { type: "number" },
        per_request_usd: { type: "number" },
        max_payments: { type: "number" },
        allow_payees: { type: "array", items: { type: "string" } },
        block_contracts: { type: "array", items: { type: "string" } },
        per_network_usd: { type: "object" },
      },
    },
  },
]

const server = new Server(
  { name: "agent-x402", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: raw } = request.params
  const args = raw || {}
  try {
    switch (name) {
      case "x402-wallet": {
        const w = ensureWallet()
        const usdc = await usdcBalance(w.address).catch(() => null)
        return ok(
          JSON.stringify(
            { address: w.address, usdc, network: "base", note: "the private key never leaves this process" },
            null,
            2,
          ),
        )
      }
      case "x402-quote": {
        const w = ensureWallet()
        const client = new X402Client({ privateKey: w.privateKey, policy: loadPolicy() })
        const res = await client.fetch(args.url, {
          method: (args.method || "GET").toUpperCase(),
          body: (args.method || "GET").toUpperCase() === "POST" ? args.body ?? {} : undefined,
          dryRun: true,
        })
        if (!res.requirements) {
          return ok(
            `no payment required (HTTP ${res.response.status})\n${String(res.body ?? "").slice(0, 800)}`,
          )
        }
        return ok(
          JSON.stringify(
            {
              amountUsd: res.amountUsd,
              network: res.option?.network,
              payTo: res.option?.payTo,
              asset: res.option?.asset,
              policy: loadPolicy().report(),
            },
            null,
            2,
          ),
        )
      }
      case "x402-pay": {
        const w = ensureWallet()
        const policy = loadPolicy()
        const client = new X402Client({ privateKey: w.privateKey, policy })
        const res = await client.fetch(args.url, {
          method: (args.method || "GET").toUpperCase(),
          body: args.body,
        })
        const text = res.body ?? ""
        return ok(
          `HTTP ${res.response.status}${res.paid ? ` · paid ${res.amountUsd} USDC` : ""}\n${String(text).slice(0, 4000)}\n\n${JSON.stringify(policy.report(), null, 2)}`,
        )
      }
      case "x402-policy": {
        const policy = loadPolicy()
        if (args.action === "set") {
          if (args.daily_usd != null) policy.dailyUsd = args.daily_usd
          if (args.per_request_usd != null) policy.perRequestUsd = args.per_request_usd
          if (args.max_payments != null) policy.maxPayments = args.max_payments
          if (args.allow_payees) policy.allowPayees = args.allow_payees.map((a) => a.toLowerCase())
          if (args.block_contracts) policy.blockContracts = args.block_contracts.map((a) => a.toLowerCase())
          if (args.per_network_usd) policy.perProviderUsd = args.per_network_usd
          savePolicy(policy)
          return ok(`policy updated\n${JSON.stringify(policy.report(), null, 2)}`)
        }
        return ok(JSON.stringify(policy.report(), null, 2))
      }
      default:
        return fail(`unknown tool: ${name}`)
    }
  } catch (e) {
    return fail(`[agent-x402] ${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}`)
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write("[agent-x402] MCP server ready\n")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
