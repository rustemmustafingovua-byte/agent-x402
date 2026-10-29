#!/usr/bin/env node
/**
 * agent-x402 MCP server. Wallet and policy tools for an agent.
 * The private key never leaves this process, and x402-pay enforces the spend policy before signing.
 */
import { startMcpServer } from "../src/mcp.js"

startMcpServer().catch((error) => {
  console.error(error)
  process.exit(1)
})
