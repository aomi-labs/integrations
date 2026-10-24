// Aomi Task API as a Shadow provider service.
//
// Shadow's reference provider server (vendor/shadow/examples/float-mainnet-
// provider-server/server.mjs) calls `service.prepare({ digest, requestId })`
// before it signs a ServiceAcceptance, and serves the prepared bytes after the
// contract has paid the digest. This service buys the task from the Aomi Task
// API inside `prepare`, so a failed preparation never becomes an acceptance and
// never costs the sponsor anything. The task request itself is stored by the
// provider's `/task` route (server.mjs) under the request id before `/accept`.
//
// One Task purchase per request id: the Task client keeps a private journal
// per request id, and a second `prepare` for the same id replays that journal
// (`recover`) instead of paying again. Retrieval is signed only when the
// preview is `ready`, within the fee caps the client was built with.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REQUEST_ID_PREFIX = "aomi-task:";
export const RESULT_SCHEMA = "aomi-task-shadow/1";

// createClient(journalDirectory) returns a TaskClient (vendor/product-mono/
// examples/task-api/client.ts) or anything with the same purchase / recover /
// retrieve methods. storeDir is the provider server's PROVIDER_STORE_DIR; task
// requests and journals live under storeDir/tasks.
export function createAomiTaskService({ storeDir, createClient }) {
  const tasks = join(storeDir, "tasks");

  const service = async () => {
    throw new Error("an Aomi task must be prepared before provider acceptance; nothing is bought after payment");
  };

  service.prepare = async ({ requestId }) => {
    if (typeof requestId !== "string" || !requestId.startsWith(REQUEST_ID_PREFIX)) return null;
    const id = requestId.slice(REQUEST_ID_PREFIX.length);
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    const requestFile = join(tasks, `${id}.request.json`);
    if (!existsSync(requestFile)) return null;
    const request = JSON.parse(readFileSync(requestFile, "utf8"));

    const journal = join(tasks, id);
    const client = createClient(journal);
    let outcome = existsSync(join(journal, "state.json")) ? await client.recover() : await client.purchase(request);
    if (outcome.status === "ready") outcome = await client.retrieve();
    // A failed or expired preparation is a paid attempt with nothing to sell:
    // refuse acceptance (422) and keep the journal so a retry cannot pay again.
    if (outcome.status === "failed" || outcome.status === "expired") return null;
    if (outcome.status !== "complete") {
      throw new Error(`Aomi task ${id} is still ${outcome.status}; retry this same request later`);
    }

    // The journal holds the verified preview that `complete` does not return.
    const state = JSON.parse(readFileSync(join(journal, "state.json"), "utf8"));
    const { quoteId, requestHash, payloadHash, expiresAt, attestation, summary, pricing } = state.preview;
    const result = {
      schema: RESULT_SCHEMA,
      quoteId,
      requestHash,
      payloadHash,
      expiresAt,
      attestation,
      summary,
      pricing,
      bundle: JSON.parse(outcome.bytes.toString("utf8")),
    };
    return { result: `${JSON.stringify(result)}\n`, resultRef: state.job.resultUrl };
  };

  return service;
}
