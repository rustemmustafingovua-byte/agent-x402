/**
 * On-disk wallet and spend policy. The private key is written mode 0600 and is never logged.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { SpendPolicy } from "./policy.js"

export function configHome(home = process.env.AX402_HOME || homedir()) {
  return home
}

export function configDir(home = configHome()) {
  return join(home, ".config", "agent-x402")
}

export function walletFile(home = configHome()) {
  return join(configDir(home), "wallet.json")
}

export function policyFile(home = configHome()) {
  return join(configDir(home), "policy.json")
}

export function readWallet(home = configHome()) {
  const file = walletFile(home)
  if (!existsSync(file)) return null
  const data = JSON.parse(readFileSync(file, "utf8"))
  if (!data || typeof data.privateKey !== "string" || typeof data.address !== "string") return null
  return { address: data.address, privateKey: data.privateKey }
}

export function writeWallet(wallet, home = configHome()) {
  const file = walletFile(home)
  mkdirSync(configDir(home), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey }, null, 2) + "\n",
    { mode: 0o600 },
  )
  chmodSync(file, 0o600)
}

export function readPolicy(home = configHome()) {
  const file = policyFile(home)
  if (!existsSync(file)) return new SpendPolicy()
  return SpendPolicy.restore(JSON.parse(readFileSync(file, "utf8")))
}

export function writePolicy(policy, home = configHome()) {
  const file = policyFile(home)
  mkdirSync(configDir(home), { recursive: true })
  writeFileSync(file, JSON.stringify(policy.serialize(), null, 2) + "\n", { mode: 0o600 })
  chmodSync(file, 0o600)
}
