import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { REQUEST_ID_PREFIX, RESULT_SCHEMA, createAomiTaskService } from "../service.mjs";

// The service is exercised at its two boundaries: a stub Task client that
// records how often it was asked to prepare, poll, recover and retrieve, and a
// stub refund that records what it was asked to send. The Shadow server around
// it is Shadow's own, tested in vendor/shadow.

const ID = "a".repeat(64);
const REQUEST_ID = `${REQUEST_ID_PREFIX}${ID}`;
const SENDER = "0x" + "ab".repeat(20);
const SPONSOR = "0x" + "5e".repeat(20);
const LINE = "0x" + "11".repeat(32);
const BUNDLE = { actions: [{ to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0" }] };
const PREVIEW = {
  quoteId: "00000000-0000-0000-0000-000000000001",
  requestHash: "11".repeat(32),
  payloadHash: "22".repeat(32),
  expiresAt: 1_800_000_000,
  attestation: "eyJhbGciOiJFZERTQSJ9.e30.sig",
  summary: { interpretedTask: "transfer", outgoingUsdcWei: "500000000000000000" },
  pricing: { outgoing_usdc_wei: "500000000000000000", fee_microusd: "15000", preparation_fee_microusd: "10000" },
};
const JOB = { quoteId: PREVIEW.quoteId, resultUrl: `https://api-staging.aomi.dev/v1/task/${PREVIEW.quoteId}/result` };
const COMPLETE = { status: "complete", bytes: Buffer.from(JSON.stringify(BUNDLE)) };
const digestOf = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(32);

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

// A store with one registered task. `outcomes` lists what each client method
// answers, in order; the last entry repeats. `refundOutcome` is what the
// refund stub answers, or an Error it throws.
function fixture(outcomes, options = {}, refundOutcome = { status: "repaid", txHashes: ["0xtx"] }) {
  const storeDir = mkdtempSync(join(tmpdir(), "aomi-task-shadow-"));
  dirs.push(storeDir);
  mkdirSync(join(storeDir, "tasks"), { recursive: true });
  writeFileSync(join(storeDir, "tasks", `${ID}.request.json`), JSON.stringify({ intent: "Send 0.5 USDC", chainId: 5042002, sender: SENDER, constraints: { maxOutgoingUsdcWei: "500000000000000000" }, tag: "t1" }));
  const calls = { prepare: 0, status: 0, recover: 0, retrieve: 0 };
  const clients = [];
  const refundCalls = [];
  const answer = (method) => {
    const list = outcomes[method] ?? [];
    return list[Math.min(calls[method] - 1, list.length - 1)];
  };
  const service = createAomiTaskService({
    storeDir,
    waitMs: 0,
    ...options,
    createClient: (journal, caps) => {
      clients.push(caps);
      return {
        async prepare(request) {
          calls.prepare++;
          clients.at(-1).request = request;
          mkdirSync(journal, { recursive: true, mode: 0o700 });
          writeFileSync(join(journal, "state.json"), JSON.stringify({ version: 2, job: JOB, preview: PREVIEW }), { mode: 0o600 });
          return answer("prepare");
        },
        async status() { calls.status++; return answer("status"); },
        async recover() { calls.recover++; return answer("recover"); },
        async retrieve() { calls.retrieve++; return answer("retrieve"); },
      };
    },
    refund: async (request) => {
      refundCalls.push(request);
      if (refundOutcome instanceof Error) throw refundOutcome;
      return refundOutcome;
    },
  });
  const stake = (digest, principal) => service.stake({ digest, requestId: REQUEST_ID, lineId: LINE, agent: SENDER, sponsor: SPONSOR, principal });
  return { service, stake, calls, clients, refundCalls, storeDir };
}

describe("stake", () => {
  test("records a stake for a registered task from its sender at or above the floor", async () => {
    const { service, stake, storeDir } = fixture({}, { marginMicrousd: 2_000n });
    assert.equal(service.floor, 12_000n);
    assert.deepEqual(stake(digestOf(1), 50_000n), []);
    assert.deepEqual(JSON.parse(readFileSync(join(storeDir, "stakes", `${digestOf(1)}.json`), "utf8")), { digest: digestOf(1), requestId: REQUEST_ID, lineId: LINE, agent: SENDER, sponsor: SPONSOR, principal: "50000" });
    // The same intent again is fine; another intent under the same digest is not.
    assert.deepEqual(stake(digestOf(1), 50_000n), []);
    assert.match(stake(digestOf(1), 60_000n).join(), /already staked/);
    assert.match(stake(digestOf(2), 11_999n).join(), /principal 11999 is below the price floor 12000/);
    assert.match(service.stake({ digest: digestOf(3), requestId: REQUEST_ID, lineId: LINE, agent: SPONSOR, sponsor: SPONSOR, principal: 50_000n }).join(), /agent .* is not the task's sender/);
    for (const requestId of ["", "report:abc", `${REQUEST_ID_PREFIX}${"b".repeat(64)}`, `${REQUEST_ID_PREFIX}${"A".repeat(64)}`]) {
      assert.match(service.stake({ digest: digestOf(4), requestId, lineId: LINE, agent: SENDER, sponsor: SPONSOR, principal: 50_000n }).join(), /not registered/, requestId);
    }
    assert.ok(!existsSync(join(storeDir, "stakes", `${digestOf(2)}.json`)));
  });
});

describe("service", () => {
  test("buys the task with the stake, delivers the attested bundle, and repays the unused stake to the line", async () => {
    const { service, stake, calls, clients, refundCalls, storeDir } = fixture({ prepare: [{ status: "ready" }], retrieve: [COMPLETE] }, { marginMicrousd: 1_000n });
    stake(digestOf(1), 50_000n);
    const output = await service({ digest: digestOf(1), requestId: REQUEST_ID });
    assert.equal(output.resultRef, JOB.resultUrl);
    const result = JSON.parse(output.result);
    assert.equal(result.schema, RESULT_SCHEMA);
    assert.equal(result.status, "delivered");
    assert.deepEqual(result.bundle, BUNDLE);
    assert.equal(result.attestation, PREVIEW.attestation);
    assert.equal(result.payloadHash, PREVIEW.payloadHash);
    assert.deepEqual(result.pricing, PREVIEW.pricing);
    // 10000 preparation + 15000 retrieval + 1000 margin charged; the rest goes back.
    assert.equal(result.stake, "50000");
    assert.equal(result.charged, "26000");
    assert.equal(result.refund, "24000");
    assert.deepEqual(refundCalls, [{ digest: digestOf(1), lineId: LINE, agent: SENDER, amount: 24_000n }]);
    assert.deepEqual(calls, { prepare: 1, status: 0, recover: 0, retrieve: 1 });
    // The Task client was capped at the budget and saw the task request only, without the tag.
    assert.equal(clients[0].maxRetrievalFeeMicrousd, 39_000n);
    assert.deepEqual(clients[0].request, { intent: "Send 0.5 USDC", chainId: 5042002, sender: SENDER, constraints: { maxOutgoingUsdcWei: "500000000000000000" } });
    const record = JSON.parse(readFileSync(join(storeDir, "refunds", `${digestOf(1)}.json`), "utf8"));
    assert.equal(record.status, "repaid");
    assert.deepEqual(record.txHashes, ["0xtx"]);
    assert.deepEqual(service.refundOf(digestOf(1)), record);
  });

  test("a task that costs more than the stake is not retrieved; the agent keeps only the preparation fee", async () => {
    const { service, stake, calls, refundCalls } = fixture({ prepare: [{ status: "ready" }] });
    stake(digestOf(2), 20_000n);
    const result = JSON.parse((await service({ digest: digestOf(2), requestId: REQUEST_ID })).result);
    assert.equal(result.status, "price_exceeded");
    assert.equal(result.requiredPrice, "25000");
    assert.equal(result.charged, "10000");
    assert.equal(result.refund, "10000");
    assert.equal(result.quoteId, PREVIEW.quoteId);
    assert.deepEqual(result.pricing, PREVIEW.pricing);
    assert.equal(result.bundle, undefined);
    assert.deepEqual(refundCalls, [{ digest: digestOf(2), lineId: LINE, agent: SENDER, amount: 10_000n }]);
    assert.deepEqual(calls, { prepare: 1, status: 0, recover: 0, retrieve: 0 });
  });

  test("a failed preparation refunds everything but the preparation fee", async () => {
    const { service, stake, refundCalls } = fixture({ prepare: [{ status: "failed", error: "simulation reverted" }] });
    stake(digestOf(3), 30_000n);
    const result = JSON.parse((await service({ digest: digestOf(3), requestId: REQUEST_ID })).result);
    assert.equal(result.status, "preparation_failed");
    assert.equal(result.error, "simulation reverted");
    assert.equal(result.charged, "10000");
    assert.equal(result.refund, "20000");
    assert.deepEqual(refundCalls, [{ digest: digestOf(3), lineId: LINE, agent: SENDER, amount: 20_000n }]);
  });

  test("a stake of exactly the cost needs no refund", async () => {
    const { service, stake, refundCalls, storeDir } = fixture({ prepare: [{ status: "ready" }], retrieve: [COMPLETE] });
    stake(digestOf(4), 25_000n);
    const result = JSON.parse((await service({ digest: digestOf(4), requestId: REQUEST_ID })).result);
    assert.equal(result.status, "delivered");
    assert.equal(result.refund, "0");
    assert.deepEqual(refundCalls, []);
    assert.ok(!existsSync(join(storeDir, "refunds", `${digestOf(4)}.json`)));
    assert.equal(service.refundOf(digestOf(4)), null);
  });

  test("polls while the Task API prepares, and resumes a journal instead of paying again", async () => {
    const { service, stake, calls } = fixture({ prepare: [{ status: "preparing", retryAfter: 1 }], status: [{ status: "ready" }], retrieve: [COMPLETE] }, { waitMs: 30_000 });
    stake(digestOf(5), 50_000n);
    assert.equal(JSON.parse((await service({ digest: digestOf(5), requestId: REQUEST_ID })).result).status, "delivered");
    assert.deepEqual(calls, { prepare: 1, status: 1, recover: 0, retrieve: 1 });
  });

  test("a second digest for the same request replays the journal rather than buying twice", async () => {
    const { service, stake, calls } = fixture({ prepare: [{ status: "ready" }], retrieve: [COMPLETE], recover: [COMPLETE] });
    stake(digestOf(6), 50_000n);
    stake(digestOf(7), 50_000n);
    const first = JSON.parse((await service({ digest: digestOf(6), requestId: REQUEST_ID })).result);
    const second = JSON.parse((await service({ digest: digestOf(7), requestId: REQUEST_ID })).result);
    assert.deepEqual(second.bundle, first.bundle);
    assert.deepEqual(calls, { prepare: 1, status: 0, recover: 1, retrieve: 1 });
  });

  test("a preparation that outlasts the wait, or an unstaked digest, is left for reconciliation rather than answered", async () => {
    const { service, stake, refundCalls } = fixture({ prepare: [{ status: "preparing", retryAfter: 1 }] });
    stake(digestOf(8), 50_000n);
    await assert.rejects(service({ digest: digestOf(8), requestId: REQUEST_ID }), /still preparing .* reconcile/);
    await assert.rejects(service({ digest: digestOf(9), requestId: REQUEST_ID }), /no stake is recorded/);
    assert.deepEqual(refundCalls, []);
  });

  test("a refund that fails to send is recorded and retried by settlePending, never sent twice once it lands", async () => {
    const failing = Object.assign(new Error("rpc down"), {});
    const { service, stake, refundCalls, storeDir } = fixture({ prepare: [{ status: "ready" }], retrieve: [COMPLETE] }, {}, failing);
    stake(digestOf(10), 50_000n);
    const result = JSON.parse((await service({ digest: digestOf(10), requestId: REQUEST_ID })).result);
    assert.equal(result.status, "delivered");
    let record = service.refundOf(digestOf(10));
    assert.equal(record.status, "failed");
    assert.equal(record.attempts, 1);
    assert.equal(record.error, "rpc down");
    // Later the chain is back: the pending refund goes out once.
    writeFileSync(join(storeDir, "refunds", `${digestOf(10)}.json`), JSON.stringify({ ...record, status: "failed" }));
    const okService = createAomiTaskService({ storeDir, createClient: () => { throw new Error("no client needed"); }, refund: async () => ({ status: "transferred", txHashes: ["0xok"] }) });
    const settled = await okService.settlePending();
    assert.equal(settled.length, 1);
    record = okService.refundOf(digestOf(10));
    assert.equal(record.status, "transferred");
    assert.equal(record.attempts, 2);
    assert.deepEqual(await okService.settlePending(), []);
    assert.equal(refundCalls.length, 1);
  });

  test("a send with an unknown outcome is not repeated blindly", async () => {
    const unknown = Object.assign(new Error("receipt lookup failed"), { status: "unknown", txHashes: ["0xmaybe"] });
    const { service, stake } = fixture({ prepare: [{ status: "ready" }], retrieve: [COMPLETE] }, {}, unknown);
    stake(digestOf(11), 50_000n);
    await service({ digest: digestOf(11), requestId: REQUEST_ID });
    const record = service.refundOf(digestOf(11));
    assert.equal(record.status, "unknown");
    assert.deepEqual(record.txHashes, ["0xmaybe"]);
    assert.deepEqual(await service.settlePending(), []);
  });
});
