import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { readFile } from "node:fs/promises";

function makeDb({ first = null, changes = 1 } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, values: [] };
      calls.push(call);
      return {
        bind(...values) {
          call.values = values;
          return this;
        },
        async run() {
          return { meta: { changes } };
        },
        async first() {
          return first;
        },
      };
    },
  };
}

async function invoke(path, { method = "POST", body = {}, db = makeDb(), secret = "test-secret" } = {}) {
  const request = new Request("https://worker.test" + path, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const response = await worker.fetch(request, {
    WORKER_API_SECRET: "test-secret",
    DB: db,
  });
  return { response, db };
}

test("audio API rejects requests without the Worker secret", async () => {
  const { response } = await invoke("/api/audio/started", {
    body: { id: 4 },
    secret: "wrong-secret",
  });
  assert.equal(response.status, 401);
});

test("audio started endpoint records the delivery marker only for processing jobs", async () => {
  const { response, db } = await invoke("/api/audio/started", { body: { id: 4 } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(db.calls[0].sql, /audio_started_at=COALESCE\(audio_started_at/);
  assert.match(db.calls[0].sql, /status='processing'/);
  assert.deepEqual(db.calls[0].values, [4]);
});

test("audio started endpoint rejects jobs outside processing state", async () => {
  const db = makeDb({ changes: 0 });
  const { response } = await invoke("/api/audio/started", { body: { id: 4 }, db });
  assert.equal(response.status, 409);
});

test("stale audio claims are requeued only before delivery starts", async () => {
  const { response, db } = await invoke("/api/audio/claim");
  assert.equal(response.status, 204);
  assert.match(db.calls[0].sql, /audio_started_at IS NULL/);
  assert.match(db.calls[1].sql, /audio_started_at IS NOT NULL/);
  assert.match(db.calls[1].sql, /UNCERTAIN DELIVERY/);
});

test("audio schema and migration both persist the delivery marker", async () => {
  const schema = await readFile(new URL("../../cloudflare/schema.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../../cloudflare/migrations/0003_audio_jobs.sql", import.meta.url), "utf8");
  assert.match(schema, /audio_started_at TEXT/);
  assert.match(migration, /audio_started_at TEXT/);
});
