import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) files(path, out)
    else if (/\.(js|mjs|yml|yaml|md|json|html|svg)$/.test(name)) out.push(path)
  }
  return out
}

test("source files do not contain a hardcoded private key", () => {
  const key = /0x[0-9a-fA-F]{64}/
  const hits = []
  for (const path of files(root)) {
    const text = readFileSync(path, "utf8")
    if (key.test(text)) hits.push(relative(root, path))
  }
  assert.deepEqual(hits, [])
})

test("package version matches the registry manifest", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const manifest = JSON.parse(readFileSync(join(root, "server.json"), "utf8"))
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.packages[0].version, pkg.version)
  assert.equal(pkg.publishConfig.access, "public")
  assert.equal(pkg.bin["ax402-serve"], "bin/ax402-serve.js")
})

test("the publish workflow does not read secrets from an if condition", () => {
  const workflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8")
  assert.doesNotMatch(workflow, /if:.*secrets\./)
  assert.match(workflow, /NPM_TOKEN/)
  assert.match(workflow, /refs\/tags\/v/)
  assert.match(workflow, /npm publish/)
})
