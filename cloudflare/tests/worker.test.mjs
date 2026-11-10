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
