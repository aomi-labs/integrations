# Aomi integrations

Where Aomi meets other people's protocols. Each directory is one integration with its own README, dependencies, configuration and tests; nothing here is part of Aomi's own infrastructure or SDK. MIT.

## Integrations in this repository

| Directory | Partner | What it does | Status |
| --- | --- | --- | --- |
| [`shadow/`](shadow/) | [Shadow](https://www.shadowbuild.xyz), agent credit lines on Arc | Sells [Aomi Task API](https://staging.aomi.dev/research/introducing-the-aomi-task-api) builds through a Shadow sponsored credit line. A Shadow provider server that resells one Aomi transaction build: the agent stakes what it will pay, the contract pays the provider, the provider buys the task from Aomi after payment and repays the unused stake to the agent's line | Engineering preview for the Shadow public testnet pilot; no live purchase yet |

## Integrations that live elsewhere

Partner apps that run on the Aomi runtime are kept in the partner's own repository, under `integrations/aomi`, and deployed through Aomi Build. They are never added to `aomi-labs/aomi-sdk`, which holds first-party apps only.

| Partner | Shape | Where |
| --- | --- | --- |
| ReasoningReceipt | Aomi app: audit purchase and settlement on Arc, build-time deployment JSON, guarded `evm-core` tools | `integrations/aomi` in the ReasoningReceipt repository |
| Trustless Work | Aomi app: escrow operations on Arc testnet | `integrations/aomi` in the Trustless Work contract repository |

## The two patterns so far

**Aomi as the runtime (partner app).** The partner's service becomes an Aomi app: a Rust crate pinned to an exact `aomi-sdk` version with `.aomi/config.json`, `aomi.toml` and a committed `Cargo.lock`, a build-time deployment file that generates the chain, contract and selector guard, `simulate_batch` enforced before any commit, and independent verification of what the partner's API returns. The user's wallet signs everything; the app never signs on its own. It lives in the partner's repository and is deployed through Aomi Build.

**Aomi as the upstream service (partner protocol).** The partner has its own payment or settlement protocol and Aomi is a service bought through it. The integration is a thin adapter around two pinned pieces: the partner's reference server (its protocol, store and replay rules, untouched) and Aomi's Task API client (x402 purchase, fee caps, attestation check, payment journal). The adapter adds only what neither side knows: how a partner purchase maps to one Task API request, who pays what when the two fee models differ, and what the buyer gets back. The partner, not Aomi, hosts it; Aomi's Task API and infrastructure are unchanged. `shadow/` is the first of these.

Conventions that hold for both: one directory per integration, its own `README`, `example.env` and tests; third-party code vendored as pinned git submodules under `<integration>/vendor/`, never copied; every purchase or payment journaled so a retry never pays twice; secrets read from the environment at use and never written to the repository; results from the partner treated as untrusted until verified against the partner's signatures and Aomi's attestation.

## Adding an integration

Create `<name>/` with a README that says what is bought or run, by whom, and who hosts it; pin third-party code as submodules; give it tests at the boundary with the partner's code and with Aomi's; add a row above. Keep Aomi's own services out of scope: an integration consumes them, it does not change them.
