import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const workerPath = new URL("../src/index.js", import.meta.url).pathname;
const baselinePath = new URL("./fixtures/pre_0002_baseline.sql", import.meta.url);
const migrationFiles = [
  "0002_delivery_uncertain.sql",
  "0003_audio_jobs.sql",
  "0004_photo_album_progress.sql",
  "0005_photo_batch_reconciliation.sql",
  "0006_video_retry_and_dedupe.sql",
].map((name) => new URL(`../migrations/${name}`, import.meta.url));

async function runSql(db, file) {
  const sql = await readFile(file, "utf8");
  for (const statement of sql.split(";")) {
    const text = statement.trim();
    if (text) await db.prepare(text).run();
  }
}

// Local Miniflare D1 (workerd). This is NOT a Cloudflare-hosted D1 database.
async function setupLegacyDb() {
  const mf = new Miniflare({
    scriptPath: workerPath,
    modules: true,
    compatibilityDate: "2026-11-10",
    d1Databases: { DB: "fisha-migration-test-db" },
    bindings: { WORKER_API_SECRET: "integration-test-secret", TIMEZONE: "UTC" },
  });
  try {
    await mf.ready;
    const db = await mf.getD1Database("DB");
    await runSql(db, baselinePath);
    await db
      .prepare(
        "INSERT INTO videos(id, kind, source_url, status, source_author, source_caption) " +
          "VALUES(41, 'tiktok_url', 'https://tiktok.test/video/41', 'published', 'creator', 'existing caption')"
      )
      .run();
    return { mf, db };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

async function columnNames(db, table) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  return results.map((row) => row.name);
}

test("ordered migrations on a legacy D1 keep the existing video and add the new schema", async () => {
  const { mf, db } = await setupLegacyDb();
  try {
    const before = await columnNames(db, "videos");
    assert.ok(!before.includes("publishing_started_at"));
    assert.ok(!before.includes("album_next_offset"));
    assert.ok(!before.includes("album_pending_offset"));

    for (const file of migrationFiles) await runSql(db, file);

    const video = await db
      .prepare(
        "SELECT id, kind, source_url, status, source_author, source_caption, " +
          "publishing_started_at, album_next_offset, album_pending_offset, album_total_count, attempt_count, next_attempt_at, source_key, tiktok_video_id FROM videos WHERE id=41"
      )
      .first();
    assert.deepEqual(video, {
      id: 41,
      kind: "tiktok_url",
      source_url: "https://tiktok.test/video/41",
      status: "published",
      source_author: "creator",
      source_caption: "existing caption",
      publishing_started_at: null,
      album_next_offset: 0,
      album_pending_offset: null,
      album_total_count: null,
      attempt_count: 0,
      next_attempt_at: null,
      source_key: null,
      tiktok_video_id: null,
    });

    const after = await columnNames(db, "videos");
    assert.ok(after.includes("publishing_started_at"));
    assert.ok(after.includes("album_next_offset"));
    assert.ok(after.includes("album_pending_offset"));
    assert.ok(after.includes("album_total_count"));
    assert.ok(after.includes("attempt_count"));
    assert.ok(after.includes("next_attempt_at"));
    assert.ok(after.includes("source_key"));
    assert.ok(after.includes("tiktok_video_id"));
    assert.equal((await columnNames(db, "audio_jobs")).length, 12);

    const { results: indexes } = await db.prepare("PRAGMA index_list(audio_jobs)").all();
    assert.ok(indexes.some((row) => row.name === "idx_audio_jobs_queue"));
  } finally {
    await mf.dispose();
  }
});

test("migrated legacy D1 enforces UNIQUE and CHECK constraints", async () => {
  const { mf, db } = await setupLegacyDb();
  try {
    for (const file of migrationFiles) await runSql(db, file);

    await db
      .prepare("INSERT INTO audio_jobs(video_id, kind, source_url) VALUES(41, 'tiktok_url', 'u')")
      .run();
    await assert.rejects(
      db
        .prepare("INSERT INTO audio_jobs(video_id, kind, source_url) VALUES(41, 'tiktok_url', 'u')")
        .run(),
      /UNIQUE/i
    );
    await assert.rejects(
      db.prepare("INSERT INTO videos(kind, source_url, status) VALUES('tiktok_url', 'x', 'bogus')").run(),
      /CHECK/i
    );
    await assert.rejects(
      db.prepare("INSERT INTO audio_jobs(video_id, kind) VALUES(41, 'bogus')").run(),
      /CHECK|UNIQUE/i
    );
  } finally {
    await mf.dispose();
  }
});

test("re-running an ALTER migration fails instead of silently duplicating a column", async () => {
  const { mf, db } = await setupLegacyDb();
  try {
    for (const file of migrationFiles) await runSql(db, file);
    await assert.rejects(runSql(db, migrationFiles[0]), /duplicate column/i);
    await assert.rejects(runSql(db, migrationFiles[2]), /duplicate column/i);
    await assert.rejects(runSql(db, migrationFiles[3]), /duplicate column/i);
    await assert.rejects(runSql(db, migrationFiles[4]), /duplicate column/i);
  } finally {
    await mf.dispose();
  }
});

test("Worker photo checkpoint endpoint works on a migrated legacy D1", async () => {
  const { mf, db } = await setupLegacyDb();
  try {
    for (const file of migrationFiles) await runSql(db, file);
    await db
      .prepare("UPDATE videos SET status='processing' WHERE id=41")
      .run();

    const start = await mf.dispatchFetch("https://worker.test/api/photo-batch-start", {
      method: "POST",
      headers: { Authorization: "Bearer integration-test-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: 41, offset: 0, total_count: 17 }),
    });
    assert.equal(start.status, 200);

    const response = await mf.dispatchFetch("https://worker.test/api/photo-progress", {
      method: "POST",
      headers: {
        Authorization: "Bearer integration-test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: 41, next_offset: 10 }),
    });
    assert.equal(response.status, 200, await response.text());

    const row = await db.prepare("SELECT album_next_offset FROM videos WHERE id=41").first();
    assert.equal(row.album_next_offset, 10);
  } finally {
    await mf.dispose();
  }
});



test("migration 0006 creates unique source keys without backfilling old rows", async () => {
  const { mf, db } = await setupLegacyDb();
  try {
    for (const file of migrationFiles) await runSql(db, file);
    const old = await db.prepare("SELECT source_key FROM videos WHERE id=41").first();
    assert.equal(old.source_key, null);
    await db.prepare(
      "INSERT INTO videos(kind, source_url, source_key, tiktok_video_id) VALUES('tiktok_url', 'https://tiktok.test/video/900', 'tt:900', '900')"
    ).run();
    await assert.rejects(
      db.prepare(
        "INSERT INTO videos(kind, source_url, source_key, tiktok_video_id) VALUES('tiktok_url', 'https://vm.tiktok.com/abc', 'tt:900', '900')"
      ).run(),
      /UNIQUE/i,
    );
  } finally {
    await mf.dispose();
  }
});
