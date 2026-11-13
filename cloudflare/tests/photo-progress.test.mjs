import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { readFile } from "node:fs/promises";

function makeDb(changes = 1) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, values: [] };
      calls.push(call);
      return {
        bind(...values) { call.values = values; return this; },
        async run() { return { meta: { changes } }; },
      };
    },
  };
}

async function invoke(body, db) {
  const request = new Request("https://worker.test/api/photo-progress", {
    method: "POST",
    headers: { Authorization: "Bearer test-secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return worker.fetch(request, { WORKER_API_SECRET: "test-secret", DB: db });
}

test("photo progress persists the maximum confirmed offset for processing video jobs", async () => {
  const db = makeDb();
  const response = await invoke({ id: 12, next_offset: 10 }, db);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, next_offset: 10 });
  assert.match(db.calls[0].sql, /album_next_offset=MAX\(album_next_offset, \?\)/);
  assert.match(db.calls[0].sql, /status='processing'/);
  assert.match(db.calls[0].sql, /kind='tiktok_url'/);
  assert.deepEqual(db.calls[0].values, [10, 12, 10, 10]);
});

test("photo progress rejects jobs not in processing state", async () => {
  const db = makeDb(0);
  const response = await invoke({ id: 12, next_offset: 10 }, db);
  assert.equal(response.status, 409);
});

test("photo progress rejects invalid offsets", async () => {
  const db = makeDb();
  const response = await invoke({ id: 12, next_offset: 0 }, db);
  assert.equal(response.status, 400);
  assert.equal(db.calls.length, 0);
});

test("photo progress column exists in schema and migration", async () => {
  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../migrations/0004_photo_album_progress.sql", import.meta.url), "utf8");
  const reconciliation = await readFile(new URL("../migrations/0005_photo_batch_reconciliation.sql", import.meta.url), "utf8");
  assert.match(schema, /album_next_offset INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /ADD COLUMN album_next_offset INTEGER NOT NULL DEFAULT 0/);
  assert.match(reconciliation, /ADD COLUMN album_pending_offset INTEGER/);
  assert.match(reconciliation, /ADD COLUMN album_total_count INTEGER/);
});
