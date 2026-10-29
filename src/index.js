import { createRequire } from "node:module"

export {
  X402Client,
  X402Error,
  createAgentWallet,
  parseRequirements,
  pickOption,
  signPayment,
  makeNonce,
  usdcBalance,
  domainFor,
  chainIdFromNetwork,
  isBaseNetwork,
  atomicToUsd,
  usdToAtomic,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_BASE,
  USDC_BASE_DOMAIN,
  BASE_NETWORK,
} from "./x402.js"
export { SpendPolicy } from "./policy.js"
export { createPaidServer, buildPaymentRequired, verifyAuthorization } from "./seller.js"

export const version = createRequire(import.meta.url)("../package.json").version
