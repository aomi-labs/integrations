import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { createAomiProviderServer } from "../server.mjs";
import { REQUEST_ID_PREFIX } from "../service.mjs";

// POST /task, GET /refund/<digest> and the check on POST /accept are what this
// repository adds. Every other path reaches the wrapped Shadow server
// untouched, here a stub that echoes the path and the body it was handed. The
// service and the intent check are stubs too: the real ones are tested in
// service.test.mjs and in vendor/shadow.

const PROVIDER = "0x1111111111111111111111111111111111111111";
const ENDPOINT = "https://provider.example/aomi-task/v1/build";
const SENDER = "0x" + "ab".repeat(20);
const SPONSOR = "0x" + "5e".repeat(20);
const LINE = "0x" + "11".repeat(32);
const DIGEST = "0x" + "d1".repeat(32);
const ONE_USDC = 10n ** 18n;
let server;
let storeDir;
let base;
let staked;
let refunds;

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), "aomi-task-route-"));
  const shadowServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ shadow: request.url, method: request.method, body: Buffer.concat(chunks).toString("utf8"), remote: request.socket.remoteAddress }));
  });
  const service = {
    floor: 12_000n,
    stake: (intent) => { staked.push(intent); return BigInt(intent.principal) >= 12_000n ? [] : [`the intent's principal ${intent.principal} is below the price floor 12000`]; },
    refundOf: (digest) => refunds[digest] ?? null,
  };
  server = createAomiProviderServer({
    shadowServer, storeDir, chainId: 5042002, maxOutgoingUsdcWei: ONE_USDC, provider: PROVIDER, endpoint: ENDPOINT, service,
    // The intent check stands in for Shadow's validateIntentFile: the stub
    // intent file carries its digest and message directly.
    checkIntent: (file) => {
      if (file?.kind !== "float-mainnet-intent") throw new Error("not a float-mainnet-intent file");
      const m = file.typedData.message;
      return { digest: file.digest, struct: { lineId: m.lineId, agent: m.agent, sponsor: m.sponsor, principal: BigInt(m.principal) } };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  staked = [];
  refunds = {};
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(storeDir, { recursive: true, force: true });
});

const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const task = (body) => post("/task", body);
const OK = { intent: "Send 0.5 USDC to Bob", chainId: 5042002, sender: SENDER, constraints: { maxOutgoingUsdcWei: "500000000000000000" } };
const intent = (principal, digest = DIGEST) => ({ kind: "float-mainnet-intent", digest, typedData: { message: { lineId: LINE, agent: SENDER, sponsor: SPONSOR, principal } } });

describe("POST /task", () => {
  test("registers the canonical request and answers the id, the floor and how to stake", async () => {
    const first = await task({ ...OK, sender: SENDER.toUpperCase().replace("0X", "0x") });
    assert.equal(first.status, 200);
    const answer = await first.json();
    // Canonical form: keys sorted at every level, two-space indentation (Shadow's stableStringify), sender lower-cased.
    const canonical = JSON.stringify({ chainId: 5042002, constraints: { maxOutgoingUsdcWei: "500000000000000000" }, intent: OK.intent, sender: SENDER }, null, 2);
    const id = createHash("sha256").update(canonical).digest("hex");
    assert.equal(answer.requestId, `${REQUEST_ID_PREFIX}${id}`);
    assert.equal(answer.priceFloor, "12000");
    assert.deepEqual(answer.pricing, { preparationFeeMicrousd: "10000", retrievalFeePercentOfOutflow: 3, marginMicrousd: "2000" });
    assert.deepEqual([answer.chainId, answer.provider, answer.endpoint, answer.maxOutgoingUsdcWei], [5042002, PROVIDER, ENDPOINT, ONE_USDC.toString()]);
    assert.match(answer.note, /principal is the most you will pay/);
    assert.equal(readFileSync(join(storeDir, "tasks", `${id}.request.json`), "utf8"), canonical);
    const second = await (await task({ sender: OK.sender, chainId: OK.chainId, constraints: OK.constraints, intent: OK.intent })).json();
    assert.equal(second.requestId, answer.requestId);
  });

  test("a request without constraints registers without them; a tag separates deliberate new attempts", async () => {
    const bare = await (await task({ intent: OK.intent, chainId: OK.chainId, sender: OK.sender })).json();
    const id = bare.requestId.slice(REQUEST_ID_PREFIX.length);
    assert.deepEqual(JSON.parse(readFileSync(join(storeDir, "tasks", `${id}.request.json`), "utf8")), { chainId: 5042002, intent: OK.intent, sender: SENDER });
    const tagged = await (await task({ ...OK, tag: "attempt-2" })).json();
    const plain = await (await task(OK)).json();
    assert.notEqual(tagged.requestId, plain.requestId);
    assert.equal((await task({ ...OK, tag: "bad tag!" })).status, 422);
  });

  test("refuses the wrong chain, a bad sender, and outflow above the endpoint cap", async () => {
    for (const [body, pattern] of [
      [{ ...OK, chainId: 5042 }, /chainId must be 5042002/],
      [{ ...OK, sender: "nope" }, /sender must be a 0x address/],
      [{ ...OK, constraints: { maxOutgoingUsdcWei: (ONE_USDC + 1n).toString() } }, /must not exceed 1000000000000000000/],
      [{ ...OK, constraints: { maxOutgoingUsdcWei: 5 } }, /decimal string/],
      [{ ...OK, intent: "" }, /intent must be/],
      ["[]", /not a JSON object/],
    ]) {
      const response = await task(body);
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.match((await response.json()).error, pattern);
    }
    assert.equal((await task("{not json")).status, 400);
    assert.equal((await fetch(`${base}/task`)).status, 405);
    assert.equal((await task({ ...OK, intent: "y".repeat(20_000) })).status, 413);
  });
});

describe("POST /accept", () => {
  test("records the stake and replays an admitted intent to Shadow's handler byte for byte", async () => {
    const requestId = `${REQUEST_ID_PREFIX}${"c".repeat(64)}`;
    const body = JSON.stringify({ intent: intent("50000"), requestId });
    const answer = await (await post("/accept", body)).json();
    assert.deepEqual(answer, { shadow: "/accept", method: "POST", body, remote: "127.0.0.1" });
    assert.deepEqual(staked, [{ digest: DIGEST, requestId, lineId: LINE, agent: SENDER, sponsor: SPONSOR, principal: 50_000n }]);
  });

  test("refuses a stake below the floor or an intent file that does not validate, and Shadow never sees it", async () => {
    const requestId = `${REQUEST_ID_PREFIX}${"c".repeat(64)}`;
    let response = await post("/accept", { intent: intent("11999"), requestId });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /principal 11999 is below the price floor 12000/);
    response = await post("/accept", { intent: { kind: "something-else" }, requestId });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /not a float-mainnet-intent file/);
    assert.equal(staked.length, 1);
  });

  test("an intent for another provider's request id passes straight through", async () => {
    const body = JSON.stringify({ intent: intent("1"), requestId: "report:2026-10" });
    const answer = await (await post("/accept", body)).json();
    assert.equal(answer.body, body);
    assert.deepEqual(staked, []);
  });
});

describe("GET /refund/<digest>", () => {
  test("shows the recorded settlement for a digest, 404 otherwise", async () => {
    refunds[DIGEST] = { digest: DIGEST, amount: "24000", status: "repaid", txHashes: ["0xtx"] };
    assert.deepEqual(await (await fetch(`${base}/refund/${DIGEST}`)).json(), refunds[DIGEST]);
    assert.equal((await fetch(`${base}/refund/${"0x" + "ee".repeat(32)}`)).status, 404);
    assert.equal((await fetch(`${base}/refund/${DIGEST}`, { method: "POST" })).status, 405);
    // Not a digest: Shadow's server answers.
    assert.equal((await (await fetch(`${base}/refund/abc`)).json()).shadow, "/refund/abc");
  });
});

test("every other path reaches the Shadow server", async () => {
  for (const path of ["/serve", "/status/0xabc", "/tasks"]) {
    const response = await fetch(`${base}${path}`, { method: "POST" });
    assert.equal((await response.json()).shadow, path);
  }
  assert.equal((await (await fetch(`${base}/accept`)).json()).method, "GET");
});
