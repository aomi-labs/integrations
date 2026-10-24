// Shadow provider server selling Aomi Task API builds.
//
// Runs Shadow's reference provider server (vendor/shadow) with the Aomi task
// service and one extra route, POST /task, where the agent registers the task
// request it is about to pay for and receives the request id to put in its
// signed intent. Everything else (/accept, /serve, /status, the store, the
// no-double-charge rules) is Shadow's server, unchanged.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { createProviderServer } from "./vendor/shadow/examples/float-mainnet-provider-server/server.mjs";
import { parseUint } from "./vendor/shadow/app/scripts/float-mainnet-cli.mjs";
import { connectCandidate, endpointHashFrom, readDeployment, walletFromEnv } from "./vendor/shadow/app/scripts/float-mainnet-config.mjs";
import { configureProviderAdmission } from "./vendor/shadow/app/scripts/float-mainnet-provider-monitor-guard.mjs";
import { errorMessage, isEntrypoint, stableStringify } from "./vendor/shadow/app/scripts/float-mainnet-preflight.mjs";
import { TaskClient } from "./vendor/product-mono/examples/task-api/client.ts";
import { REQUEST_ID_PREFIX, createAomiTaskService } from "./service.mjs";

const PROVIDER_KEY = "FLOAT_PROVIDER_PRIVATE_KEY";
const PAYER_KEY = "AOMI_TASK_PAYER_PRIVATE_KEY";
const MAX_BODY_BYTES = 16_384;

// Wraps a Shadow provider server with POST /task. The task request is stored
// under storeDir/tasks/<sha256 of its canonical JSON>.request.json, and that
// hash, prefixed, is the request id the agent sends to /accept. The same body
// always maps to the same id, so a retry registers nothing new; a deliberate
// new attempt for the same intent carries a different `tag`.
export function createAomiProviderServer({ shadowServer, storeDir, chainId, maxOutgoingUsdcWei, price, provider, endpoint }) {
  const tasks = join(storeDir, "tasks");
  mkdirSync(tasks, { recursive: true });
  const shadow = shadowServer.listeners("request")[0];
  return createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, async (request, response) => {
    if (request.url !== "/task") return shadow(request, response);
    let status = 200;
    let body;
    try {
      if (request.method !== "POST") throw Object.assign(new Error("POST /task"), { status: 405 });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error(`the request body exceeds ${MAX_BODY_BYTES} bytes`), { status: 413 });
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw Object.assign(new Error("the request body is not JSON"), { status: 400 });
      }
      const problems = [];
      if (!input || typeof input !== "object" || Array.isArray(input)) problems.push("the body is not a JSON object");
      else {
        if (typeof input.intent !== "string" || input.intent === "" || input.intent.length > 8000) problems.push("intent must be a string of 1 to 8000 characters");
        if (input.chainId !== chainId) problems.push(`chainId must be ${chainId}`);
        if (typeof input.sender !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.sender)) problems.push("sender must be a 0x address");
        if (input.tag !== undefined && (typeof input.tag !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.tag))) problems.push("tag must match [A-Za-z0-9_-]{1,64}");
        const outgoing = input.constraints?.maxOutgoingUsdcWei;
        if (outgoing !== undefined && outgoing !== null && (typeof outgoing !== "string" || !/^[0-9]+$/.test(outgoing))) problems.push("constraints.maxOutgoingUsdcWei must be a decimal string");
        else if (outgoing !== undefined && outgoing !== null && BigInt(outgoing) > maxOutgoingUsdcWei) problems.push(`constraints.maxOutgoingUsdcWei must not exceed ${maxOutgoingUsdcWei} for this endpoint's fixed price`);
      }
      if (problems.length) throw Object.assign(new Error(problems.join("; ")), { status: 422 });

      // The stored request is exactly what the Task API will be asked for. The
      // outflow cap is always present, so the 3% retrieval fee stays inside the
      // fixed Shadow price; the tag only separates attempts.
      const stored = {
        intent: input.intent,
        chainId,
        sender: input.sender.toLowerCase(),
        constraints: { ...(input.constraints ?? {}), maxOutgoingUsdcWei: input.constraints?.maxOutgoingUsdcWei ?? "0" },
        ...(input.tag === undefined ? {} : { tag: input.tag }),
      };
      const canonical = stableStringify(stored);
      const id = createHash("sha256").update(canonical).digest("hex");
      const file = join(tasks, `${id}.request.json`);
      if (!existsSync(file)) {
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, canonical, { mode: 0o600 });
        renameSync(temp, file);
      } else if (readFileSync(file, "utf8") !== canonical) {
        throw Object.assign(new Error(`request id collision for ${id}; the provider has to repair its store`), { status: 500 });
      }
      body = { requestId: `${REQUEST_ID_PREFIX}${id}`, chainId, provider, endpoint, price: price.toString(), maxOutgoingUsdcWei: maxOutgoingUsdcWei.toString() };
    } catch (error) {
      status = error.status ?? 500;
      body = { error: status === 500 ? errorMessage(error) : error.message };
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(stableStringify(body));
  });
}

