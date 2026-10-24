import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { REQUEST_ID_PREFIX, RESULT_SCHEMA, createAomiTaskService } from "../service.mjs";

// The service is exercised at the Task client boundary: a stub client records
// how many purchases it was asked for and returns what the real client
// returns. The Shadow server around it is Shadow's own, tested in vendor/shadow.

const ID = "a".repeat(64);
const REQUEST_ID = `${REQUEST_ID_PREFIX}${ID}`;
const BUNDLE = { actions: [{ to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0" }] };
const PREVIEW = {
  quoteId: "00000000-0000-0000-0000-000000000001",
  requestHash: "11".repeat(32),
  payloadHash: "22".repeat(32),
  expiresAt: 1_800_000_000,
  attestation: "eyJhbGciOiJFZERTQSJ9.e30.sig",
  summary: { interpretedTask: "no-op", outgoingUsdcWei: "0" },
  pricing: { outgoing_usdc_wei: "0", fee_microusd: "0", preparation_fee_microusd: "10000" },
};
const JOB = { quoteId: PREVIEW.quoteId, resultUrl: `https://api-staging.aomi.dev/v1/task/${PREVIEW.quoteId}/result` };

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

// A store with one registered task request, and a stub Task client whose
// purchase() writes the same journal the real client leaves behind.
function fixture(outcomes) {
  const storeDir = mkdtempSync(join(tmpdir(), "aomi-task-shadow-"));
  dirs.push(storeDir);
  mkdirSync(join(storeDir, "tasks"), { recursive: true });
  writeFileSync(join(storeDir, "tasks", `${ID}.request.json`), JSON.stringify({ intent: "Simulate a no-op", chainId: 5042002, sender: "0x" + "ab".repeat(20), constraints: { maxOutgoingUsdcWei: "0" } }));
  const calls = { purchase: 0, recover: 0, retrieve: 0 };
  const service = createAomiTaskService({
    storeDir,
    createClient: (journal) => ({
      async purchase() {
        calls.purchase++;
        mkdirSync(journal, { recursive: true, mode: 0o700 });
        writeFileSync(join(journal, "state.json"), JSON.stringify({ version: 2, job: JOB, preview: PREVIEW }), { mode: 0o600 });
        return outcomes.purchase;
      },
      async recover() { calls.recover++; return outcomes.recover ?? outcomes.purchase; },
      async retrieve() { calls.retrieve++; return outcomes.retrieve ?? outcomes.purchase; },
    }),
  });
  return { service, calls, storeDir };
}

describe("createAomiTaskService", () => {
  test("a completed purchase freezes the attested bundle under the request id", async () => {
    const { service, calls } = fixture({ purchase: { status: "complete", bytes: Buffer.from(JSON.stringify(BUNDLE)) } });
    const output = await service.prepare({ digest: "0x" + "01".repeat(32), requestId: REQUEST_ID });
    assert.equal(output.resultRef, JOB.resultUrl);
    const result = JSON.parse(output.result);
    assert.equal(result.schema, RESULT_SCHEMA);
    assert.deepEqual(result.bundle, BUNDLE);
    assert.equal(result.quoteId, PREVIEW.quoteId);
    assert.equal(result.payloadHash, PREVIEW.payloadHash);
    assert.equal(result.attestation, PREVIEW.attestation);
    assert.deepEqual(result.pricing, PREVIEW.pricing);
    assert.deepEqual(calls, { purchase: 1, recover: 0, retrieve: 0 });
  });

  test("a failed preparation signs nothing and is not bought again", async () => {
    const { service, calls } = fixture({ purchase: { status: "failed", error: "simulation reverted" } });
    const digest = "0x" + "02".repeat(32);
    assert.equal(await service.prepare({ digest, requestId: REQUEST_ID }), null);
    assert.equal(await service.prepare({ digest, requestId: REQUEST_ID }), null);
    assert.deepEqual(calls, { purchase: 1, recover: 1, retrieve: 0 });
  });

  test("a second prepare for the same request replays the journal instead of paying twice", async () => {
    const bytes = Buffer.from(JSON.stringify(BUNDLE));
    const { service, calls } = fixture({ purchase: { status: "complete", bytes }, recover: { status: "complete", bytes } });
    const digest = "0x" + "03".repeat(32);
    const first = await service.prepare({ digest, requestId: REQUEST_ID });
    const second = await service.prepare({ digest, requestId: REQUEST_ID });
    assert.equal(second.result, first.result);
    assert.deepEqual(calls, { purchase: 1, recover: 1, retrieve: 0 });
  });

  test("a preparation still running is retryable, not refused", async () => {
    const { service, calls } = fixture({ purchase: { status: "preparing", retryAfter: 2 }, recover: { status: "ready" }, retrieve: { status: "complete", bytes: Buffer.from(JSON.stringify(BUNDLE)) } });
    const digest = "0x" + "04".repeat(32);
    await assert.rejects(service.prepare({ digest, requestId: REQUEST_ID }), /still preparing/);
    const output = await service.prepare({ digest, requestId: REQUEST_ID });
    assert.deepEqual(JSON.parse(output.result).bundle, BUNDLE);
    assert.deepEqual(calls, { purchase: 1, recover: 1, retrieve: 1 });
  });

  test("an unknown or malformed request id is refused before any purchase", async () => {
    const { service, calls } = fixture({ purchase: { status: "complete", bytes: Buffer.from("{}") } });
    for (const requestId of ["", "report:abc", `${REQUEST_ID_PREFIX}${"b".repeat(64)}`, `${REQUEST_ID_PREFIX}${"A".repeat(64)}`, `${REQUEST_ID_PREFIX}short`]) {
      assert.equal(await service.prepare({ digest: "0x" + "05".repeat(32), requestId }), null, requestId);
    }
    assert.deepEqual(calls, { purchase: 0, recover: 0, retrieve: 0 });
  });

  test("the service itself never buys after payment", async () => {
    const { service } = fixture({ purchase: { status: "complete", bytes: Buffer.from("{}") } });
    await assert.rejects(service({ digest: "0x" + "06".repeat(32), requestId: REQUEST_ID }), /prepared before provider acceptance/);
  });
});
