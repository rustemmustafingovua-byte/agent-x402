# agent-x402

x402 micropayments for AI agents. A buyer pays per API call in USDC on Base. A spend policy, enforced in code, decides whether the agent may sign. A resource server quotes a price and, once a facilitator is configured, settles that USDC to an address you control.

[![CI](https://github.com/rustemmustafingovua-byte/agent-x402/actions/workflows/ci.yml/badge.svg)](https://github.com/rustemmustafingovua-byte/agent-x402/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-x402?color=cb3837&logo=npm)](https://www.npmjs.com/package/agent-x402)
[![license](https://img.shields.io/badge/license-MIT-8b949e)](./LICENSE)

Requires Node.js 20 or newer. The package is ESM.

## Install

From npm, after the `v0.2.0` publish (see [Publish the package](#publish-the-package)):

```bash
npm install agent-x402
```

From a checkout:

```bash
git clone https://github.com/rustemmustafingovua-byte/agent-x402
cd agent-x402
npm ci
```

The CLIs are `ax402` (buyer), `ax402-mcp` (buyer tools for an agent), and `ax402-serve` (seller).

## Buyer

### Library

```js
import { X402Client, SpendPolicy } from "agent-x402"

const client = new X402Client({
  privateKey: process.env.PRIVATE_KEY, // 0x + 64 hex chars, never commit this
  policy: new SpendPolicy({
    dailyUsd: 5,
    perRequestUsd: 0.5,
    maxPayments: 100,
    allowPayees: [], // empty means any payee; set this to lock the recipient
  }),
})

const res = await client.fetch("https://pay.example.com/v1/resource")
console.log(res.paid, res.amountUsd, res.body)
```

`fetch` requests the URL, reads a `402` `PAYMENT-REQUIRED` header, checks the policy, signs an EIP-3009 `transferWithAuthorization` for USDC on Base, and retries with `PAYMENT-SIGNATURE`. The spend is counted only after the paid response is successful. A failed call releases the hold, including when two payments are in flight and the second would cross the cap.

`quote` without paying:

```js
const quote = await client.fetch(url, { dryRun: true })
```

### CLI

```bash
ax402 new                      # writes ~/.config/agent-x402/wallet.json (mode 600)
ax402 balance                  # USDC on Base for that address
ax402 quote https://pay.example.com/v1/resource
ax402 pay https://pay.example.com/v1/resource
ax402 pay https://pay.example.com/v1/echo '{"hello":"world"}'
ax402 policy
```

`ax402 new` refuses to overwrite an existing wallet unless you pass `--force`. The private key is never printed. Send USDC **on Base** to the address `ax402 new` prints, then `ax402 balance`. The buyer does not need ETH: the transfer is an EIP-3009 authorization, and the facilitator pays the gas when it submits it.

Default policy limits, used when `~/.config/agent-x402/policy.json` is missing: 5 USDC per UTC day, 1 USDC per call, 100 calls per day. Caps are whatever you write into that file (`dailyUsd`, `perRequestUsd`, `maxPayments`, `allowPayees`, `blockContracts`, `perProviderUsd`). The ledger lives under `state` in the same file and is not a way to raise a cap.

### MCP

```json
{
  "mcpServers": {
    "agent-x402": {
      "command": "ax402-mcp"
    }
  }
}
```

Tools: `x402-wallet`, `x402-quote`, `x402-pay`, `x402-policy`. Tool results never include the private key. `x402-pay` uses the same policy file as the CLI.

## Seller

`ax402-serve` protects `GET /v1/resource` and `POST /v1/echo`. `GET /health` and `GET /stats` are free. A request without a payment gets `402` and a base64 `PAYMENT-REQUIRED` header. The handler runs only after the signature checks out. USDC moves only when the facilitator settles, and only if the handler returned a 2xx. A handler error does not settle.

```bash
export X402_PAY_TO=0xYourBaseAddress
export X402_PRICE_USD=0.01
export X402_PUBLIC_URL=https://pay.example.com
export X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
export CDP_API_KEY_ID=your-cdp-key-id
export CDP_API_KEY_SECRET=your-cdp-key-secret
export X402_HOST=0.0.0.0
export PORT=8787
npx ax402-serve
```

`X402_HOST` defaults to `127.0.0.1`. Set `X402_PUBLIC_URL` to the HTTPS origin clients will call, with no path. `CDP_API_KEY_SECRET` is either a PEM EC private key or a 64-byte base64 Ed25519 key, the two formats Coinbase Developer Platform issues. It stays in the host environment.

Library form, if you want your own routes:

```js
import { createPaidServer } from "agent-x402"

const { server } = createPaidServer({
  payTo: process.env.X402_PAY_TO,
  priceUsd: 0.01,
  publicUrl: process.env.X402_PUBLIC_URL,
  facilitatorUrl: process.env.X402_FACILITATOR_URL,
  cdpApiKeyId: process.env.CDP_API_KEY_ID,
  cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
  routes: {
    "GET /v1/resource": {
      description: "One paid response",
      handler: async () => ({ status: 200, body: { ok: true } }),
    },
  },
})
server.listen(8787, "127.0.0.1")
```

Without `X402_FACILITATOR_URL` and CDP credentials the process still quotes a price, and it answers `503` instead of returning the resource. Nothing is charged.

## How you get paid

Revenue is USDC on Base sent to `X402_PAY_TO`. This repo does not move funds by itself. Settlement is a POST to Coinbase's facilitator, which submits the buyer's authorization. You do not put a wallet private key on the server.

1. Choose the Base address that should receive USDC. The address already published for donations is `0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E` (see `FUNDING.yml`). Use it as `X402_PAY_TO` only if you control it. Otherwise create a new address and do not commit its key.
2. Create a Coinbase Developer Platform project at <https://portal.cdp.coinbase.com/> and a secret API key. Put `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` in the server environment, not in git and not in GitHub Actions.
3. Start `ax402-serve` with the variables in the seller section. `GET /health` must report `"settlement": "facilitator"`.
4. Put the process behind HTTPS at `X402_PUBLIC_URL`. A reverse proxy to `127.0.0.1` is enough; set `X402_HOST=0.0.0.0` only if the host itself should listen publicly.
5. From another machine, install this package, run `ax402 new`, send a small amount of USDC on Base to that buyer address, and `ax402 pay` your `/v1/resource` URL.
6. Confirm `GET /stats` increased `revenueUsd` and that the USDC arrived at `X402_PAY_TO` before you raise `X402_PRICE_USD`.

Coinbase's facilitator documents a free tier of 1,000 settlements a month and $0.001 after that. Confirm the current price on their facilitator pricing page before you rely on it. The buyer pays the USDC amount you set. You do not pay gas for the USDC transfer.

`GET /stats` is the ledger of settlements this process has seen (`revenueUsd`, `paid`, recent `payments` with payer, amount, and transaction hash). It is memory-only, so it resets when the process restarts. The chain transfer is the source of truth.

## Publish the package

`agent-x402` is not on npm yet. The Publish workflow runs `npm publish` only for a `v*` tag, using the `NPM_TOKEN` repository secret. Pull requests run `npm publish --dry-run` and do not publish.

1. Create an npm account that can publish the `agent-x402` name.
2. Create an **Automation** access token (a publish token that requires 2FA will not work in Actions).
3. In this GitHub repo: Settings → Secrets and variables → Actions → New repository secret. Name: `NPM_TOKEN`. Value: that token.
4. Merge this branch. Do not create a tag until the secret exists.
5. Tag the version in `package.json` and push the tag:

```bash
git checkout main
git pull
git tag v0.2.0
git push origin v0.2.0
```

The tag must be exactly `v` plus `package.json`'s `version`. The workflow fails if they differ, and it fails with a clear error if `NPM_TOKEN` is empty. A second workflow attaches the npm tarball to a GitHub release for the same tag. Provenance is requested via `--provenance`.

## Develop

```bash
npm ci
npm test
npm run lint
```

`LIVE=1 npm test` also quotes `https://api.venice.ai/api/v1/chat/completions` and does not pay. Everything else uses a local server and never broadcasts a transaction.

## Security

The buyer key is a hot wallet. Keep it in `wallet.json` (mode 600) or in `PRIVATE_KEY` in the environment of the process that signs. The seller does not need that key. CDP credentials settle real USDC; treat them like a production API secret. Payments that a facilitator accepts are irreversible. Report vulnerabilities through GitHub Security Advisories, not public issues. Details: [SECURITY.md](./SECURITY.md).

## License

MIT © rustemmustafingovua-byte
