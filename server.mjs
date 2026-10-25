// Shadow provider server selling Aomi Task API builds against the agent's stake.
//
// Runs Shadow's reference provider server (vendor/shadow) with the Aomi task
// service and one extra route, POST /task, where the agent registers the task
// it is about to pay for and receives the request id and the price floor. The
// agent then signs a Shadow intent for whatever it is willing to owe (its
// stake); POST /accept is checked against the registration before it reaches
// Shadow's server. After payment the service buys the task with the stake and
// repays the difference to the agent's line; GET /refund/<digest> shows that
// settlement. Everything else (/accept itself, /serve, /status, the store, the
// no-double-charge rules) is Shadow's server, unchanged.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createProviderServer } from "./vendor/shadow/examples/float-mainnet-provider-server/server.mjs";
import { parseUint, readLine, runCalls, stateName, usdcFunding } from "./vendor/shadow/app/scripts/float-mainnet-cli.mjs";
import { connectCandidate, endpointHashFrom, floatAbi, readDeployment, walletFromEnv } from "./vendor/shadow/app/scripts/float-mainnet-config.mjs";
import { validateIntentFile } from "./vendor/shadow/app/scripts/float-mainnet-intent.mjs";
import { configureProviderAdmission } from "./vendor/shadow/app/scripts/float-mainnet-provider-monitor-guard.mjs";
import { errorMessage, isEntrypoint, stableStringify } from "./vendor/shadow/app/scripts/float-mainnet-preflight.mjs";
import { TaskClient } from "./vendor/product-mono/examples/task-api/client.ts";
import { PREPARATION_FEE_MICROUSD, REQUEST_ID_PREFIX, createAomiTaskService } from "./service.mjs";

const PROVIDER_KEY = "FLOAT_PROVIDER_PRIVATE_KEY";
const PAYER_KEY = "AOMI_TASK_PAYER_PRIVATE_KEY";
const MAX_BODY_BYTES = 16_384;
const ERC20_TRANSFER_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }];

