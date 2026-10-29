/**
 * Coinbase Developer Platform request JWT.
 *
 * The facilitator at api.cdp.coinbase.com requires a short-lived Bearer token
 * whose `uris` claim is bound to the method, host, and path. The API secret
 * never leaves this process and is not written into the token.
 *
 * Key formats match CDP: a SEC1/PKCS8 PEM (ES256) or a 64-byte base64 Ed25519 key.
 */
import { createPrivateKey, randomBytes, sign } from "node:crypto"

function base64url(value) {
  return Buffer.from(value).toString("base64url")
}

function derToP1363(der, size = 32) {
  if (der[0] !== 0x30) throw new Error("ECDSA signature was not DER")
  let offset = 2
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f)
  const read = (start) => {
    if (der[start] !== 0x02) throw new Error("ECDSA signature integer missing")
    const length = der[start + 1]
    let bytes = der.subarray(start + 2, start + 2 + length)
    if (bytes[0] === 0x00) bytes = bytes.subarray(1)
    if (bytes.length > size) throw new Error("ECDSA signature integer is too large")
    const padded = Buffer.alloc(size)
    bytes.copy(padded, size - bytes.length)
    return { padded, next: start + 2 + length }
  }
  const r = read(offset)
  const s = read(r.next)
  return Buffer.concat([r.padded, s.padded])
}

function signingKey(secret) {
  const pem = secret.includes("\\n") ? secret.replace(/\\n/g, "\n") : secret
  if (pem.includes("BEGIN")) {
    return { alg: "ES256", key: createPrivateKey(pem) }
  }
  const decoded = Buffer.from(pem, "base64")
  if (decoded.length !== 64) {
    throw new Error("CDP API key secret must be a PEM EC key or a 64-byte base64 Ed25519 key")
  }
  return {
    alg: "EdDSA",
    key: createPrivateKey({
      format: "jwk",
      key: {
        kty: "OKP",
        crv: "Ed25519",
        d: decoded.subarray(0, 32).toString("base64url"),
        x: decoded.subarray(32).toString("base64url"),
      },
    }),
  }
}

/**
 * @param {{ apiKeyId: string, apiKeySecret: string, method: string, url: string, now?: number, expiresIn?: number }} opts
 * @returns {string} Bearer token, without the "Bearer " prefix
 */
export function cdpBearerToken({ apiKeyId, apiKeySecret, method, url, now, expiresIn = 120 }) {
  if (!apiKeyId) throw new Error("CDP API key id is required")
  if (!apiKeySecret) throw new Error("CDP API key secret is required")
  const target = new URL(url)
  const issuedAt = now ?? Math.floor(Date.now() / 1000)
  const { alg, key } = signingKey(apiKeySecret)
  const header = {
    alg,
    kid: apiKeyId,
    typ: "JWT",
    nonce: randomBytes(16).toString("hex"),
  }
  const payload = {
    sub: apiKeyId,
    iss: "cdp",
    aud: ["cdp_service"],
    uris: [`${method.toUpperCase()} ${target.host}${target.pathname}`],
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + expiresIn,
  }
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const data = Buffer.from(input)
  const signature =
    alg === "ES256"
      ? derToP1363(sign("sha256", data, key))
      : sign(null, data, key)
  return `${input}.${base64url(signature)}`
}
