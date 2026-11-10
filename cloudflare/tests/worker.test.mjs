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
    error: "Video is not currently processing",
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
