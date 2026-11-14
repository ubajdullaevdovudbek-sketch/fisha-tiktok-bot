import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("owner publish button prioritizes the queued job and dispatches the main publisher", async () => {
  const originalFetch = globalThis.fetch;
  const statements = [];
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("api.github.com")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    GITHUB_ACTIONS_TOKEN: "github-actions-token",
    DB: {
      prepare(sql) {
        statements.push(sql);
        return {
          bind() { return this; },
          async run() { return { meta: { changes: 1 } }; },
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
          update_id: 9001,
          callback_query: {
            id: "callback-1",
            data: "publish:42",
            from: { id: 100 },
            message: { chat: { id: 100 } },
          },
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.match(statements.join("\\n"), /force_publish=1 WHERE id=\?/);
    const dispatch = requests.find(item => item.url.includes("api.github.com"));
    assert.ok(dispatch, "GitHub workflow dispatch request should be made");
    assert.ok(dispatch.url.endsWith("/actions/workflows/publish.yml/dispatches"));
    assert.deepEqual(JSON.parse(dispatch.options.body), { ref: "main" });
    assert.equal(dispatch.options.headers.Authorization, "Bearer github-actions-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publish button without GitHub token only prioritizes the job and does not claim dispatch", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    DB: {
      prepare() {
        return { bind() { return this; }, async run() { return { meta: { changes: 1 } }; } };
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
          update_id: 9002,
          callback_query: {
            id: "callback-2",
            data: "publish:43",
            from: { id: 100 },
            message: { chat: { id: 100 } },
          },
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(requests.some(url => url.includes("api.github.com")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("new TikTok links request an immediate publisher run when the token is configured", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const statements = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("api.github.com")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    GITHUB_ACTIONS_TOKEN: "github-actions-token",
    DB: {
      prepare(sql) {
        statements.push(sql);
        return {
          bind() { return this; },
          async run() { return { meta: { changes: 1, last_row_id: 44 } }; },
          async first() { return null; },
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
          update_id: 9010,
          message: {
            from: { id: 100 },
            chat: { id: 100 },
            text: "https://www.tiktok.com/@creator/video/123456789",
          },
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.ok(statements.some(sql => sql.includes("INSERT OR IGNORE INTO videos") && sql.includes("source_key, tiktok_video_id")));
    const dispatch = requests.find(item => item.url.includes("api.github.com"));
    assert.ok(dispatch, "new TikTok links should dispatch the publisher");
    assert.ok(dispatch.url.endsWith("/actions/workflows/publish.yml/dispatches"));
    assert.deepEqual(JSON.parse(dispatch.options.body), { ref: "main" });
    assert.equal(dispatch.options.headers.Authorization, "Bearer github-actions-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new TikTok links stay queued on schedule when the dispatch token is missing", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const env = {
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    OWNER_ID: "100",
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async run() { return { meta: { changes: 1, last_row_id: 45 } }; },
          async first() { return null; },
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
          update_id: 9011,
          message: {
            from: { id: 100 },
            chat: { id: 100 },
            text: "https://www.tiktok.com/@creator/video/123456789",
          },
        }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(requests.some(url => url.includes("api.github.com")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