async function main() {
  const env = process.env;
  const endpoint = env.PROVIDER_ENDPOINT;
  if (!endpoint) throw new Error("PROVIDER_ENDPOINT is required: the exact endpoint string the sponsor approved for this provider");
  const endpointHash = endpointHashFrom({ endpoint });
  const price = parseUint("PROVIDER_PRICE", env.PROVIDER_PRICE?.trim(), 256, Error);
  const storeDir = env.PROVIDER_STORE_DIR?.trim();
  if (!storeDir) throw new Error("PROVIDER_STORE_DIR is required");
  const port = env.PORT?.trim() || "8080";
  if (!/^\d+$/.test(port) || Number(port) > 65_535) throw new Error("PORT must be a TCP port number");
  const host = env.HOST?.trim() || "127.0.0.1";

  const taskEndpoint = env.AOMI_TASK_ENDPOINT?.trim() || "https://api-staging.aomi.dev/v1/task/build";
  const recipient = env.AOMI_TASK_RECIPIENT?.trim();
  if (!recipient) throw new Error("AOMI_TASK_RECIPIENT is required: the Task API merchant address the payer expects in every 402 challenge");
  const jwksFile = env.AOMI_TASK_TRUSTED_JWKS_FILE?.trim();
  if (!jwksFile) throw new Error("AOMI_TASK_TRUSTED_JWKS_FILE is required: attestation keys provisioned out of band, never from a quote");
  const trustedJwks = JSON.parse(readFileSync(jwksFile, "utf8"));
  const maxRetrievalFee = parseUint("AOMI_TASK_MAX_RETRIEVAL_FEE_MICROUSD", env.AOMI_TASK_MAX_RETRIEVAL_FEE_MICROUSD?.trim() || "0", 64, Error);
  const maxOutgoingUsdcWei = parseUint("AOMI_TASK_MAX_OUTGOING_USDC_WEI", env.AOMI_TASK_MAX_OUTGOING_USDC_WEI?.trim() || "0", 256, Error);
  // Preparation is a fixed 0.01 USDC; retrieval is 3% of outflow. The Shadow
  // price must cover both, or the provider sells at a loss.
  if (10_000n + maxRetrievalFee > price) {
    throw new Error(`PROVIDER_PRICE ${price} is below preparation 10000 plus AOMI_TASK_MAX_RETRIEVAL_FEE_MICROUSD ${maxRetrievalFee}`);
  }

  const connection = await connectCandidate(readDeployment(env, { manifest: env.FLOAT_MANIFEST?.trim() }));
  const admissionGuard = configureProviderAdmission({
    mode: env.PROVIDER_ADMISSION_MODE, recoveryOnly: false, connection, manifestPath: env.FLOAT_MANIFEST?.trim(),
    baselinePath: env.PROVIDER_MONITOR_BASELINE, stateDir: env.PROVIDER_MONITOR_STATE_DIR,
  });
  const { account } = walletFromEnv(connection, PROVIDER_KEY);
  const payer = walletFromEnv(connection, PAYER_KEY);
  delete env[PROVIDER_KEY];
  delete env[PAYER_KEY];
  const code = await connection.client.getCode({ address: account.address });
  if (code && code !== "0x") throw new Error(`${account.address} has code; this server signs receipts with an EOA only`);

  const service = createAomiTaskService({
    storeDir,
    createClient: (stateDirectory) => new TaskClient({
      endpoint: taskEndpoint,
      payer: payer.account.address,
      recipient,
      maxPreparationFeeMicrousd: 10_000n,
      maxRetrievalFeeMicrousd: maxRetrievalFee,
      maxTotalFeeMicrousd: 10_000n + maxRetrievalFee,
      trustedJwks,
      stateDirectory,
      signTypedData: (data) => payer.wallet.signTypedData({ ...data, account: payer.account }),
      waitMs: Number(env.AOMI_TASK_WAIT_MS?.trim() || "90000"),
    }),
  });
  const shadowServer = createProviderServer({
    connection, account, endpointHash, price, storeDir, service, admissionGuard,
    witnessDir: env.PROVIDER_WITNESS_DIR?.trim() || null,
    publicOrigin: env.PROVIDER_PUBLIC_ORIGIN || null,
    trustLoopbackProxy: env.PROVIDER_TRUST_LOOPBACK_PROXY === "true",
  });
  const server = createAomiProviderServer({ shadowServer, storeDir, chainId: Number(connection.chainId), maxOutgoingUsdcWei, price, provider: account.address, endpoint });
  server.maxConnections = shadowServer.maxConnections;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(JSON.stringify({
    listening: `http://${host}:${server.address().port}`,
    provider: account.address,
    payer: payer.account.address,
    float: connection.address,
    chainId: connection.chainId.toString(),
    endpoint,
    endpointHash,
    price: price.toString(),
    taskEndpoint,
    maxOutgoingUsdcWei: maxOutgoingUsdcWei.toString(),
    store: storeDir,
  }));
}

if (isEntrypoint(import.meta)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: errorMessage(error) }));
    process.exitCode = 1;
  });
}
