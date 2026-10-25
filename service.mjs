// Aomi Task API as a Shadow provider service where the agent stakes the price.
//
// Shadow pays one principal per purchase, but the Task API fee depends on the
// task (0.01 USDC preparation plus 3% of what the simulated task moves). The
// agent therefore names its own stake: it signs a Shadow intent for whatever it
// is willing to owe for this task, at least the price floor. The provider
// accepts at once and buys nothing. After the contract has paid the stake,
// Shadow's reference provider server (vendor/shadow/examples/float-mainnet-
// provider-server/server.mjs) calls `service({ digest, requestId })` once per
// digest, and only then does this service buy the task from Aomi, with the
// agent's money. Whatever the stake exceeds the actual cost is repaid to the
// agent's line (`refund`), so the agent's debt ends at exactly what Aomi
// charged, or at the 0.01 preparation when the task cannot be sold for the
// stake: that 0.01 is the agent's gamble.
//
// One Task purchase per digest: Shadow runs the service at most once per
// digest, the Task client keeps a private journal per request id and replays
// it (`recover`) instead of paying again, and every refund is recorded before
// it is sent and never sent twice.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REQUEST_ID_PREFIX = "aomi-task:";
export const RESULT_SCHEMA = "aomi-task-shadow/2";
export const PREPARATION_FEE_MICROUSD = 10_000n;

