import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/index.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // The behavioural test below is skipped when this runtime has no node:sqlite.
}

// Regression guard: hosted publishing has no daily cap and no publishing window.
test("hosted config, Worker and publisher workflows define no daily cap or publishing window", async () => {
  const files = [
    "../src/index.js",
    "../wrangler.toml",
    "../wrangler.toml.example",
    "../../.github/workflows/publish.yml",
    "../../.github/workflows/publish-audio.yml",
  ];
  const audioWorkflow = await read("../../.github/workflows/publish-audio.yml");
  assert.match(audioWorkflow, /vars\.ENABLE_AUDIO_PUBLISH == 'true'/);
  assert.doesNotMatch(audioWorkflow, /vars\.ENABLE_PRODUCTION_PUBLISH/);
  const videoWorkflow = await read("../../.github/workflows/publish.yml");
  assert.match(videoWorkflow, /vars\.ENABLE_PRODUCTION_PUBLISH == 'true'/);
  for (const file of files) {
    assert.doesNotMatch(
      await read(file),
      /POSTS_PER_DAY|PUBLISH_START|PUBLISH_END/,
      `${file} must not reintroduce the daily cap or publishing window`,
    );
  }
});

// Minimal D1-compatible shim over node:sqlite so the real Worker SQL runs against real SQLite.
function d1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    run: async () => {
      const result = sqlite.prepare(sql).run(...args);
      return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql) };
}

test(
  "claim ignores legacy cap and window variables and keeps FIFO order",
  { skip: !DatabaseSync && "node:sqlite is unavailable in this runtime" },
  async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(await read("../schema.sql"));
    const today = new Date().toISOString().slice(0, 10);

    // Already more posts today than a legacy POSTS_PER_DAY=1 would allow, all just now.
    for (let n = 0; n < 3; n += 1) {
      sqlite
        .prepare(
          "INSERT INTO videos(kind, source_url, status, published_at, published_local_date) " +
            "VALUES('tiktok_url', ?, 'published', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)",
        )
        .run(`https://www.tiktok.com/@a/video/${n}`, today);
    }
    const queued = [];
    for (let n = 0; n < 5; n += 1) {
      const result = sqlite
        .prepare("INSERT INTO videos(kind, source_url) VALUES('tiktok_url', ?)")
        .run(`https://www.tiktok.com/@a/video/q${n}`);
      queued.push(Number(result.lastInsertRowid));
    }

    const env = {
      DB: d1(sqlite),
      WORKER_API_SECRET: "test-secret",
      TIMEZONE: "UTC",
      // Legacy variables must have no effect even if someone sets them in the dashboard.
      POSTS_PER_DAY: "1",
      PUBLISH_START: "00:00",
      PUBLISH_END: "00:01",
    };
    const claim = () =>
      worker.fetch(
        new Request("https://worker.test/api/claim", {
          method: "POST",
          headers: { Authorization: "Bearer test-secret" },
        }),
        env,
      );

    for (const expectedId of queued) {
      const response = await claim();
      assert.equal(response.status, 200, "a queued job must be claimable regardless of cap or window");
      assert.equal((await response.json()).job.id, expectedId);
    }
    assert.equal((await claim()).status, 204, "an empty queue returns 204");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM videos WHERE status='processing'").get().n, 5);
  },
);
