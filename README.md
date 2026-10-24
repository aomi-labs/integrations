# Aomi Task API on Shadow

Sell [Aomi Task API](https://staging.aomi.dev/research/introducing-the-aomi-task-api) builds through a [Shadow](https://www.shadowbuild.xyz) sponsored credit line on Arc testnet (chain `5042002`). A sponsor funds an agent's line naming this provider; the agent signs one Shadow purchase; the Shadow contract pays this provider from the sponsor's reserve; the provider hands back a frozen, attested, unsigned transaction bundle. The agent never pays x402 and nothing here signs or broadcasts the bundle.

This repository is the glue only. The provider protocol, store and no-double-charge rules are Shadow's reference provider server (`vendor/shadow`), and the Task API purchase, fee caps, attestation check and payment journal are Aomi's Task client (`vendor/product-mono`). Both are pinned git submodules.

## How a purchase runs

| Step | Who | What |
| --- | --- | --- |
| 1 | Sponsor | `registerSponsor`, `approve`, `openLine` on `ShadowFloatPublicTestnet` naming this provider's address, the endpoint string and caps at or above `PROVIDER_PRICE` ([Shadow testnet guide](https://github.com/buildwithshadow/shadow/blob/main/docs/SELF_SERVICE_TESTNET.md)) |
| 2 | Agent | `POST /task` with the task request; receives `requestId` |
| 3 | Agent | Signs a Shadow `SpendIntent` for `PROVIDER_PRICE` to this provider and endpoint, then `POST /accept` with the intent and that `requestId` |
| 4 | Provider | Inside acceptance, buys the task from the Task API with its own x402 payer (0.01 USDC preparation, 3% of outflow at retrieval), verifies the attestation, freezes the result under the Shadow digest, then signs the `ServiceAcceptance`. A failed preparation refuses with `422` and signs nothing |
| 5 | Anyone | `executeSpend(intent, signature)`; the contract pays the provider within the line's caps or records `SpendBlocked` and pays nothing |
| 6 | Agent | `POST /serve` once the digest is paid; receives the frozen bytes and a signed `DeliveryReceipt` |
| 7 | Anyone | `repay(lineId, amount)`; the sponsor later `closeLine`s and reclaims the unused reserve |

Retrying `/accept` with the same intent and `requestId` returns the stored acceptance; retrying `/serve` for the same digest returns the stored bytes. The Task purchase is journaled per `requestId` and replayed, never bought again. The provider pays the 0.01 USDC preparation before the on-chain payment exists, so a purchase the contract later blocks costs the provider that fee.

## Routes

`POST /task` is the one route this repository adds. Everything else is Shadow's server, documented in `vendor/shadow/examples/float-mainnet-provider-server/README.md`.

```json
POST /task
{ "intent": "Simulate a no-op on Arc Testnet. Do not sign or broadcast.", "chainId": 5042002, "sender": "0x…", "constraints": { "maxOutgoingUsdcWei": "0" }, "tag": "optional-attempt-label" }

200
{ "requestId": "aomi-task:<sha256>", "chainId": 5042002, "provider": "0x…", "endpoint": "…", "price": "10000", "maxOutgoingUsdcWei": "0" }
```

The request id is `aomi-task:` plus the SHA-256 of the canonical request (keys sorted at every level, two-space indentation, sender lower-cased, `constraints.maxOutgoingUsdcWei` always present). The same request always maps to the same id, so a retry registers nothing new; a deliberate second attempt for the same intent carries a different `tag`. `constraints.maxOutgoingUsdcWei` above `AOMI_TASK_MAX_OUTGOING_USDC_WEI` is refused with `422`, because the 3% retrieval fee must fit the fixed Shadow price.

## Result

`/serve` returns the frozen bytes as base64. Decoded, they are one JSON document:

```json
{
  "schema": "aomi-task-shadow/1",
  "quoteId": "…", "requestHash": "…", "payloadHash": "<sha256 of the bundle bytes>",
  "expiresAt": 1800000000,
  "attestation": "<EdDSA JWS signed by the Task API>",
  "summary": { "interpretedTask": "…", "expectedEffects": "…", "approvals": "…", "gas": "…", "transactionSafety": "…", "outgoingUsdcWei": "0" },
  "pricing": { "outgoing_usdc_wei": "0", "fee_microusd": "0", "preparation_fee_microusd": "10000" },
  "bundle": { "…": "the unsigned Task API result; calls carry to, data, value" }
}
```

`resultRef` in the `DeliveryReceipt` is the Task API result URL. The Shadow `DeliveryReceipt` binds these exact bytes (`resultHash`); the Task API `attestation` binds the request, payer, price and `payloadHash` under Aomi's JWKS (`/.well-known/jwks.json`). Verify both independently; `bundle` is untrusted input until you have.

## Pricing

Shadow pays one fixed principal per endpoint. The Task API charges 0.01 USDC per preparation plus 3% of simulated gross outgoing USDC at retrieval (zero outflow is free). The defaults sell zero-outflow tasks only, so both sides are exactly 0.01 USDC:

| `AOMI_TASK_MAX_OUTGOING_USDC_WEI` | `AOMI_TASK_MAX_RETRIEVAL_FEE_MICROUSD` | minimum `PROVIDER_PRICE` |
| --- | --- | --- |
| `0` | `0` | `10000` (0.01 USDC) |
| `1000000000000000000` (1 USDC) | `30000` | `40000` (0.04 USDC) |

The server refuses to start when `PROVIDER_PRICE` is below `10000` plus the retrieval cap. Shadow's public testnet caps a purchase at 1 USDC.

## Run

Node 22.18 or later (the Task client is TypeScript loaded with Node's type stripping), pnpm for the Shadow app.

```bash
npm run setup            # submodules, Shadow app dependencies, Task client dependencies
cp example.env .env      # fill in the keys and your host
curl -sS https://api-staging.aomi.dev/.well-known/jwks.json > trusted-jwks.json   # provision once, keep out of band
set -a; . ./.env; set +a
npm start
```

The server prints one JSON line with the provider address, endpoint hash and price when it listens. Put a TLS reverse proxy in front before exposing it; Shadow's agent tools refuse plain HTTP and redirects. Both private keys are removed from the environment after the wallets are created.

| Variable | Meaning |
| --- | --- |
| `ARC_RPC_URL`, `FLOAT_MAINNET_EXPECTED_CHAIN_ID`, `FLOAT_MANIFEST` | The Shadow deployment, as for every Shadow participant tool |
| `FLOAT_PROVIDER_PRIVATE_KEY` | This provider's EOA: signs acceptances and deliveries, receives the Shadow payment |
| `PROVIDER_ENDPOINT`, `PROVIDER_PRICE`, `PROVIDER_STORE_DIR`, `PROVIDER_ADMISSION_MODE`, `PROVIDER_PUBLIC_ORIGIN`, `PORT`, `HOST` | Shadow provider server settings (`vendor/shadow/examples/float-mainnet-provider-server/README.md`) |
| `AOMI_TASK_ENDPOINT` | `https://api-staging.aomi.dev/v1/task/build` |
| `AOMI_TASK_RECIPIENT` | The merchant address every 402 challenge must name |
| `AOMI_TASK_PAYER_PRIVATE_KEY` | The x402 payer; needs a Circle Gateway deposit on the chain, funded separately |
| `AOMI_TASK_TRUSTED_JWKS_FILE` | Attestation keys, provisioned out of band |
| `AOMI_TASK_MAX_OUTGOING_USDC_WEI`, `AOMI_TASK_MAX_RETRIEVAL_FEE_MICROUSD`, `AOMI_TASK_WAIT_MS` | Fee envelope and preparation wait |

Task requests and per-request payment journals live under `PROVIDER_STORE_DIR/tasks`. The journals hold retrieval capabilities and signed payment proofs: keep the directory private and never put it in evidence.

## Test

```bash
npm test
```

The tests exercise the service at the Task client boundary (a completed purchase is frozen, a failed one is refused and never bought again, a retry replays the journal, an unfinished one is retryable) and the `/task` route (canonical ids, tags, validation, pass-through). Shadow's protocol itself is covered by Shadow's own tests in `vendor/shadow`.

## Status

Engineering preview for the Shadow public testnet pilot. No live sponsored purchase has been run yet.
