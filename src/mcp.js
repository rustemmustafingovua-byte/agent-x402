/**
 * agent-x402 MCP server factory — exposes wallet and policy operations as
 * standard Model Context Protocol tools.
 *
 * Security invariants:
 *   - The wallet private key is kept inside this host process and never
 *     returned in any tool response or error message.
 *   - `x402-pay` enforces the persisted SpendPolicy *before* signing and
 *     persists updated daily spend immediately after a paid request.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { X402Client, createAgentWallet, usdcBalance } from "./x402.js"
import { SpendPolicy } from "./policy.js"

export const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "agent-x402")

export const MCP_TOOLS = [
  {
    name: "x402-balance",
    description:
      "Show the agent wallet address and its USDC balance on Base. Never returns the private key.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "x402-quote",
    description:
      "Ask what a call to an x402 endpoint would cost. Pays nothing — it performs the request, reads the 402 terms, checks policy eligibility and reports the price.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Endpoint URL" },
        method: { type: "string", description: "HTTP method (default GET)" },
        body: { type: "object", description: "Optional JSON body for POST requests" },
      },
      required: ["url"],
    },
  },
  {
    name: "x402-pay",
    description:
      "Call an endpoint and pay with USDC (x402) if the server asks for it. The spend policy is enforced before signing: daily cap, per-request cap, payee allow-list, blocked contracts and per-network caps.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Endpoint URL" },
        method: { type: "string", description: "HTTP method (default GET)" },
        body: { type: "object", description: "JSON body for POST requests" },
      },
      required: ["url"],
    },
  },
  {
    name: "x402-policy",
    description:
      "Show or update the spend policy: daily cap, per-request cap, payment count, payee allow-list, blocked contracts and per-network cap.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show", "set"], description: "show (default) | set" },
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

function redactKey(text, privateKey) {
  let out = String(text ?? "")
  if (privateKey) out = out.split(privateKey).join("[REDACTED]")
  return out
}

function assertNonNegativeNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`)
  }
}

export function loadStoredPolicy(policyFile) {
  if (!existsSync(policyFile)) return new SpendPolicy()
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(policyFile, "utf8"))
  } catch {
    return new SpendPolicy()
  }
  const config = raw && typeof raw.config === "object" && raw.config !== null ? raw.config : raw
  const policy = new SpendPolicy({
    dailyUsd: config.dailyUsd,
    perRequestUsd: config.perRequestUsd,
    allowPayees: config.allowPayees,
    blockContracts: config.blockContracts,
    perProviderUsd: config.perProviderUsd,
    maxPayments: config.maxPayments,
  })
  if (raw && typeof raw.state === "object" && raw.state !== null) {
    policy.load(raw.state)
  } else if (raw && typeof raw.day === "string") {
    policy.load({
      day: raw.day,
      spentUsd: raw.spentUsd ?? 0,
      payments: raw.payments ?? 0,
      byProvider: raw.byProvider ?? {},
    })
  }
  return policy
}

export function saveStoredPolicy(policyFile, dir, policy) {
  mkdirSync(dir, { recursive: true })
  const payload = {
    config: {
      dailyUsd: policy.dailyUsd,
      perRequestUsd: policy.perRequestUsd,
      maxPayments: policy.maxPayments,
      allowPayees: policy.allowPayees,
      blockContracts: policy.blockContracts,
      perProviderUsd: policy.perProviderUsd,
    },
    state: policy.toJSON(),
  }
  writeFileSync(policyFile, JSON.stringify(payload, null, 2) + "\n")
  chmodSync(policyFile, 0o600)
}

function policySnapshot(policy) {
  return {
    ...policy.report(),
    perRequestUsd: policy.perRequestUsd,
    allowPayees: policy.allowPayees,
    blockContracts: policy.blockContracts,
    perProviderUsd: policy.perProviderUsd,
  }
}

/**
 * Create a configured agent-x402 MCP Server instance plus direct tool handler
 * for testing or embedding.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir] config directory for wallet.json and policy.json
 * @param {(address: string) => Promise<number>} [opts.balanceFn]
 * @param {(opts: {privateKey: string, policy: SpendPolicy}) => X402Client} [opts.clientFactory]
 */
