import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("health endpoint reports service health without credentials", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "fisha-tiktok-bot",
  });
});

test("private API rejects requests without the worker secret", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/api/claim", { method: "POST" }),
    { WORKER_API_SECRET: "correct-secret" },
  );
  assert.equal(response.status, 401);
});

test("Telegram webhook rejects requests without the Telegram secret", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: {} }),
    }),
    { TELEGRAM_WEBHOOK_SECRET: "correct-secret" },
  );
  assert.equal(response.status, 403);
});

test("messages from users other than the owner are ignored", async () => {
  let databaseTouched = false;
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    DB: {
      prepare() {
        databaseTouched = true;
        throw new Error("database must not be touched for non-owner updates");
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://example.test/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
      },
      body: JSON.stringify({
        message: { chat: { id: 200 }, from: { id: 999 }, text: "/status" },
      }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(databaseTouched, false);
});


test("duplicate Telegram webhook updates are acknowledged without repeating side effects", async () => {
  let insertCount = 0;
  let cleanupCount = 0;
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async run() {
            if (sql.startsWith("INSERT OR IGNORE INTO webhook_updates")) {
              insertCount += 1;
              return { meta: { changes: 0 } };
            }
            if (sql.startsWith("DELETE FROM webhook_updates")) cleanupCount += 1;
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://example.test/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
      },
      body: JSON.stringify({
        update_id: 123,
        message: { chat: { id: 100 }, from: { id: 100 }, text: "/start" },
      }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, duplicate: true });
  assert.equal(insertCount, 1);
  assert.equal(cleanupCount, 0);
});

test("completion endpoint rejects invalid IDs and reports missing processing jobs", async () => {
  let writes = 0;
  const env = {
    WORKER_API_SECRET: "worker-secret",
    TIMEZONE: "Asia/Tashkent",
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async run() { writes += 1; return { meta: { changes: 0 } }; },
        };
      },
    },
  };
  const invalid = await worker.fetch(
    new Request("https://example.test/api/complete", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: "not-a-number" }),
    }),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.equal(writes, 0);

  const missing = await worker.fetch(
    new Request("https://example.test/api/complete", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: 42 }),
    }),
    env,
  );
  assert.equal(missing.status, 409);
  assert.deepEqual(await missing.json(), {
    ok: false,
    error: "Video is not in the expected state",
  });
  assert.equal(writes, 1);
});

test("failure endpoint does not report success when a job was not updated", async () => {
  const env = {
    WORKER_API_SECRET: "worker-secret",
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async run() { return { meta: { changes: 0 } }; },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://example.test/api/fail", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: 42, error: "test" }),
    }),
    env,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "Video is not currently processing",
  });
});

test("delivery-start endpoint records that Telegram sending may begin", async () => {
  let sqlSeen = "";
  const env = {
    WORKER_API_SECRET: "worker-secret",
    DB: { prepare(sql) { sqlSeen = sql; return { bind() { return this; }, async run() { return { meta: { changes: 1 } }; } }; } },
  };
  const response = await worker.fetch(
    new Request("https://example.test/api/started", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: 7 }),
    }), env,
  );
  assert.equal(response.status, 200);
  assert.match(sqlSeen, /publishing_started_at=COALESCE\(publishing_started_at,/);
  assert.match(sqlSeen, /status=\x27processing\x27/);
});

test("completion accepts only processing jobs", async () => {
  let sqlSeen = "";
  const env = {
    WORKER_API_SECRET: "worker-secret",
    TIMEZONE: "Asia/Tashkent",
    DB: { prepare(sql) { sqlSeen = sql; return { bind() { return this; }, async run() { return { meta: { changes: 1 } }; } }; } },
  };
  const response = await worker.fetch(
    new Request("https://example.test/api/complete", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: 7 }),
    }), env,
  );
  assert.equal(response.status, 200);
  assert.match(sqlSeen, /status='processing'/);
});


