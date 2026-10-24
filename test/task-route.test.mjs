import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createAomiProviderServer } from "../server.mjs";
import { REQUEST_ID_PREFIX } from "../service.mjs";

// POST /task is the only route this repository adds. Every other path reaches
// the wrapped Shadow server untouched, here a stub that echoes the path.

const PROVIDER = "0x1111111111111111111111111111111111111111";
const ENDPOINT = "https://provider.example/aomi-task/v1/build";
let server;
let storeDir;
let base;

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), "aomi-task-route-"));
  const shadowServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ shadow: request.url }));
  });
  server = createAomiProviderServer({ shadowServer, storeDir, chainId: 5042002, maxOutgoingUsdcWei: 10n ** 18n, price: 40_000n, provider: PROVIDER, endpoint: ENDPOINT });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(storeDir, { recursive: true, force: true });
});

const post = (body) => fetch(`${base}/task`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("POST /task", () => {
  test("registers the canonical request and returns a deterministic request id", async () => {
    const body = { intent: "Simulate a no-op on Arc Testnet.", chainId: 5042002, sender: "0x" + "AB".repeat(20) };
    const first = await post(body);
    assert.equal(first.status, 200);
    const answer = await first.json();
    // Canonical form: keys sorted at every level, two-space indentation (Shadow's stableStringify).
    const canonical = JSON.stringify({ chainId: 5042002, constraints: { maxOutgoingUsdcWei: "0" }, intent: body.intent, sender: "0x" + "ab".repeat(20) }, null, 2);
    assert.equal(answer.requestId, `${REQUEST_ID_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`);
    assert.deepEqual(answer, { requestId: answer.requestId, chainId: 5042002, provider: PROVIDER, endpoint: ENDPOINT, price: "40000", maxOutgoingUsdcWei: "1000000000000000000" });
    const id = answer.requestId.slice(REQUEST_ID_PREFIX.length);
    assert.equal(readFileSync(join(storeDir, "tasks", `${id}.request.json`), "utf8"), canonical);
    // The same body again, with a differently ordered object and upper-case sender, is the same registration.
    const second = await (await post({ sender: body.sender, chainId: body.chainId, intent: body.intent })).json();
    assert.equal(second.requestId, answer.requestId);
  });

  test("a tag separates deliberate new attempts for the same intent", async () => {
    const body = { intent: "Simulate a no-op on Arc Testnet.", chainId: 5042002, sender: "0x" + "ab".repeat(20) };
    const plain = await (await post(body)).json();
    const tagged = await (await post({ ...body, tag: "attempt-2" })).json();
    assert.notEqual(tagged.requestId, plain.requestId);
    assert.equal((await post({ ...body, tag: "bad tag!" })).status, 422);
  });

  test("refuses the wrong chain, a bad sender, and outflow above the fixed-price cap", async () => {
    const ok = { intent: "x", chainId: 5042002, sender: "0x" + "ab".repeat(20) };
    for (const [body, pattern] of [
      [{ ...ok, chainId: 5042 }, /chainId must be 5042002/],
      [{ ...ok, sender: "nope" }, /sender must be a 0x address/],
      [{ ...ok, constraints: { maxOutgoingUsdcWei: "1000000000000000001" } }, /must not exceed 1000000000000000000/],
      [{ ...ok, constraints: { maxOutgoingUsdcWei: 5 } }, /decimal string/],
      [{ ...ok, intent: "" }, /intent must be/],
      ["[]", /not a JSON object/],
    ]) {
      const response = await post(body);
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.match((await response.json()).error, pattern);
    }
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await fetch(`${base}/task`)).status, 405);
    assert.equal((await post({ ...ok, intent: "y".repeat(20_000) })).status, 413);
  });

  test("keeps an explicit outflow cap inside the limit and lower-cases the sender", async () => {
    const answer = await (await post({ intent: "Transfer 0.5 USDC", chainId: 5042002, sender: "0x" + "CD".repeat(20), constraints: { maxOutgoingUsdcWei: "500000000000000000", maxGasUnits: 300000 } })).json();
    const id = answer.requestId.slice(REQUEST_ID_PREFIX.length);
    assert.deepEqual(JSON.parse(readFileSync(join(storeDir, "tasks", `${id}.request.json`), "utf8")), {
      chainId: 5042002, constraints: { maxGasUnits: 300000, maxOutgoingUsdcWei: "500000000000000000" }, intent: "Transfer 0.5 USDC", sender: "0x" + "cd".repeat(20),
    });
  });

  test("every other path reaches the Shadow server", async () => {
    for (const path of ["/accept", "/serve", "/status/0xabc", "/tasks"]) {
      const response = await fetch(`${base}${path}`, { method: "POST" });
      assert.deepEqual(await response.json(), { shadow: path });
    }
  });
});