export function createMcpServer(opts = {}) {
  const dir = opts.dir || DEFAULT_CONFIG_DIR
  const keyFile = join(dir, "wallet.json")
  const policyFile = join(dir, "policy.json")
  const getBalance = opts.balanceFn || usdcBalance
  const makeClient = opts.clientFactory || ((cOpts) => new X402Client(cOpts))

  function loadWallet() {
    if (!existsSync(keyFile)) return null
    try {
      return JSON.parse(readFileSync(keyFile, "utf8"))
    } catch {
      return null
    }
  }

  function ensureWallet() {
    let w = loadWallet()
    if (!w) {
      const created = createAgentWallet()
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        keyFile,
        JSON.stringify({ address: created.address, privateKey: created.privateKey }, null, 2) + "\n",
      )
      chmodSync(keyFile, 0o600)
      w = { address: created.address, privateKey: created.privateKey }
    }
    return w
  }

  async function handleToolCall(name, rawArgs = {}) {
    const args = rawArgs || {}
    let activeKey = null
    try {
      switch (name) {
        case "x402-balance":
        case "x402-wallet": {
          const w = ensureWallet()
          activeKey = w.privateKey
          const usdc = await getBalance(w.address).catch(() => null)
          return ok(
            redactKey(
              JSON.stringify(
                {
                  address: w.address,
                  usdc,
                  network: "base",
                  note: "the private key never leaves this process",
                },
                null,
                2,
              ),
              activeKey,
            ),
          )
        }
        case "x402-quote": {
          if (!args.url) return fail("[agent-x402] missing required argument: url")
          const w = ensureWallet()
          activeKey = w.privateKey
          const policy = loadStoredPolicy(policyFile)
          const method = (args.method || "GET").toUpperCase()
          const client = makeClient({ privateKey: w.privateKey, policy })
          const res = await client.fetch(args.url, {
            method,
            body: method === "POST" ? args.body ?? {} : undefined,
            dryRun: true,
          })
          if (!res.requirements) {
            return ok(
              redactKey(
                `no payment required (HTTP ${res.response.status})\n${String(res.body ?? "").slice(0, 800)}`,
                activeKey,
              ),
            )
          }
          const verdict = policy.check({
            amount: res.amountUsd,
            payTo: res.option?.payTo,
            asset: res.option?.asset,
            network: res.option?.network,
          })
          return ok(
            redactKey(
              JSON.stringify(
                {
                  amountUsd: res.amountUsd,
                  network: res.option?.network,
                  payTo: res.option?.payTo,
                  asset: res.option?.asset,
                  policyAllowed: verdict.allowed,
                  ...(verdict.reason ? { policyReason: verdict.reason } : {}),
                  policy: policySnapshot(policy),
                },
                null,
                2,
              ),
              activeKey,
            ),
          )
        }
        case "x402-pay": {
          if (!args.url) return fail("[agent-x402] missing required argument: url")
          const w = ensureWallet()
          activeKey = w.privateKey
          const policy = loadStoredPolicy(policyFile)
          const client = makeClient({ privateKey: w.privateKey, policy })
          const res = await client.fetch(args.url, {
            method: (args.method || "GET").toUpperCase(),
            body: args.body,
          })
          if (res.paid) {
            saveStoredPolicy(policyFile, dir, policy)
          }
          const text = res.body ?? ""
          return ok(
            redactKey(
              `HTTP ${res.response.status}${res.paid ? ` · paid ${res.amountUsd} USDC` : ""}\n${String(text).slice(0, 4000)}\n\n${JSON.stringify(policySnapshot(policy), null, 2)}`,
              activeKey,
            ),
          )
        }
        case "x402-policy": {
          const policy = loadStoredPolicy(policyFile)
          if (args.action === "set") {
            if (args.daily_usd != null) {
              assertNonNegativeNumber("daily_usd", args.daily_usd)
              policy.dailyUsd = args.daily_usd
            }
            if (args.per_request_usd != null) {
              assertNonNegativeNumber("per_request_usd", args.per_request_usd)
              policy.perRequestUsd = args.per_request_usd
            }
            if (args.max_payments != null) {
              assertNonNegativeNumber("max_payments", args.max_payments)
              policy.maxPayments = args.max_payments
            }
            if (args.allow_payees) {
              policy.allowPayees = args.allow_payees.map((a) => String(a).toLowerCase())
            }
            if (args.block_contracts) {
              policy.blockContracts = args.block_contracts.map((a) => String(a).toLowerCase())
            }
            if (args.per_network_usd) {
              for (const [net, cap] of Object.entries(args.per_network_usd)) {
                assertNonNegativeNumber(`per_network_usd.${net}`, cap)
              }
              policy.perProviderUsd = { ...args.per_network_usd }
            }
            saveStoredPolicy(policyFile, dir, policy)
            return ok(`policy updated\n${JSON.stringify(policySnapshot(policy), null, 2)}`)
          }
          return ok(JSON.stringify(policySnapshot(policy), null, 2))
        }
        default:
          return fail(`unknown tool: ${name}`)
      }
    } catch (e) {
      return fail(
        redactKey(`[agent-x402] ${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}`, activeKey),
      )
    }
  }

  const server = new Server(
    { name: "agent-x402", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleToolCall(request.params.name, request.params.arguments)
  })

  return { server, handleToolCall, tools: MCP_TOOLS }
}
