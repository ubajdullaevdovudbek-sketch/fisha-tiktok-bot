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

    let response = await api(mf, "/api/photo-batch-start", { id, offset: 0, total_count: 20 });
    assert.equal(response.status, 200);
    response = await api(mf, "/api/photo-progress", { id, next_offset: 10 });
    assert.equal(response.status, 200);

    response = await api(mf, "/api/photo-batch-start", { id, offset: 10, total_count: 20 });
    assert.equal(response.status, 200);
    response = await api(mf, "/api/photo-progress", { id, next_offset: 20 });
    assert.equal(response.status, 200);

    const row = await db.prepare("SELECT album_next_offset FROM videos WHERE id=?").bind(id).first();
    assert.equal(row.album_next_offset, 20);

    await db.prepare("UPDATE videos SET status='queued' WHERE id=?").bind(id).run();
    response = await api(mf, "/api/photo-progress", { id, next_offset: 25 });
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


test("real Worker + local D1: manually prioritized queued video is claimed before older jobs", async () => {
  const { mf, db } = await setup();
  try {
    const older = await db.prepare(
      "INSERT INTO videos(kind, source_url, status) VALUES('tiktok_url', 'https://tiktok.com/video/older', 'queued')"
    ).run();
    const priority = await db.prepare(
      "INSERT INTO videos(kind, source_url, status, force_publish) VALUES('tiktok_url', 'https://tiktok.com/video/priority', 'queued', 1)"
    ).run();

    const response = await api(mf, "/api/claim", {});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.job.id, priority.meta.last_row_id);
    assert.notEqual(payload.job.id, older.meta.last_row_id);

    const rows = await db.prepare(
      "SELECT id, status, force_publish FROM videos ORDER BY id"
    ).all();
    const claimed = rows.results.find((row) => row.id === priority.meta.last_row_id);
    const waiting = rows.results.find((row) => row.id === older.meta.last_row_id);
    assert.deepEqual(claimed, { id: priority.meta.last_row_id, status: "processing", force_publish: 0 });
    assert.deepEqual(waiting, { id: older.meta.last_row_id, status: "queued", force_publish: 0 });
  } finally {
    await mf.dispose();
  }
});


test("real Worker + local D1: stale video claim is recovered before delivery starts", async () => {
  const { mf, db } = await setup();
  try {
    const inserted = await db.prepare(
      "INSERT INTO videos(kind, source_url, status, claimed_at) VALUES('tiktok_url', 'https://tiktok.com/video/stale', 'processing', strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 minutes'))"
    ).run();
    const id = inserted.meta.last_row_id;
    const response = await api(mf, "/api/claim", {});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.job.id, id);
    const row = await db.prepare(
      "SELECT status, publishing_started_at FROM videos WHERE id=?"
    ).bind(id).first();
    assert.equal(row.status, "processing");
    assert.equal(row.publishing_started_at, null);
  } finally {
    await mf.dispose();
  }
});

test("real Worker + local D1: stale video after delivery start becomes uncertain failure", async () => {
  const { mf, db } = await setup();
  try {
    const inserted = await db.prepare(
      "INSERT INTO videos(kind, source_url, status, claimed_at, publishing_started_at) VALUES('tiktok_url', 'https://tiktok.com/video/uncertain', 'processing', strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 minutes'))"
    ).run();
    const id = inserted.meta.last_row_id;
    const response = await api(mf, "/api/claim", {});
    assert.equal(response.status, 204);
    const row = await db.prepare(
      "SELECT status, error, claimed_at FROM videos WHERE id=?"
    ).bind(id).first();
    assert.equal(row.status, "failed");
    assert.match(row.error, /UNCERTAIN DELIVERY/);
    assert.equal(row.claimed_at, null);
  } finally {
    await mf.dispose();
  }
});

test("real Worker + local D1: stale audio claim is recovered before audio send starts", async () => {
  const { mf, db } = await setup();
  try {
    const video = await db.prepare(
      "INSERT INTO videos(kind, source_url, status) VALUES('tiktok_url', 'https://tiktok.com/video/audio', 'published')"
    ).run();
    const inserted = await db.prepare(
      "INSERT INTO audio_jobs(video_id, kind, source_url, status, claimed_at) VALUES(?, 'tiktok_url', 'https://tiktok.com/video/audio', 'processing', strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 minutes'))"
    ).bind(video.meta.last_row_id).run();
    const id = inserted.meta.last_row_id;
    const response = await api(mf, "/api/audio/claim", {});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.job.id, id);
    const row = await db.prepare(
      "SELECT status, audio_started_at FROM audio_jobs WHERE id=?"
    ).bind(id).first();
    assert.equal(row.status, "processing");
    assert.equal(row.audio_started_at, null);
  } finally {
    await mf.dispose();
  }
});

test("real Worker + local D1: stale audio after send start becomes uncertain failure", async () => {
  const { mf, db } = await setup();
  try {
    const video = await db.prepare(
      "INSERT INTO videos(kind, source_url, status) VALUES('tiktok_url', 'https://tiktok.com/video/audio-uncertain', 'published')"
    ).run();
    const inserted = await db.prepare(
      "INSERT INTO audio_jobs(video_id, kind, source_url, status, claimed_at, audio_started_at) VALUES(?, 'tiktok_url', 'https://tiktok.com/video/audio-uncertain', 'processing', strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 minutes'))"
    ).bind(video.meta.last_row_id).run();
    const id = inserted.meta.last_row_id;
    const response = await api(mf, "/api/audio/claim", {});
    assert.equal(response.status, 204);
    const row = await db.prepare(
      "SELECT status, error, claimed_at FROM audio_jobs WHERE id=?"
    ).bind(id).first();
    assert.equal(row.status, "failed");
    assert.match(row.error, /UNCERTAIN DELIVERY/);
    assert.equal(row.claimed_at, null);
  } finally {
    await mf.dispose();
  }
});