// createClient(journalDirectory, { maxRetrievalFeeMicrousd }) returns a
// TaskClient (vendor/product-mono/examples/task-api/client.ts) or anything with
// the same prepare / status / recover / retrieve methods. refund({ digest,
// lineId, agent, amount }) moves `amount` micro-USDC back to the agent, by
// repaying its line or paying the agent directly, and returns { status,
// txHashes }. storeDir is the provider server's PROVIDER_STORE_DIR; requests,
// journals, stakes and refunds live under it. marginMicrousd is the host's
// margin on a delivered task; waitMs bounds how long one service run waits for
// the Task API.
export function createAomiTaskService({ storeDir, createClient, refund, marginMicrousd = 0n, waitMs = 600_000 }) {
  const tasks = join(storeDir, "tasks");
  const stakes = join(storeDir, "stakes");
  const refunds = join(storeDir, "refunds");
  for (const dir of [tasks, stakes, refunds]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const floor = PREPARATION_FEE_MICROUSD + marginMicrousd;

  const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  const persist = (file, value) => {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, file);
  };
  const locate = (requestId) => {
    if (typeof requestId !== "string" || !requestId.startsWith(REQUEST_ID_PREFIX)) return null;
    const id = requestId.slice(REQUEST_ID_PREFIX.length);
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    const registration = readJson(join(tasks, `${id}.request.json`));
    return registration === null ? null : { id, registration, journal: join(tasks, id) };
  };
  const digestFile = (dir, digest) => join(dir, `${String(digest).toLowerCase()}.json`);

  // The checks on a Shadow intent that Shadow's server cannot make, run at
  // /accept before the intent reaches it: the request must be registered, the
  // intent's agent must be the task's sender, and the stake must reach the
  // floor. A passing intent is recorded under its digest so the service knows
  // the stake and the line once the contract has paid. Returns the problems;
  // empty means admit.
  service.stake = ({ digest, requestId, lineId, agent, sponsor, principal }) => {
    const found = locate(requestId);
    if (found === null) return [`request id ${JSON.stringify(requestId)} is not registered; POST /task first`];
    const problems = [];
    if (typeof agent !== "string" || agent.toLowerCase() !== found.registration.sender) problems.push(`the intent's agent ${agent} is not the task's sender ${found.registration.sender}`);
    if (BigInt(principal) < floor) problems.push(`the intent's principal ${principal} is below the price floor ${floor}; the principal is the most this task may cost you`);
    const record = { digest: String(digest).toLowerCase(), requestId, lineId: String(lineId).toLowerCase(), agent: String(agent).toLowerCase(), sponsor: String(sponsor).toLowerCase(), principal: String(principal) };
    const stored = readJson(digestFile(stakes, digest));
    if (stored !== null && JSON.stringify(stored) !== JSON.stringify(record)) problems.push(`digest ${record.digest} is already staked for another intent or request`);
    if (problems.length === 0 && stored === null) persist(digestFile(stakes, digest), record);
    return problems;
  };

  // Called by Shadow's server once per paid digest. Buys the task with the
  // staked money, freezes what the agent gets, and records the refund.
  async function service({ digest, requestId }) {
    const stake = readJson(digestFile(stakes, digest));
    if (stake === null || stake.requestId !== requestId) {
      throw new Error(`digest ${digest} was paid but no stake is recorded for request ${requestId}; reconcile the store before serving`);
    }
    const found = locate(requestId);
    if (found === null) throw new Error(`request ${requestId} is missing from the store; reconcile before serving`);
    const principal = BigInt(stake.principal);
    const budget = principal - floor;
    const { sponsor, tag, ...request } = found.registration;
    const client = createClient(found.journal, { maxRetrievalFeeMicrousd: budget });
    let outcome = existsSync(join(found.journal, "state.json")) ? await client.recover() : await client.prepare(request);
    const deadline = Date.now() + waitMs;
    while (outcome.status === "preparing" && Date.now() < deadline) {
      const delay = Math.max(1000, Math.min(10_000, (outcome.retryAfter ?? 2) * 1000));
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
      outcome = await client.status();
    }
    if (outcome.status === "preparing") throw new Error(`Aomi task ${found.id} is still preparing after ${waitMs} ms; reconcile digest ${digest} before serving`);

    const state = readJson(join(found.journal, "state.json"));
    const preview = state?.preview ?? null;
    const base = { schema: RESULT_SCHEMA, requestId, digest: stake.digest, stake: stake.principal, preparationFeeMicrousd: PREPARATION_FEE_MICROUSD.toString(), marginMicrousd: marginMicrousd.toString() };
    let result;
    let charged;
    if (outcome.status === "ready") {
      const actual = PREPARATION_FEE_MICROUSD + BigInt(preview.pricing.fee_microusd) + marginMicrousd;
      if (actual > principal) {
        // The stake does not cover the task: nothing is retrieved, the agent
        // keeps nothing but the preparation it gambled, and sees what it would
        // have cost.
        charged = PREPARATION_FEE_MICROUSD;
        result = { ...base, status: "price_exceeded", requiredPrice: actual.toString(), quoteId: preview.quoteId, expiresAt: preview.expiresAt, pricing: preview.pricing, summary: preview.summary };
      } else {
        outcome = await client.retrieve();
      }
    }
    if (outcome.status === "failed" || outcome.status === "expired") {
      charged = PREPARATION_FEE_MICROUSD;
      result = { ...base, status: `preparation_${outcome.status}`, error: outcome.error ?? null, quoteId: preview?.quoteId ?? state?.job?.quoteId ?? null };
    } else if (outcome.status === "complete") {
      const { quoteId, requestHash, payloadHash, expiresAt, attestation, summary, pricing } = preview;
      charged = PREPARATION_FEE_MICROUSD + BigInt(pricing.fee_microusd) + marginMicrousd;
      result = { ...base, status: "delivered", quoteId, requestHash, payloadHash, expiresAt, attestation, summary, pricing, bundle: JSON.parse(outcome.bytes.toString("utf8")) };
    } else if (result === undefined) {
      throw new Error(`Aomi task ${found.id} ended in state ${outcome.status}; reconcile digest ${digest} before serving`);
    }
    result.charged = charged.toString();
    result.refund = (principal - charged).toString();

    // The refund is recorded before the result is handed to Shadow, so a crash
    // between the two still leaves the debt to settle on file.
    if (principal > charged && readJson(digestFile(refunds, digest)) === null) {
      persist(digestFile(refunds, digest), { digest: stake.digest, requestId, lineId: stake.lineId, agent: stake.agent, amount: result.refund, status: "pending", attempts: 0 });
    }
    await service.settle(digest);
    return { result: `${JSON.stringify(result)}\n`, resultRef: state?.job?.resultUrl ?? undefined };
  }

  // Sends one recorded refund that has not gone out yet. Never throws: a
  // failed send is recorded and retried by settlePending.
  service.settle = async (digest) => {
    const file = digestFile(refunds, digest);
    const record = readJson(file);
    if (record === null || record.status === "repaid" || record.status === "transferred" || record.status === "sending") return record;
    persist(file, { ...record, status: "sending", attempts: record.attempts + 1 });
    try {
      const sent = await refund({ digest: record.digest, lineId: record.lineId, agent: record.agent, amount: BigInt(record.amount) });
      persist(file, { ...record, attempts: record.attempts + 1, status: sent.status, txHashes: sent.txHashes, settledAt: Math.floor(Date.now() / 1000), error: undefined });
    } catch (error) {
      // A send whose outcome is unknown must not be repeated blindly.
      const unknown = error.status === "unknown" || error.status === "sent";
      persist(file, { ...record, attempts: record.attempts + 1, status: unknown ? "unknown" : "failed", txHashes: error.txHashes, error: error.message });
    }
    return readJson(file);
  };

  service.settlePending = async () => {
    const settled = [];
    for (const name of readdirSync(refunds)) {
      if (!name.endsWith(".json")) continue;
      const record = readJson(join(refunds, name));
      if (record?.status === "pending" || record?.status === "failed") settled.push(await service.settle(record.digest));
    }
    return settled;
  };

  service.refundOf = (digest) => (/^0x[0-9a-fA-F]{64}$/.test(String(digest)) ? readJson(digestFile(refunds, digest)) : null);
  service.floor = floor;

  return service;
}
