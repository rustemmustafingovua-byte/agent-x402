# Changelog

All notable changes to this project follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- see the open issues — anything labelled 💰 Reward can be picked up

## [0.2.0] - 2026-10-29

### Added
- `ax402-serve` quotes an x402 price and settles USDC on Base through a facilitator
- spend holds so in-flight payments share one cap, and failed calls do not count
- CLI and MCP persist the policy ledger separately from the caps

### Fixed
- payment payloads are x402 v2 JSON (EIP-3009 fields are strings, so signing can be encoded)
- the publish workflow runs jobs and publishes to npm on a `v*` tag using `NPM_TOKEN`
- the MCP server imports the library, and tool results still omit the private key

## [0.1.0] - 2026-10-20

### Added
- first release of `agent-x402`
- MIT licensed, CI on Node 20/22/24
