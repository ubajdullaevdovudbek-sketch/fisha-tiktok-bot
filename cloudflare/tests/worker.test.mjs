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
