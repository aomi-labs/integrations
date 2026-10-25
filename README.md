# Aomi integrations

Where Aomi meets other people's protocols and products. Each directory here is one integration with its own README, dependencies, configuration and tests; nothing in this repository is part of Aomi's own infrastructure or SDK. MIT.

Most integrations do not live here. They live in the partner's repository as an Aomi app, or in a partner platform repository that builds them. This README is the index for both kinds.

## Standalone integration: in this repository

Aomi is the upstream service behind a partner's own protocol. The code is an adapter around the partner's reference server and Aomi's Task API client, hosted by the partner.

| Directory | Partner | What it does | Status |
| --- | --- | --- | --- |
| [`shadow/`](shadow/) | [Shadow](https://www.shadowbuild.xyz), agent credit lines on Arc | Sells [Aomi Task API](https://staging.aomi.dev/research/introducing-the-aomi-task-api) builds through a Shadow sponsored credit line. A Shadow provider server that resells one Aomi transaction build: the agent stakes what it will pay, the contract pays the provider, the provider buys the task from Aomi after payment and repays the unused stake to the agent's line | Engineering preview for the Shadow public testnet pilot; no live purchase yet |

## Plugin integration: living elsewhere

The partner's service becomes an Aomi app: a Rust `cdylib` crate that Aomi's runtime loads, kept in the partner's own repository (or a fork we drive) and deployed through Aomi Build onto the partner's platform. These apps are never added to [`aomi-labs/aomi-sdk`](https://github.com/aomi-labs/aomi-sdk), which holds first-party apps only.

| Partner | Chain | What the app does | App where | Widget where |
| --- | --- | --- | --- | --- |
| [Somm Finance](https://somm.finance) (Agentic Somm, by PeggyJV / iqlusion) | Ethereum, Arbitrum, Base via Aurora Intents | `somm-agent`: idle assets, risk snapshot, position assessment, credit balance and a recommendation card. Each tool forwards to the deployed Somm HTTP API and mirrors the TypeScript MCP proxy in `agentic-somm/mcp` one to one. Observes and recommends only; the user approves every deployment in the Somm preview flow | [`PeggyJV/somm-agent`](https://github.com/PeggyJV/somm-agent) (private), platform [`aomi-labs/somm-finance-apps`](https://github.com/aomi-labs/somm-finance-apps); earlier copies [`CeciliaZ030/somm-agent`](https://github.com/CeciliaZ030/somm-agent), [`CeciliaZ030/somm-agent-aa-e2e`](https://github.com/CeciliaZ030/somm-agent-aa-e2e), [`aomi-labs/somm-agent-new-fork`](https://github.com/aomi-labs/somm-agent-new-fork) | [`iqlusioninc/agentic-somm` `/copilot`](https://github.com/iqlusioninc/agentic-somm/blob/main/src/pages/copilot.tsx) (private) |
| [World Markets](https://worldmarkets.xyz) | UniFi testnet 2092151908, MegaETH mainnet | `world-markets`: reads the World exchange contract (assets, account, markets, rates, loans, open orders, PnL), previews trades against a signed mandate with ATLAS post-trade risk, and ships the execution procedure and guard table the host enforces | [`CeciliaZ030/world-markets-agent`](https://github.com/CeciliaZ030/world-markets-agent), [`aomi-labs/world-markets-agent`](https://github.com/aomi-labs/world-markets-agent) (private, read-only v0.1), platform [`aomi-labs/world-market-apps`](https://github.com/aomi-labs/world-market-apps) | No widget. World Mini App [`world-markets-agent/mini-app`](https://github.com/CeciliaZ030/world-markets-agent/tree/publish/mini-app); Telegram handover [`aomi-labs/demo-world-markets-tg-fe`](https://github.com/aomi-labs/demo-world-markets-tg-fe) and [`aomi-labs/telegram/tenants/world`](https://github.com/aomi-labs/telegram/tree/main/tenants/world) |
| [ACR, Arc Compute Rate](https://github.com/kaustubh76/ACR---Arc-Compute-Rate) | Arc mainnet 5042 | Five read-only tools: check a compute bill against cited public prices, wallet overpayment, seller rating, the on-chain index print and its receipts. `namespaces = []`, so nothing signs or spends | [`kaustubh76/ACR---Arc-Compute-Rate/integrations/aomi`](https://github.com/kaustubh76/ACR---Arc-Compute-Rate/tree/main/integrations/aomi) (our fork [`CeciliaZ030/ACR---Arc-Compute-Rate`](https://github.com/CeciliaZ030/ACR---Arc-Compute-Rate)) | [`apps/terminal/components/AgentChat.tsx`](https://github.com/kaustubh76/ACR---Arc-Compute-Rate/blob/main/apps/terminal/components/AgentChat.tsx): owner payments and the agent drawer in the ACR terminal |
| [ReasoningReceipt](https://github.com/tang-vu/reasoning-receipt) | Arc testnet 5042002 | Two apps: `reasoning-receipt-audit` (Aomi audits the reasoner's trace, seals and publishes the receipt) and `reasoning-receipt/settlement` (wallet-approved USDC settlement, gated on a published audit). Build-time deployment JSON generates the chain, contract and selector guard | [`tang-vu/reasoning-receipt`](https://github.com/tang-vu/reasoning-receipt) `integrations/aomi` and `integrations/aomi-audit`, via our fork [`CeciliaZ030/reasoning-receipt#1`](https://github.com/CeciliaZ030/reasoning-receipt/pull/1) and [`#2`](https://github.com/CeciliaZ030/reasoning-receipt/pull/2) | None yet; the hosted app and wallet prompt are untested |
| [Trustless Work](https://www.trustlesswork.com) | Arc testnet 5042002 | Turns a service agreement into a single-release escrow: the Trustless Work Arc API builds the unsigned deploy, the app decodes and checks it field by field, the user reviews, the host simulates. Never signs or broadcasts | [`CeciliaZ030/ext-trustless-app`](https://github.com/CeciliaZ030/ext-trustless-app) (source of truth), handed to the partner as a patch for [`Trustless-Work/trustlesswork-smart-contract-arc`](https://github.com/Trustless-Work/trustlesswork-smart-contract-arc) | Proposed, not built: would live in the partner's Backoffice ([`Trustless-Work/trustlesswork-backoffice-arc`](https://github.com/Trustless-Work/trustlesswork-backoffice-arc)) |
| [Mandate](https://mandate-three-pi.vercel.app) | Arc mainnet | `mandate-agent`: read-only tools for treasury status, bills, decisions, decision records and Arc events of a USDC budget with hard limits (Morpho ERC-4626 venue) | [`Makabeez/mandate/aomi/mandate-agent`](https://github.com/Makabeez/mandate/tree/main/aomi/mandate-agent) (our fork [`CeciliaZ030/mandate`](https://github.com/CeciliaZ030/mandate)) | [`app/agent.html`](https://github.com/CeciliaZ030/mandate/blob/aomi-widget/app/agent.html) and [`app/src/agent.tsx`](https://github.com/CeciliaZ030/mandate/blob/aomi-widget/app/src/agent.tsx), the "Ask the agent" page off the dashboard; proposed in [CeciliaZ030/mandate#1](https://github.com/CeciliaZ030/mandate/pull/1) |
| Steward (LiqSteward), Aomi-built | Ethereum (Morpho vaults) | Manager-controlled vault operations: turns a risk signal into alternatives, validates the plan against fresh chain state, runs the calldata through stage-and-simulate and produces an unsigned Safe package. Apps `liqsteward`, `liqsteward-core`, `nav-oracle` | [`aomi-labs/liqsteward/aomi-app`](https://github.com/aomi-labs/liqsteward/tree/main/aomi-app) | [`aomi-labs/liqsteward/apps/web`](https://github.com/aomi-labs/liqsteward/blob/main/apps/web/src/App.tsx), the Steward control room |
| Hoodit, Aomi-built | Robinhood Chain | Token and launchpad discovery, market research, exit checks and user-authorized trades; nine read tools over Codex, LI.FI and chain transport | [`aomi-labs/hoodit-apps/apps/hoodit`](https://github.com/aomi-labs/hoodit-apps/tree/main/apps/hoodit) (private) | [`aomi-labs/hoodit-apps/src/app`](https://github.com/aomi-labs/hoodit-apps/blob/main/src/app/hoodit-widget.tsx) (private), mounted at `/app` on hoodit.trade |

### Partner platforms

A partner with several apps gets a platform repository. The Aomi backend stages app source there, the repository's GitHub Actions build the release `cdylib`, and the backend activates the chosen release. Nobody hand-edits `apps/`.

| Platform | Repository |
| --- | --- |
| `somm.finance` | [`aomi-labs/somm-finance-apps`](https://github.com/aomi-labs/somm-finance-apps) |
| `world-market-apps` | [`aomi-labs/world-market-apps`](https://github.com/aomi-labs/world-market-apps) |
| `krexa` | [`aomi-labs/krexa-hosted-apps`](https://github.com/aomi-labs/krexa-hosted-apps) |
| `community` (anyone) | [`aomi-labs/community-apps`](https://github.com/aomi-labs/community-apps) |

### Embedding Aomi in a partner product

Not an app but a surface. The per-partner locations are in the "Widget where" column above; also used by the Para chat fork ([`aomi-labs/chat-para`](https://github.com/aomi-labs/chat-para)).

| Surface | What it is | Where |
| --- | --- | --- |
| Aomi widget | `@aomi-labs/widget` React component pinned to one app; sessions issued by the Aomi Portal and bound to the browser origin | [`aomi-labs/aomi`](https://github.com/aomi-labs/aomi) |
| Telegram handover | The partner's web app is the custody surface, Telegram the autonomy surface. A QR with zero authority attaches a Telegram identity; the owner signs the venue grant in the web session; the agent then trades the venue account from Telegram. Platform-bearer channel (partner BFF) or wallet channel (partner venue row, SIWE against the venue's on-chain registry). World Markets is the first venue | [`aomi-labs/demo-world-markets-tg-fe`](https://github.com/aomi-labs/demo-world-markets-tg-fe) (reference frontend), [`aomi-labs/telegram`](https://github.com/aomi-labs/telegram) (multi-tenant mini-app service, [`tenants/world`](https://github.com/aomi-labs/telegram/tree/main/tenants/world)), channel rules in product-mono `docs/topics/clients/` |

### Aomi as a client library or plugin in someone else's agent

| Package | What it does | Where |
| --- | --- | --- |
| `@aomi-labs/eliza-plugin-aomi` | Delegates natural-language on-chain work from an elizaOS agent to Aomi; wallet custody and transaction approval stay in Eliza, every wallet request stops at an exact preview and needs a second confirmation turn | [`aomi-labs/eliza-plugin-aomi`](https://github.com/aomi-labs/eliza-plugin-aomi) |
| `aomi` (Python) | Pipeline API client: catalog, chain reads, stage, simulate, commit with the Build posted back verbatim | [`aomi-labs/aomi-python`](https://github.com/aomi-labs/aomi-python) |
| Aomi × Circle Execution Kit | Two-stage Task API client (0.01 USDC preparation, 3% of simulated outflow for the frozen result) and a Circle Arc wallet helper for Tameion hackathon builders; plus an Arc Agent-in-a-Box template | [`packages/task-client`](https://github.com/aomi-labs/arc-canteen/tree/main/packages/task-client), [`packages/circle-arc-wallet`](https://github.com/aomi-labs/arc-canteen/tree/main/packages/circle-arc-wallet), [`templates/invoice-agent`](https://github.com/aomi-labs/arc-canteen/tree/main/templates/invoice-agent) in [`aomi-labs/arc-canteen`](https://github.com/aomi-labs/arc-canteen) |

## The patterns so far

**Aomi as the upstream service (standalone, here).** The partner has its own payment or settlement protocol and Aomi is a service bought through it. The integration is a thin adapter around two pinned pieces: the partner's reference server (its protocol, store and replay rules, untouched) and Aomi's Task API client (x402 purchase, fee caps, attestation check, payment journal). The adapter adds only what neither side knows: how a partner purchase maps to one Task API request, who pays what when the two fee models differ, and what the buyer gets back. The partner, not Aomi, hosts it; Aomi's Task API and infrastructure are unchanged. `shadow/` is the first of these.

**Aomi as the runtime (plugin, elsewhere).** The partner's service becomes an Aomi app: a Rust crate pinned to an exact `aomi-sdk` version with `.aomi/config.json`, `aomi.toml` and a committed `Cargo.lock`. Two sub-shapes recur:

- *Forwarder.* Each tool calls the partner's existing HTTP API and re-implements nothing (Somm, ACR, Mandate, Trustless Work's deploy builder). The runtime loads only compiled Rust plugins, not MCP servers, so a partner with an MCP proxy writes the Rust mirror of it.
- *Direct chain reader with guarded execution.* The app reads the partner's contracts itself and, where it executes, ships the guard table the host enforces: a build-time deployment file that generates the chain, contract and selector guard, `simulate_batch` before any commit, and independent verification of what the partner's API returns (World Markets, ReasoningReceipt, Steward). The user's wallet signs everything; the app never signs on its own.

Either way the app lives in the partner's repository and is deployed through Aomi Build onto a partner platform, or onto `community` when the partner has only one app.

**Aomi as a surface in the partner's product.** The widget pinned to the partner's app, or the Telegram handover for partners whose users already hold a venue account. The partner keeps custody; Aomi gets authority only through a grant the owner signs in the partner's own session.

**Aomi behind someone else's agent.** Eliza plugin, Python client, hackathon kits. Aomi is a tool the other agent calls; approval of anything that moves funds stays with that agent's user.

Conventions that hold for all of them: one directory per integration with its own `README`, `example.env` and tests; third-party code vendored as pinned git submodules under `<integration>/vendor/` or pinned by exact version, never copied; every purchase or payment journaled so a retry never pays twice; secrets read from the environment at use and never written to a repository; results from the partner treated as untrusted until verified against the partner's signatures and Aomi's attestation; read-only by default, with every write stopping at a preview the user approves.

## Adding an integration

Standalone: create `<name>/` here with a README that says what is bought or run, by whom, and who hosts it; pin third-party code as submodules; give it tests at the boundary with the partner's code and with Aomi's; add a row to the first table. Plugin: build it in the partner's repository (or a fork we drive), pin `aomi-sdk` exactly, deploy through Aomi Build, and add a row to the second table with both the app and the widget location linked. Keep Aomi's own services out of scope: an integration consumes them, it does not change them.
