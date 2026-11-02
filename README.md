<div align="center">

# Agent X402

[![CI](https://github.com/rustemmustafingovua-byte/agent-x402/actions/workflows/ci.yml/badge.svg)](https://github.com/rustemmustafingovua-byte/agent-x402/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/agent-x402?color=cb3837&logo=npm)](https://www.npmjs.com/package/agent-x402) [![license](https://img.shields.io/badge/license-MIT-8b949e?logo=opensourceinitiative)](./LICENSE)

</div>

---

**x402 micropayments for AI agents — pay per API call in USDC on Base. No account, no API key, no subscription. With a spend policy a prompt injection cannot talk its way past.**

---

⭐ **Star us on GitHub** if this project helps you build better agents!

---

## 🚀 Быстрый старт

```bash
git clone https://github.com/rustemmustafingovua-byte/agent-x402
cd agent-x402 && npm install
npm test
```

---

## 🎯 Демо

```js
const {X402Client, SpendPolicy} = require('agent-x402');
const client = new X402Client({
  privateKey: process.env.PRIVATE_KEY,
  policy: new SpendPolicy({ dailyUsd: 5, perRequestUsd: 0.5 })
});
const res = await client.fetch('https://api.venice.ai/api/v1/chat/completions', {
  method: 'POST',
  body: { model: 'claude-haiku-5-5', messages: [{role:'user',content:'hi'}] }
});
console.log('Paid:', res.paid, 'Amount USD:', res.amountUsd);
```

---

## 💰 Монетизация

- **Pay-per-call API**: продавайте доступ к своим API через x402 — $0 за подписку, оплата за вызов в USDC
- **Hosted endpoints**: запустите inference-сервис и получайте микро-платежи за каждый запрос
- **Consulting**: аудит x402-интеграций для enterprise-клиентов
- **Plugin marketplace**: публикуйте плагины для x402-клиента в npm

---

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/amazing-thing`)
3. Commit your changes (`git commit -m 'feat: add amazing thing'`)
4. Push to the branch (`git push origin feat/amazing-thing`)
5. Open a Pull Request

Bug reports and feature requests are welcome on the [Issues](https://github.com/rustemmustafingovua-byte/agent-x402/issues) page.

MIT © rustemmustafingovua-byte


---

## 🌐 Multi-Chain Support (Base & Solana)

agent-x402 supports dual payment rails across Base (EVM EIP-3009) and Solana (SPL tokens):

| Network | CAIP-2 Identifier | Asset | Default Mint / Contract |
| :--- | :--- | :--- | :--- |
| **Base** | `eip155:8453` | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| **Solana** | `solana:5eykt4UsFv8P8NJdTREY1vzqKqZKvdp` | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

### Solana SPL Signing Example

```js
import { 
  createSolanaAgentWallet, 
  signSolanaPayment, 
  pickOption,
  SOLANA_MAINNET, 
  USDC_SOLANA 
} from "agent-x402"

const agentWallet = createSolanaAgentWallet()
const selectedOption = pickOption(requirements, { network: SOLANA_MAINNET })

const payment = await signSolanaPayment({
  keypair: agentWallet.keypair,
  to: selectedOption.payTo,
  amount: selectedOption.amount,
  mint: USDC_SOLANA,
  validAfter: Math.floor(Date.now() / 1000) - 30,
  validBefore: Math.floor(Date.now() / 1000) + 3600
})
```
