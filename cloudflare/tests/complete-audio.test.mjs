import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function makeDb({ changes = 1 } = {}) {
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
      };
    },
    async batch(statements) {
      return statements.map(() => ({ meta: { changes } }));
    },
  };
}

async function invoke(body, db) {
  const request = new Request("https://worker.test/api/complete", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, {
    WORKER_API_SECRET: "test-secret",
    TIMEZONE: "Asia/Tashkent",
    DB: db,
  });
  return response;
}

test("video completion atomically inserts optional audio task and publishes video", async () => {
  const db = makeDb();
  const response = await invoke({
    id: 42,
    audio_task: {
      kind: "tiktok_url",
      source_url: "https://www.tiktok.com/@creator/video/123",
      title: "sample",
    },
  }, db);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, audio_enqueued: true });
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].sql, /INSERT OR IGNORE INTO audio_jobs/);
  assert.match(db.calls[0].sql, /status='processing'/);
  assert.match(db.calls[1].sql, /UPDATE videos SET status='published'/);
});

test("invalid audio task prevents video completion", async () => {
  const db = makeDb();
  const response = await invoke({
    id: 42,
    audio_task: { kind: "tiktok_url", source_url: "" },
  }, db);
  assert.equal(response.status, 400);
  assert.equal(db.calls.length, 0);
});

test("video completion without audio task remains a single update", async () => {
  const db = makeDb();
  const response = await invoke({ id: 42 }, db);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(db.calls.length, 1);
});
