#!/usr/bin/env node
/**
 * ax402-stats — маленький сервер статистики для agent-x402.
 *
 *   GET /stats   — JSON: requests, revenue, lastPayments
 *   POST /pay    — алиас для ax402 pay, логирует в stats
 *
 * Запуск:
 *   DASHBOARD_WEBHOOK_URL=http://host:port node bin/stats-server.js
 */

import { createServer } from "node:http"
import { X402Client, SpendPolicy, createAgentWallet, usdcBalance } from "../src/index.js"

const PORT = Number(process.env.PORT || 8781)
const WEBHOOK = process.env.DASHBOARD_WEBHOOK_URL || null

let stats = { requests: 0, revenue: 0, payments: [] }
const policy = new SpendPolicy({ dailyUsd: 5, perRequestUsd: 1, maxPayments: 100 })

function push() {
  if (!WEBHOOK) return
  try {
    fetch(WEBHOOK + "/webhook/agent-x402", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: stats.requests, revenue: stats.revenue }),
    }).catch(() => {})
  } catch {}
}

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*")
  if (req.method === "OPTIONS") return res.writeHead(204).end()

  if (req.method === "GET" && req.url === "/stats") {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(stats))
  }

  if (req.method === "POST" && req.url === "/pay") {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", async () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch {}
      const url = body.url
      if (!url) return res.writeHead(400).end(JSON.stringify({ error: "url required" }))
      try {
        const client = new X402Client({ policy })
        const result = await client.fetch(url, { method: "POST", body: body.data || {} })
        stats.requests += 1
        if (result.paid) {
          stats.revenue += result.amountUsd || 0
          stats.payments.push({ url, amountUsd: result.amountUsd, ts: Date.now() })
        }
        push()
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ paid: !!result.paid, amountUsd: result.amountUsd }))
      } catch (e) {
        res.writeHead(500).end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  res.writeHead(404).end(JSON.stringify({ error: "not_found" }))
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[agent-x402-stats] http://127.0.0.1:${PORT}`)
})
