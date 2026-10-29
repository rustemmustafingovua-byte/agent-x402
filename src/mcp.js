/**
 * MCP tools for the buyer wallet. The private key is never included in a tool result.
 * x402-pay loads the spend policy and the client records a payment only after HTTP success.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createRequire } from "node:module"
import { readPolicy, readWallet, writePolicy, writeWallet } from "./config.js"
import { X402Client, createAgentWallet, usdcBalance } from "./x402.js"

const version = createRequire(import.meta.url)("../package.json").version

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
      "Ask what a call to an x402 endpoint would cost. Pays nothing: it reads the 402 terms and reports the price.",
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
      "Call an endpoint and pay with USDC on Base if the server asks for it. The spend policy is enforced before signing.",
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

const ok = (text) => ({ content: [{ type: "text", text }] })
const fail = (text) => ({ content: [{ type: "text", text }], isError: true })

function ensureWallet(home) {
  const existing = readWallet(home)
  if (existing) return existing
  const created = createAgentWallet()
  writeWallet({ address: created.address, privateKey: created.privateKey }, home)
  return { address: created.address, privateKey: created.privateKey }
}

export async function dispatchTool(name, raw = {}, ctx = {}) {
  const args = raw || {}
  const home = ctx.home
  const balanceOf = ctx.balanceOf ?? ((address) => usdcBalance(address))
  try {
    switch (name) {
      case "x402-wallet": {
        const wallet = ensureWallet(home)
        const usdc = await balanceOf(wallet.address).catch(() => null)
        return ok(
          JSON.stringify(
            {
              address: wallet.address,
              usdc,
              network: "base",
              note: "the private key never leaves this process",
            },
            null,
            2,
          ),
        )
      }
      case "x402-quote": {
        const policy = readPolicy(home)
        const client = new X402Client({ policy, balanceOf })
        const method = (args.method || "GET").toUpperCase()
        const res = await client.fetch(args.url, {
          method,
          body: method === "POST" ? (args.body ?? {}) : undefined,
          dryRun: true,
        })
        if (!res.requirements) {
          return ok(`no payment required (HTTP ${res.response.status})\n${String(res.body ?? "").slice(0, 800)}`)
        }
        return ok(
          JSON.stringify(
            {
              amountUsd: res.amountUsd,
              network: res.option?.network,
              payTo: res.option?.payTo,
              asset: res.option?.asset,
              policy: policy.report(),
            },
            null,
            2,
          ),
        )
      }
      case "x402-pay": {
        const wallet = readWallet(home)
        if (!wallet) return fail("no wallet yet: call x402-wallet first")
        const policy = readPolicy(home)
        const client = new X402Client({ privateKey: wallet.privateKey, policy, balanceOf })
        const res = await client.fetch(args.url, {
          method: (args.method || "GET").toUpperCase(),
          body: args.body,
        })
        if (res.paid) writePolicy(policy, home)
        const text = res.body ?? ""
        const summary = `HTTP ${res.response.status}${res.paid ? ` · paid ${res.amountUsd} USDC` : ""}`
        if (!res.response.ok && !res.paid) return fail(`${summary}\n${String(text).slice(0, 4000)}`)
        return ok(`${summary}\n${String(text).slice(0, 4000)}\n\n${JSON.stringify(policy.report(), null, 2)}`)
      }
      case "x402-policy": {
        const policy = readPolicy(home)
        if (args.action === "set") {
          if (args.daily_usd != null) policy.dailyUsd = args.daily_usd
          if (args.per_request_usd != null) policy.perRequestUsd = args.per_request_usd
          if (args.max_payments != null) policy.maxPayments = args.max_payments
          if (args.allow_payees) policy.allowPayees = args.allow_payees.map((item) => String(item).toLowerCase())
          if (args.block_contracts) {
            policy.blockContracts = args.block_contracts.map((item) => String(item).toLowerCase())
          }
          if (args.per_network_usd) policy.perProviderUsd = args.per_network_usd
          writePolicy(policy, home)
          return ok(`policy updated\n${JSON.stringify(policy.report(), null, 2)}`)
        }
        return ok(JSON.stringify(policy.report(), null, 2))
      }
      default:
        return fail(`unknown tool: ${name}`)
    }
  } catch (error) {
    return fail(`[agent-x402] ${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}`)
  }
}

export function createMcpServer() {
  const server = new Server({ name: "agent-x402", version }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return dispatchTool(request.params.name, request.params.arguments || {})
  })
  return server
}

export async function startMcpServer() {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write("[agent-x402] MCP server ready\n")
}
