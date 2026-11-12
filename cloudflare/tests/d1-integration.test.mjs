import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const workerPath = new URL("../src/index.js", import.meta.url).pathname;
const schemaPath = new URL("../schema.sql", import.meta.url);

async function setup() {
  const mf = new Miniflare({
    scriptPath: workerPath,
    modules: true,
    compatibilityDate: "2026-11-10",
    d1Databases: { DB: "fisha-test-db" },
    bindings: {
      WORKER_API_SECRET: "integration-test-secret",
      TIMEZONE: "UTC",
    },
  });
  try {
    await mf.ready;
    const db = await mf.getD1Database("DB");
    const schema = await readFile(schemaPath, "utf8");
    // D1 exec may split multiline schema incorrectly; prepare each SQL statement.
    for (const statement of schema.split(";")) {
      const sql = statement.trim();
      if (sql) await db.prepare(sql).run();
    }
    return { mf, db };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

async function api(mf, path, body) {
  return mf.dispatchFetch(`https://worker.test${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer integration-test-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("real Worker + local D1: photo checkpoints are monotonic and state guarded", async () => {
  const { mf, db } = await setup();
  try {
    const inserted = await db.prepare(
      "INSERT INTO videos(kind, source_url, status) VALUES('tiktok_url', 'https://tiktok.com/photo/123', 'processing')"
    ).run();
    const id = inserted.meta.last_row_id;

    let response = await api(mf, "/api/photo-progress", { id, next_offset: 10 });
    assert.equal(response.status, 200);
    response = await api(mf, "/api/photo-progress", { id, next_offset: 5 });
    assert.equal(response.status, 200);

    const row = await db.prepare("SELECT album_next_offset FROM videos WHERE id=?").bind(id).first();
    assert.equal(row.album_next_offset, 10);

    await db.prepare("UPDATE videos SET status='queued' WHERE id=?").bind(id).run();
    response = await api(mf, "/api/photo-progress", { id, next_offset: 15 });
    assert.equal(response.status, 409);
  } finally {
    await mf.dispose();
  }
});

test("real Worker + local D1: video completion and audio enqueue commit together", async () => {
  const { mf, db } = await setup();
  try {
    const inserted = await db.prepare(
      "INSERT INTO videos(kind, source_url, status) VALUES('tiktok_url', 'https://tiktok.com/video/456', 'processing')"
    ).run();
    const id = inserted.meta.last_row_id;

    const response = await api(mf, "/api/complete", {
      id,
      audio_task: {
        kind: "tiktok_url",
        source_url: "https://tiktok.com/video/456",
        title: "Test audio",
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, audio_enqueued: true });

    const video = await db.prepare("SELECT status FROM videos WHERE id=?").bind(id).first();
    const audio = await db.prepare("SELECT status, source_url FROM audio_jobs WHERE video_id=?").bind(id).first();
    assert.equal(video.status, "published");
    assert.equal(audio.status, "queued");
    assert.equal(audio.source_url, "https://tiktok.com/video/456");
  } finally {
    await mf.dispose();
  }
});

test("real Worker + local D1: invalid audio task leaves video processing", async () => {
  const { mf, db } = await setup();
  try {
    const inserted = await db.prepare(
      "INSERT INTO videos(kind, source_url, status) VALUES('tiktok_url', 'https://tiktok.com/video/789', 'processing')"
    ).run();
    const id = inserted.meta.last_row_id;

    const response = await api(mf, "/api/complete", {
      id,
      audio_task: { kind: "unsupported" },
    });
    assert.equal(response.status, 400);

    const video = await db.prepare("SELECT status FROM videos WHERE id=?").bind(id).first();
    const audioCount = await db.prepare("SELECT COUNT(*) AS n FROM audio_jobs WHERE video_id=?").bind(id).first();
    assert.equal(video.status, "processing");
    assert.equal(audioCount.n, 0);
  } finally {
    await mf.dispose();
  }
});
