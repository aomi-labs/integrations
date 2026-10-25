# Aomi integrations

Where Aomi meets other people's protocols and products. Each directory here is one integration with its own README, dependencies, configuration and tests; nothing in this repository is part of Aomi's own infrastructure or SDK. MIT.

Most integrations do not live here. They live in the partner's repository as an Aomi app, or in a partner platform repository that builds them. This README is the index for both kinds.

## Standalone integration: in this repository

Aomi is the upstream service behind a partner's own protocol. The code is an adapter around the partner's reference server and Aomi's Task API client, hosted by the partner.

| Directory | Partner | What it does | Status |
| --- | --- | --- | --- |
| [`shadow/`](shadow/) | [Shadow](https://www.shadowbuild.xyz), agent credit lines on Arc | Sells [Aomi Task API](https://staging.aomi.dev/research/introducing-the-aomi-task-api) builds through a Shadow sponsored credit line. A Shadow provider server that resells one Aomi transaction build: the agent stakes what it will pay, the contract pays the provider, the provider buys the task from Aomi after payment and repays the unused stake to the agent's line | Engineering preview for the Shadow public testnet pilot; no live purchase yet |

## Plugin integration: living elsewhere

The partner's service becomes an Aomi app: a Rust `cdylib` crate that Aomi's runtime loads, kept in the partner's own repository (or a fork we drive) and deployed through Aomi Build onto the partner's platform. These apps are never added to `aomi-labs/aomi-sdk`, which holds first-party apps only.

| Partner | Chain | What the app does | Where |
| --- | --- | --- | --- |
| [Somm Finance](https://somm.finance) (Agentic Somm, by PeggyJV / iqlusion) | Ethereum, Arbitrum, Base via Aurora Intents | `somm-agent`: idle assets, risk snapshot, position assessment, credit balance and a recommendation card. Each tool forwards to the deployed Somm HTTP API and mirrors the TypeScript MCP proxy in `agentic-somm/mcp` one to one. Observes and recommends only; the user approves every deployment in the Somm preview flow. The Somm frontend also embeds the Aomi widget at `/copilot` | `PeggyJV/somm-agent` (private), platform repo `aomi-labs/somm-finance-apps`; earlier copies in `CeciliaZ030/somm-agent`, `CeciliaZ030/somm-agent-aa-e2e`, `aomi-labs/somm-agent-new-fork` |
| [World Markets](https://worldmarkets.xyz) | UniFi testnet 2092151908, MegaETH mainnet | `world-markets`: reads the World exchange contract (assets, account, markets, rates, loans, open orders, PnL), previews trades against a signed mandate with ATLAS post-trade risk, and ships the execution procedure and guard table the host enforces. Pairs with the World Mini App and the Telegram handover (below) | `CeciliaZ030/world-markets-agent` (app plus `mini-app/`), `aomi-labs/world-markets-agent` (private, read-only v0.1), platform repo `aomi-labs/world-market-apps` |
| [ACR, Arc Compute Rate](https://github.com/kaustubh76/ACR---Arc-Compute-Rate) | Arc mainnet 5042 | Five read-only tools: check a compute bill against cited public prices, wallet overpayment, seller rating, the on-chain index print and its receipts. `namespaces = []`, so nothing signs or spends. ACR's terminal also embeds the Aomi widget for owner payments and the agent drawer | `integrations/aomi` in `kaustubh76/ACR---Arc-Compute-Rate` (our fork: `CeciliaZ030/ACR---Arc-Compute-Rate`) |
| [ReasoningReceipt](https://github.com/tang-vu/reasoning-receipt) | Arc testnet 5042002 | Two apps: `reasoning-receipt-audit` (Aomi audits the reasoner's trace, seals and publishes the receipt) and `reasoning-receipt/settlement` (wallet-approved USDC settlement, gated on a published audit). Build-time deployment JSON generates the chain, contract and selector guard | `integrations/aomi` and `integrations/aomi-audit` in the ReasoningReceipt repository (our fork: `CeciliaZ030/reasoning-receipt`, PRs #1 and #2) |
| [Trustless Work](https://www.trustlesswork.com) | Arc testnet 5042002 | Turns a service agreement into a single-release escrow: the Trustless Work Arc API builds the unsigned deploy, the app decodes and checks it field by field, the user reviews, the host simulates. Never signs or broadcasts | `CeciliaZ030/ext-trustless-app` (source of truth), handed to the partner as a patch for `trustlesswork-smart-contract-arc` |
| [Mandate](https://mandate-three-pi.vercel.app) | Arc mainnet | `mandate-agent`: read-only tools for treasury status, bills, decisions, decision records and Arc events of a USDC budget with hard limits (Morpho ERC-4626 venue) | `aomi/mandate-agent` in `CeciliaZ030/mandate` |
| [Byreal](https://byreal.io) | Solana | White-labeled platform apps: `byreal` (spot, Hyperliquid perps, copy-farming analytics, reward claims), `byreal-lp` (CLMM positions), `byreal-copy-trade`, `byreal-strategies` (DCA, idle yield, stop-loss, take-profit on the host scheduler) | `aomi-labs/byreal-apps` |
| Helixa (AgentDNA) | none, public API reads | v0 read-only: search agents, agent profile, Cred check, compare agents | `helixa/` in `CeciliaZ030/helixa-aomi-app-v0` |
| Steward (LiqSteward), Aomi-built | Ethereum (Morpho vaults) | Manager-controlled vault operations: turns a risk signal into alternatives, validates the plan against fresh chain state, runs the calldata through stage-and-simulate and produces an unsigned Safe package. Apps `liqsteward`, `liqsteward-core`, `nav-oracle` | `aomi-app/` in `aomi-labs/liqsteward` |
| Hoodit, Aomi-built | Robinhood Chain | Token and launchpad discovery, market research, exit checks and user-authorized trades; nine read tools over Codex, LI.FI and chain transport. The site mounts the Aomi widget at `/app` | `apps/hoodit/` in `aomi-labs/hoodit-apps` (private) |

### Partner platforms

A partner with several apps gets a platform repository. The Aomi backend stages app source there, the repository's GitHub Actions build the release `cdylib`, and the backend activates the chosen release. Nobody hand-edits `apps/`.

| Platform | Repository |
| --- | --- |
| `somm.finance` | `aomi-labs/somm-finance-apps` |
| `world-market-apps` | `aomi-labs/world-market-apps` |
| `byreal` | `aomi-labs/byreal-apps` |
| `krexa` | `aomi-labs/krexa-hosted-apps` |
| `community` (anyone) | `aomi-labs/community-apps` |

### Embedding Aomi in a partner product

Not an app but a surface. Used by ACR's terminal, Somm's `/copilot`, Hoodit's `/app`, and the Para chat fork (`aomi-labs/chat-para`).

| Surface | What it is | Where |
| --- | --- | --- |
| Aomi widget | `@aomi-labs/widget` React component pinned to one app; sessions issued by the Aomi Portal and bound to the browser origin | `aomi-labs/aomi` |
| Telegram handover | The partner's web app is the custody surface, Telegram the autonomy surface. A QR with zero authority attaches a Telegram identity; the owner signs the venue grant in the web session; the agent then trades the venue account from Telegram. Platform-bearer channel (partner BFF) or wallet channel (partner venue row, SIWE against the venue's on-chain registry). World Markets is the first venue | `aomi-labs/demo-world-markets-tg-fe` (reference frontend), `aomi-labs/telegram` (multi-tenant mini-app service, `tenants/world`), channel rules in product-mono `docs/topics/clients/` |

### Aomi as a client library or plugin in someone else's agent

| Package | What it does | Where |
| --- | --- | --- |
| `@aomi-labs/eliza-plugin-aomi` | Delegates natural-language on-chain work from an elizaOS agent to Aomi; wallet custody and transaction approval stay in Eliza, every wallet request stops at an exact preview and needs a second confirmation turn | `aomi-labs/eliza-plugin-aomi` |
| `aomi` (Python) | Pipeline API client: catalog, chain reads, stage, simulate, commit with the Build posted back verbatim | `aomi-labs/aomi-python` |
| Aomi × Circle Execution Kit | Two-stage Task API client (0.01 USDC preparation, 3% of simulated outflow for the frozen result) and a Circle Arc wallet helper for Tameion hackathon builders; plus an Arc Agent-in-a-Box template | `packages/task-client`, `packages/circle-arc-wallet`, `templates/invoice-agent` in `aomi-labs/arc-canteen` |

## The patterns so far

**Aomi as the upstream service (standalone, here).** The partner has its own payment or settlement protocol and Aomi is a service bought through it. The integration is a thin adapter around two pinned pieces: the partner's reference server (its protocol, store and replay rules, untouched) and Aomi's Task API client (x402 purchase, fee caps, attestation check, payment journal). The adapter adds only what neither side knows: how a partner purchase maps to one Task API request, who pays what when the two fee models differ, and what the buyer gets back. The partner, not Aomi, hosts it; Aomi's Task API and infrastructure are unchanged. `shadow/` is the first of these.

**Aomi as the runtime (plugin, elsewhere).** The partner's service becomes an Aomi app: a Rust crate pinned to an exact `aomi-sdk` version with `.aomi/config.json`, `aomi.toml` and a committed `Cargo.lock`. Two sub-shapes recur:

- *Forwarder.* Each tool calls the partner's existing HTTP API and re-implements nothing (Somm, ACR, Mandate, Helixa, Trustless Work's deploy builder). The runtime loads only compiled Rust plugins, not MCP servers, so a partner with an MCP proxy writes the Rust mirror of it.
- *Direct chain reader with guarded execution.* The app reads the partner's contracts itself and, where it executes, ships the guard table the host enforces: a build-time deployment file that generates the chain, contract and selector guard, `simulate_batch` before any commit, and independent verification of what the partner's API returns (World Markets, ReasoningReceipt, Steward). The user's wallet signs everything; the app never signs on its own.

Either way the app lives in the partner's repository and is deployed through Aomi Build onto a partner platform, or onto `community` when the partner has only one app.

**Aomi as a surface in the partner's product.** The widget pinned to the partner's app, or the Telegram handover for partners whose users already hold a venue account. The partner keeps custody; Aomi gets authority only through a grant the owner signs in the partner's own session.

**Aomi behind someone else's agent.** Eliza plugin, Python client, hackathon kits. Aomi is a tool the other agent calls; approval of anything that moves funds stays with that agent's user.

Conventions that hold for all of them: one directory per integration with its own `README`, `example.env` and tests; third-party code vendored as pinned git submodules under `<integration>/vendor/` or pinned by exact version, never copied; every purchase or payment journaled so a retry never pays twice; secrets read from the environment at use and never written to a repository; results from the partner treated as untrusted until verified against the partner's signatures and Aomi's attestation; read-only by default, with every write stopping at a preview the user approves.

## Adding an integration

Standalone: create `<name>/` here with a README that says what is bought or run, by whom, and who hosts it; pin third-party code as submodules; give it tests at the boundary with the partner's code and with Aomi's; add a row to the first table. Plugin: build it in the partner's repository (or a fork we drive), pin `aomi-sdk` exactly, deploy through Aomi Build, and add a row to the second table. Keep Aomi's own services out of scope: an integration consumes them, it does not change them.
