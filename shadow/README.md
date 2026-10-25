# Aomi Task API on Shadow

Part of [aomi-labs/integrations](../README.md). Everything below runs from this directory.

Sell [Aomi Task API](https://staging.aomi.dev/research/introducing-the-aomi-task-api) builds through a [Shadow](https://www.shadowbuild.xyz) sponsored credit line on Arc testnet (chain `5042002`). A sponsor funds an agent's line naming this provider; the agent registers a task and stakes what it is willing to pay; the Shadow contract pays this provider the stake from the sponsor's reserve; the provider buys the task from Aomi with that money, hands back a frozen, attested, unsigned transaction bundle, and repays the unused part of the stake to the agent's line. The agent never pays x402 and nothing here signs or broadcasts the bundle.

This repository is the glue only. The provider protocol, store and no-double-charge rules are Shadow's reference provider server (`vendor/shadow`), and the Task API purchase, fee caps, attestation check and payment journal are Aomi's Task client (`vendor/product-mono`). Both are pinned git submodules. Whoever runs this server is a reseller: it sells one Shadow item and buys the underlying task from Aomi with its own x402 payer, after it has been paid.

## How a purchase runs

| Step | Who | What |
| --- | --- | --- |
| 1 | Sponsor | `registerSponsor`, `approve`, `openLine` on `ShadowFloatPublicTestnet` naming this provider's address, the endpoint string and a `providerPerSpendCap` large enough for the stakes the agent will make ([Shadow testnet guide](https://github.com/buildwithshadow/shadow/blob/main/docs/SELF_SERVICE_TESTNET.md)) |
| 2 | Agent | `POST /task` with the task request; receives the `requestId` and the `priceFloor`. Nothing is bought |
| 3 | Agent | Signs a Shadow `SpendIntent` to this provider and endpoint whose `principal` is its **stake**: the most it will pay for this task, at least `priceFloor`. Then `POST /accept` with the intent and the `requestId` |
| 4 | Provider | Checks the request is registered to this agent and the stake reaches the floor, records the stake under the intent's digest, and signs the `ServiceAcceptance`. Still nothing bought |
| 5 | Anyone | `executeSpend(intent, signature)`; the contract pays the provider the stake within the line's caps or records `SpendBlocked` and pays nothing |
| 6 | Agent | `POST /serve` once the digest is paid. Now the provider buys the task from Aomi (0.01 USDC preparation, then 3% of the measured outflow at retrieval) if the measured cost fits the stake, freezes the result, signs a `DeliveryReceipt`, and repays `stake − cost` to the line |
| 7 | Anyone | `repay(lineId, amount)` for what is left; the sponsor later `closeLine`s and reclaims the unused reserve |

Retrying `/task` with the same body answers the same id; retrying `/accept` with the same intent returns the stored acceptance; retrying `/serve` for the same digest returns the stored bytes. Shadow runs the service once per paid digest, the Task purchase is journaled per `requestId` and resumed, never bought again, and every refund is recorded before it is sent and never sent twice.

## Who risks what

The Task API fee depends on the task: 0.01 USDC per preparation plus `ceil(3% of the simulated gross outgoing USDC)` at retrieval. Shadow pays one principal per purchase. The agent resolves that by staking, and the provider clears after the fact.

| Outcome | Agent's debt ends at | Provider repays to the line |
| --- | --- | --- |
| Delivered | `10000 + retrieval fee + AOMI_TASK_MARGIN_MICROUSD` | the rest of the stake |
| Measured cost above the stake (`price_exceeded`) | `10000`, the preparation it gambled | stake − 10000 |
| Preparation failed or expired | `10000` | stake − 10000 |
| Spend blocked by the contract | 0 | nothing paid, nothing bought |

The host never pays Aomi before it has been paid, so it carries no fee risk; it carries gas for one refund transaction per purchase and keeps the margin only on a delivered task. Aomi is paid at list price by the host's x402 payer. Example: a 0.50 USDC transfer staked at 0.05 costs the agent 0.025 with margin 0, and 0.025 comes back to its line; the same task staked at 0.02 is not retrieved and costs the agent 0.01.

The refund goes to the line with `repay(lineId, amount)` while the line still carries that debt, which also restores the sponsor's reserve on chain; if the agent has already repaid, the provider pays the agent's address directly. `GET /refund/<digest>` shows the record and the transaction hashes. A refund that could not be sent is retried every minute; one whose outcome is unknown is never repeated blindly.

Shadow's server treats its configured price as a floor on the principal; this server sets that floor to `10000 + margin` and leaves the stake to the agent.

## Routes

`POST /task`, `GET /refund/<digest>` and the check on `POST /accept` are what this repository adds. Everything else is Shadow's server, documented in `vendor/shadow/examples/float-mainnet-provider-server/README.md`.

```json
POST /task
{ "intent": "Send 0.5 USDC to 0xB… on Arc Testnet.", "chainId": 5042002, "sender": "0xA…", "constraints": { "maxOutgoingUsdcWei": "500000000000000000" }, "tag": "optional-attempt-label" }

200
{ "requestId": "aomi-task:<sha256>", "chainId": 5042002, "provider": "0xP…", "endpoint": "…", "priceFloor": "10000",
  "pricing": { "preparationFeeMicrousd": "10000", "retrievalFeePercentOfOutflow": 3, "marginMicrousd": "0" }, "note": "Sign a SpendIntent whose principal is the most you will pay…" }
```

The request id is `aomi-task:` plus the SHA-256 of the canonical registration (keys sorted at every level, two-space indentation, `sender` lower-cased). The same body always maps to the same id, so a retry registers nothing new; a deliberate second attempt for the same intent carries a different `tag`. `constraints` are passed to the Task API as given (`maxOutgoingUsdcWei` fails the preparation if the task would move more; an optional endpoint cap `AOMI_TASK_MAX_OUTGOING_USDC_WEI` bounds it). The Task API receives the registration without `tag`.

`POST /accept` is Shadow's route. Before the body reaches Shadow's server, an intent whose `requestId` starts with `aomi-task:` must validate as a Shadow intent file, carry an `agent` equal to the registered `sender`, and a `principal` of at least `priceFloor`; otherwise `422` and nothing is signed. The stake is recorded under the intent's digest.

## Result

`/serve` returns the frozen bytes as base64. Decoded, they are one JSON document with `schema: "aomi-task-shadow/2"` and a `status`:

```json
{
  "schema": "aomi-task-shadow/2", "status": "delivered",
  "requestId": "aomi-task:…", "digest": "0x…", "stake": "50000", "charged": "25000", "refund": "25000",
  "preparationFeeMicrousd": "10000", "marginMicrousd": "0",
  "quoteId": "…", "requestHash": "…", "payloadHash": "<sha256 of the bundle bytes>", "expiresAt": 1800000000,
  "attestation": "<EdDSA JWS signed by the Task API>",
  "summary": { "interpretedTask": "…", "expectedEffects": "…", "approvals": "…", "gas": "…", "transactionSafety": "…", "outgoingUsdcWei": "500000000000000000" },
  "pricing": { "outgoing_usdc_wei": "500000000000000000", "fee_microusd": "15000", "preparation_fee_microusd": "10000" },
  "bundle": { "…": "the unsigned Task API result; calls carry to, data, value" }
}
```

`status` is `price_exceeded` (with `requiredPrice`, `pricing` and `summary`, no `bundle`) when the measured cost did not fit the stake, or `preparation_failed` / `preparation_expired` (with `error`) when Aomi could not prepare the task; `charged` and `refund` say where the stake went in every case. `resultRef` in the `DeliveryReceipt` is the Task API result URL. The Shadow `DeliveryReceipt` binds these exact bytes (`resultHash`); the Task API `attestation` binds the request, payer, price and `payloadHash` under Aomi's JWKS (`/.well-known/jwks.json`). Verify both independently; `bundle` is untrusted input until you have.

## Run

Node 22.18 or later (the Task client is TypeScript loaded with Node's type stripping), pnpm for the Shadow app.

```bash
cd shadow
npm run setup            # submodules, Shadow app dependencies, Task client dependencies
cp example.env .env      # fill in the keys and your host
curl -sS https://api-staging.aomi.dev/.well-known/jwks.json > trusted-jwks.json   # provision once, keep out of band
set -a; . ./.env; set +a
npm start
```

The server prints one JSON line with the provider address, endpoint hash and price floor when it listens. Put a TLS reverse proxy in front before exposing it; Shadow's agent tools refuse plain HTTP and redirects. Both private keys are removed from the environment after the wallets are created.

| Variable | Meaning |
| --- | --- |
| `ARC_RPC_URL`, `FLOAT_MAINNET_EXPECTED_CHAIN_ID`, `FLOAT_MANIFEST` | The Shadow deployment, as for every Shadow participant tool |
| `FLOAT_PROVIDER_PRIVATE_KEY` | This provider's EOA: signs acceptances and deliveries, receives the Shadow payment, sends the refunds (needs USDC for gas) |
| `PROVIDER_ENDPOINT`, `PROVIDER_STORE_DIR`, `PROVIDER_ADMISSION_MODE`, `PROVIDER_PUBLIC_ORIGIN`, `PORT`, `HOST` | Shadow provider server settings (`vendor/shadow/examples/float-mainnet-provider-server/README.md`) |
| `AOMI_TASK_ENDPOINT` | `https://api-staging.aomi.dev/v1/task/build` |
| `AOMI_TASK_RECIPIENT` | The merchant address every 402 challenge must name |
| `AOMI_TASK_PAYER_PRIVATE_KEY` | The x402 payer; needs a Circle Gateway deposit on the chain, funded separately |
| `AOMI_TASK_TRUSTED_JWKS_FILE` | Attestation keys, provisioned out of band |
| `AOMI_TASK_MARGIN_MICROUSD` | The host's margin on a delivered task; the price floor is `10000` plus this |
| `AOMI_TASK_MAX_OUTGOING_USDC_WEI` | Optional endpoint cap on the outflow a task may declare; unset means none |
| `AOMI_TASK_WAIT_MS` | How long one paid purchase waits for the Task API (default 10 minutes) before the digest is left for reconciliation |

Task registrations, per-request payment journals, stakes and refund records live under `PROVIDER_STORE_DIR`. The journals hold retrieval capabilities and signed payment proofs: keep the directory private and never put it in evidence.

## Test

```bash
npm test
```

The tests exercise the service at the Task client and refund boundaries (a stake is recorded for the registered sender at or above the floor; a paid digest buys once, delivers, and repays the unused stake; a cost above the stake or a failed preparation keeps only the preparation fee; a journal is resumed and never bought twice; a digest still preparing or never staked is left for reconciliation; a failed refund is retried and a landed one never repeated) and the routes (canonical ids, tags, validation, the `/accept` check and byte-for-byte replay, the refund view, pass-through). Shadow's protocol itself is covered by Shadow's own tests in `vendor/shadow`.

## Status

Engineering preview for the Shadow public testnet pilot. No live sponsored purchase has been run yet.