// Wraps a Shadow provider server with POST /task, GET /refund/<digest> and a
// check on POST /accept. The task registration is stored under
// storeDir/tasks/<sha256 of its canonical JSON>.request.json, and that hash,
// prefixed, is the request id the agent sends to /accept. The same body always
// maps to the same id, so a retry registers nothing new; a deliberate new
// attempt for the same intent carries a different `tag`. checkIntent(file)
// validates a Shadow intent file and returns { digest, struct }.
export function createAomiProviderServer({ shadowServer, storeDir, chainId, maxOutgoingUsdcWei = null, provider, endpoint, service, checkIntent }) {
  const tasks = join(storeDir, "tasks");
  mkdirSync(tasks, { recursive: true, mode: 0o700 });
  const shadow = shadowServer.listeners("request")[0];
  const fail = (message, status) => Object.assign(new Error(message), { status });
  const readJson = async (request) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw fail(`the request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    try {
      return { raw, input: JSON.parse(raw.toString("utf8")) };
    } catch {
      throw fail("the request body is not JSON", 400);
    }
  };

  return createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, async (request, response) => {
    const refund = request.url.match(/^\/refund\/(0x[0-9a-fA-F]{64})$/);
    if (request.url !== "/task" && refund === null && !(request.url === "/accept" && request.method === "POST")) return shadow(request, response);
    let status = 200;
    let body;
    try {
      if (refund !== null) {
        if (request.method !== "GET") throw fail("GET /refund/<digest>", 405);
        body = service.refundOf(refund[1]);
        if (body === null) throw fail(`no refund is recorded for digest ${refund[1]}`, 404);
      } else if (request.url === "/accept") {
        // Shadow's server checks everything about the intent except what only
        // this provider knows: that the request is registered to this agent
        // and that the stake reaches the floor. Refuse here, record the stake,
        // then replay the body to Shadow's handler untouched.
        const { raw, input } = await readJson(request);
        if (typeof input?.requestId === "string" && input.requestId.startsWith(REQUEST_ID_PREFIX)) {
          let checked;
          try {
            checked = checkIntent(input.intent);
          } catch (error) {
            throw fail(errorMessage(error), 422);
          }
          const { lineId, agent, sponsor, principal } = checked.struct;
          const problems = service.stake({ digest: checked.digest, requestId: input.requestId, lineId, agent, sponsor, principal });
          if (problems.length) throw fail(problems.join("; "), 422);
        }
        const replay = Object.assign(Readable.from([raw]), {
          headers: request.headers, method: request.method, url: request.url, httpVersion: request.httpVersion, socket: request.socket, aborted: false,
        });
        return shadow(replay, response);
      } else {
        if (request.method !== "POST") throw fail("POST /task", 405);
        const { input } = await readJson(request);
        const problems = [];
        if (!input || typeof input !== "object" || Array.isArray(input)) problems.push("the body is not a JSON object");
        else {
          if (typeof input.intent !== "string" || input.intent === "" || input.intent.length > 8000) problems.push("intent must be a string of 1 to 8000 characters");
          if (input.chainId !== chainId) problems.push(`chainId must be ${chainId}`);
          if (typeof input.sender !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.sender)) problems.push("sender must be a 0x address");
          if (input.tag !== undefined && (typeof input.tag !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.tag))) problems.push("tag must match [A-Za-z0-9_-]{1,64}");
          const outgoing = input.constraints?.maxOutgoingUsdcWei;
          if (outgoing !== undefined && outgoing !== null && (typeof outgoing !== "string" || !/^[0-9]+$/.test(outgoing))) problems.push("constraints.maxOutgoingUsdcWei must be a decimal string");
          else if (outgoing !== undefined && outgoing !== null && maxOutgoingUsdcWei !== null && BigInt(outgoing) > maxOutgoingUsdcWei) problems.push(`constraints.maxOutgoingUsdcWei must not exceed ${maxOutgoingUsdcWei} on this endpoint`);
        }
        if (problems.length) throw fail(problems.join("; "), 422);

        // The stored registration is the Task API request plus the tag that
        // separates attempts; the service strips the tag before it talks to
        // the Task API.
        const stored = {
          intent: input.intent,
          chainId,
          sender: input.sender.toLowerCase(),
          ...(input.constraints === undefined || input.constraints === null ? {} : { constraints: input.constraints }),
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
          throw fail(`request id collision for ${id}; the provider has to repair its store`, 500);
        }
        body = {
          requestId: `${REQUEST_ID_PREFIX}${id}`,
          chainId,
          provider,
          endpoint,
          priceFloor: service.floor.toString(),
          pricing: { preparationFeeMicrousd: PREPARATION_FEE_MICROUSD.toString(), retrievalFeePercentOfOutflow: 3, marginMicrousd: (service.floor - PREPARATION_FEE_MICROUSD).toString() },
          ...(maxOutgoingUsdcWei === null ? {} : { maxOutgoingUsdcWei: maxOutgoingUsdcWei.toString() }),
          note: "Sign a SpendIntent whose principal is the most you will pay for this task, at least priceFloor. The provider buys the task with it after payment and repays the unused part to your line; a task that costs more than your principal, or fails to prepare, keeps only the preparation fee.",
        };
      }
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
  const maxOutgoingUsdcWei = env.AOMI_TASK_MAX_OUTGOING_USDC_WEI?.trim() ? parseUint("AOMI_TASK_MAX_OUTGOING_USDC_WEI", env.AOMI_TASK_MAX_OUTGOING_USDC_WEI.trim(), 256, Error) : null;
  const marginMicrousd = parseUint("AOMI_TASK_MARGIN_MICROUSD", env.AOMI_TASK_MARGIN_MICROUSD?.trim() || "0", 64, Error);
  const waitMs = Number(env.AOMI_TASK_WAIT_MS?.trim() || "600000");

  const connection = await connectCandidate(readDeployment(env, { manifest: env.FLOAT_MANIFEST?.trim() }));
  const admissionGuard = configureProviderAdmission({
    mode: env.PROVIDER_ADMISSION_MODE, recoveryOnly: false, connection, manifestPath: env.FLOAT_MANIFEST?.trim(),
    baselinePath: env.PROVIDER_MONITOR_BASELINE, stateDir: env.PROVIDER_MONITOR_STATE_DIR,
  });
  const { account, wallet } = walletFromEnv(connection, PROVIDER_KEY);
  const payer = walletFromEnv(connection, PAYER_KEY);
  delete env[PROVIDER_KEY];
  delete env[PAYER_KEY];
  const code = await connection.client.getCode({ address: account.address });
  if (code && code !== "0x") throw new Error(`${account.address} has code; this server signs receipts with an EOA only`);
  const signer = { mode: "execute", address: account.address, account, wallet };

  const service = createAomiTaskService({
    storeDir,
    marginMicrousd,
    waitMs,
    createClient: (stateDirectory, { maxRetrievalFeeMicrousd }) => new TaskClient({
      endpoint: taskEndpoint,
      payer: payer.account.address,
      recipient,
      maxPreparationFeeMicrousd: PREPARATION_FEE_MICROUSD,
      maxRetrievalFeeMicrousd,
      maxTotalFeeMicrousd: PREPARATION_FEE_MICROUSD + maxRetrievalFeeMicrousd,
      trustedJwks,
      stateDirectory,
      signTypedData: (data) => payer.wallet.signTypedData({ ...data, account: payer.account }),
      waitMs,
    }),
    // The refund goes back to the agent's line when that line still carries
    // the debt, so the agent's debt and the sponsor's reserve are corrected on
    // chain; if the agent has already repaid, the agent is paid directly.
    refund: async ({ lineId, agent, amount }) => {
      const line = await readLine(connection, lineId);
      const state = stateName(line);
      const funding = await usdcFunding(connection, account.address, amount);
      if (funding.balance < amount) throw new Error(`provider USDC balance ${funding.balance} is below the refund ${amount}`);
      const toLine = (state === "DRAWN" || state === "DEFAULTED") && line.principalOutstanding >= amount;
      const calls = toLine
        ? [funding.approval, { address: connection.address, abi: floatAbi, functionName: "repay", args: [lineId, amount] }].filter(Boolean)
        : [{ address: funding.usdc, abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [agent, amount] }];
      const sent = await runCalls(connection, signer, calls);
      return { status: toLine ? "repaid" : "transferred", txHashes: sent.txHashes };
    },
  });
  // Shadow's server treats its price as a floor on the principal; the stake
  // above it is the agent's choice.
  const shadowServer = createProviderServer({
    connection, account, endpointHash, price: service.floor, storeDir, service, admissionGuard,
    witnessDir: env.PROVIDER_WITNESS_DIR?.trim() || null,
    publicOrigin: env.PROVIDER_PUBLIC_ORIGIN || null,
    trustLoopbackProxy: env.PROVIDER_TRUST_LOOPBACK_PROXY === "true",
  });
  const server = createAomiProviderServer({
    shadowServer, storeDir, chainId: Number(connection.chainId), maxOutgoingUsdcWei, provider: account.address, endpoint, service,
    checkIntent: (file) => validateIntentFile(file, connection),
  });
  server.maxConnections = shadowServer.maxConnections;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Refunds that failed to send (RPC down, gas short) are retried every minute.
  setInterval(() => service.settlePending().catch(() => {}), 60_000).unref();
  console.log(JSON.stringify({
    listening: `http://${host}:${server.address().port}`,
    provider: account.address,
    payer: payer.account.address,
    float: connection.address,
    chainId: connection.chainId.toString(),
    endpoint,
    endpointHash,
    priceFloor: service.floor.toString(),
    marginMicrousd: marginMicrousd.toString(),
    taskEndpoint,
    maxOutgoingUsdcWei: maxOutgoingUsdcWei === null ? null : maxOutgoingUsdcWei.toString(),
    store: storeDir,
  }));
}

if (isEntrypoint(import.meta)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: errorMessage(error) }));
    process.exitCode = 1;
  });
}
