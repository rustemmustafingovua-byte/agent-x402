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
