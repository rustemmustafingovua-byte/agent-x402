#!/usr/bin/env node
/**
 * agent-x402 MCP server — wallet and policy operations as agent tools.
 *
 * The private key never leaves this process. The `x402-pay` tool enforces the
 * spend policy *before* signing, so a model cannot talk its way past a cap.
 *
 * OpenCode configuration:
 *   { "mcp": { "agent-x402": { "type": "local", "command": ["ax402-mcp"], "enabled": true } } }
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createMcpServer } from "../src/mcp.js"

const HELP =
  "ax402-mcp — MCP server exposing agent-x402 wallet and policy operations.\n\n" +
  "TOOLS\n" +
  "  x402-balance   show wallet address and Base USDC balance (never leaks key)\n" +
  "  x402-quote     read 402 payment terms without signing or paying\n" +
  "  x402-pay       call an endpoint and pay with USDC after enforcing SpendPolicy\n" +
  "  x402-policy    show or update daily/per-request caps and payee rules\n\n" +
  "OPENCODE CONFIG\n" +
  '  { "mcp": { "agent-x402": { "type": "local", "command": ["ax402-mcp"], "enabled": true } } }\n'

const VERSION = "0.1.0"

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP)
  process.exit(0)
}
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(VERSION)
  process.exit(0)
}

async function main() {
  const dir = process.env.AGENT_X402_DIR || undefined
  const { server } = createMcpServer({ dir })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write("[agent-x402] MCP server ready\n")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