test("manual retry clears the old delivery marker and claim timestamp", async () => {
  const originalFetch = globalThis.fetch;
  let sqlSeen = "";
  let values = [];
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    DB: {
      prepare(sql) {
        sqlSeen = sql;
        return {
          bind(...args) { values = args; return this; },
          async run() { return { meta: { changes: 1 } }; },
        };
      },
    },
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const response = await worker.fetch(
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
        },
        body: JSON.stringify({
          message: { chat: { id: 100 }, from: { id: 100 }, text: "/retry 17" },
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.match(sqlSeen, /status='queued'/);
    assert.match(sqlSeen, /claimed_at=NULL/);
    assert.match(sqlSeen, /publishing_started_at=NULL/);
    assert.match(sqlSeen, /status='failed'/);
    assert.deepEqual(values, [17]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("claim recovers stale processing jobs differently before and after delivery starts", async () => {
  const statements = [];
  const env = {
    WORKER_API_SECRET: "worker-secret",
    DB: {
      prepare(sql) {
        statements.push(sql);
        return {
          bind() { return this; },
          async run() { return { meta: { changes: 0 } }; },
          async first() { return null; },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://example.test/api/claim", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret" },
    }),
    env,
  );
  assert.equal(response.status, 204);
  assert.match(statements[0], /publishing_started_at IS NULL/);
  assert.match(statements[0], /status='queued'/);
  assert.match(statements[1], /publishing_started_at IS NOT NULL/);
  assert.match(statements[1], /status='failed'/);
  assert.match(statements[1], /UNCERTAIN DELIVERY/);
});


test("webhook retention cleanup failure does not drop a new owner message", async () => {
  let inserted = 0;
  let queued = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async run() {
            if (sql.startsWith("INSERT OR IGNORE INTO webhook_updates")) {
              inserted += 1;
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("DELETE FROM webhook_updates")) {
              throw new Error("temporary cleanup failure");
            }
            if (sql.startsWith("INSERT INTO videos")) queued += 1;
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  try {
    const response = await worker.fetch(
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
        },
        body: JSON.stringify({
          update_id: 124,
          message: { chat: { id: 100 }, from: { id: 100 }, text: "https://www.tiktok.com/@demo/video/123" },
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(inserted, 1);
    assert.equal(queued, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("failure after delivery starts is explicitly marked as uncertain", async () => {
  let sqlSeen = "";
  let values = [];
  const env = {
    WORKER_API_SECRET: "worker-secret",
    DB: {
      prepare(sql) {
        sqlSeen = sql;
        return {
          bind(...args) { values = args; return this; },
          async run() { return { meta: { changes: 1 } }; },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://example.test/api/fail", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: 17, error: "Telegram connection timed out" }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(sqlSeen, /publishing_started_at IS NOT NULL/);
  assert.match(sqlSeen, /UNCERTAIN DELIVERY:/);
  assert.match(sqlSeen, /status='processing'/);
  assert.deepEqual(values, [
    "Telegram connection timed out",
    "Telegram connection timed out",
    17,
  ]);
});


test("failed queue insertion releases the webhook dedupe key for Telegram retry", async () => {
  const statements = [];
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    DB: {
      prepare(sql) {
        statements.push(sql);
        return {
          bind() { return this; },
          async run() {
            if (sql.startsWith("INSERT INTO videos")) throw new Error("temporary queue write failure");
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  await assert.rejects(
    worker.fetch(
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
        },
        body: JSON.stringify({
          update_id: 125,
          message: { chat: { id: 100 }, from: { id: 100 }, text: "https://www.tiktok.com/@demo/video/456" },
        }),
      }),
      env,
    ),
    /temporary queue write failure/,
  );
  assert.ok(statements.some(sql => sql.startsWith("DELETE FROM webhook_updates WHERE update_id=?")));
});

test("reply failure after queue insertion keeps the webhook dedupe key", async () => {
  const statements = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: "temporary Telegram failure" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    DB: {
      prepare(sql) {
        statements.push(sql);
        return {
          bind() { return this; },
          async run() {
            if (sql.startsWith("INSERT INTO videos")) return { meta: { changes: 1 } };
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  try {
    await assert.rejects(
      worker.fetch(
        new Request("https://example.test/telegram/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
          },
          body: JSON.stringify({
            update_id: 126,
            message: { chat: { id: 100 }, from: { id: 100 }, text: "https://www.tiktok.com/@demo/video/789" },
          }),
        }),
        env,
      ),
      /Telegram API sendMessage/,
    );
    assert.ok(!statements.some(sql => sql.startsWith("DELETE FROM webhook_updates WHERE update_id=?")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publish reply failure keeps webhook dedupe key and prevents applying publish twice", async () => {
  const updateIds = new Set();
  let publishUpdates = 0;
  let dedupeDeletes = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ ok: false, description: "temporary Telegram failure" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    DB: {
      prepare(sql) {
        let values = [];
        return {
          bind(...args) { values = args; return this; },
          async run() {
            if (sql.startsWith("INSERT OR IGNORE INTO webhook_updates")) {
              const [updateId] = values;
              if (updateIds.has(updateId)) return { meta: { changes: 0 } };
              updateIds.add(updateId);
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("DELETE FROM webhook_updates WHERE update_id=?")) {
              dedupeDeletes += 1;
              updateIds.delete(values[0]);
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET force_publish=1")) {
              publishUpdates += 1;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };

  const makeRequest = () => new Request("https://example.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
    },
    body: JSON.stringify({
      update_id: 127,
      message: { chat: { id: 100 }, from: { id: 100 }, text: "/publish" },
    }),
  });

  try {
    await assert.rejects(worker.fetch(makeRequest(), env), /Telegram API sendMessage/);
    const retryResponse = await worker.fetch(makeRequest(), env);
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(await retryResponse.json(), { ok: true, duplicate: true });
    assert.equal(publishUpdates, 1);
    assert.equal(dedupeDeletes, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
