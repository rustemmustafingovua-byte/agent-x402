# Security policy

## Reporting a vulnerability

Use **Security → Report a vulnerability** on GitHub. Please do not open a public
issue for a suspected flaw in the security-relevant code.

## What this tool handles

This tool holds a private key and signs USDC payments. Treat it as a hot wallet.

- the buyer key stays in the process that signs; it is never logged. The CLI writes it to `~/.config/agent-x402/wallet.json` mode 600 and does not print it
- the spend policy is enforced **before** signing — daily cap, per-request cap, payment count, payee allow-list, blocked contracts, per-network cap
- a payment is counted only after the paid response succeeds. A second in-flight payment sees the hold
- the seller does not take a signing key. `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` belong in the host environment. They authorize settlement of real USDC
- the in-memory nonce list stops a replay on one process. The facilitator and the USDC nonce are what stop a replay across processes
- x402 payments are irreversible once settled — test with a small amount first

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | ✅ |
| 0.1.x | ❌ |
