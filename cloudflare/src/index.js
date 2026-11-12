const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Telegram API ${method}: ${response.status}`);
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram API ${method}: ${data.description || "request failed"}`);
  return data;
}

async function reply(env, chatId, text) {
  return telegram(env, "sendMessage", { chat_id: chatId, text });
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
}

function minutes(value) {
  const [h, m] = String(value).split(":").map(Number);
  return h * 60 + m;
}

async function handleTelegram(request, env) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const update = await request.json();
  const message = update.message;
  if (!message || !message.chat || !message.from) return json({ ok: true });

  const ownerId = String(env.OWNER_ID || "");
  if (String(message.from.id) !== ownerId) return json({ ok: true });

  // Telegram retries webhook deliveries. Record update IDs before side effects
  // so the same message cannot be queued or answered twice.
  if (Number.isSafeInteger(update.update_id)) {
    const seen = await env.DB.prepare(
      "INSERT OR IGNORE INTO webhook_updates(update_id) VALUES(?)"
    ).bind(update.update_id).run();
    if (!seen.meta?.changes) return json({ ok: true, duplicate: true });
    // Retention cleanup must never prevent the newly recorded update from
    // being handled: Telegram retries would otherwise be rejected as duplicates.
    try {
      await env.DB.prepare(
        "DELETE FROM webhook_updates WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')"
      ).run();
    } catch (error) {
      console.warn("Webhook update retention cleanup failed:", error);
    }
  }

  const chatId = message.chat.id;
  const text = String(message.text || "").trim();
  let durableSideEffectCommitted = false;

  try {
  if (text === "/start") {
    await reply(env, chatId, "Бот подключён. Пришли ссылку TikTok или видео. Команды: /status, /queue, /publish, /retry ID");
    return json({ ok: true });
  }

  if (text === "/status") {
    const result = await env.DB.prepare(
      "SELECT status, COUNT(*) AS n FROM videos GROUP BY status"
    ).all();
    const counts = Object.fromEntries((result.results || []).map(x => [x.status, x.n]));
    await reply(env, chatId,
      `В очереди: ${counts.queued || 0}\nВ обработке: ${counts.processing || 0}\nОпубликовано: ${counts.published || 0}\nОшибки: ${counts.failed || 0}\nОшибки включают задания с неясным результатом отправки`);
    return json({ ok: true });
  }

  if (text === "/queue") {
    const result = await env.DB.prepare(
      "SELECT id, kind, created_at FROM videos WHERE status='queued' ORDER BY force_publish DESC, id LIMIT 20"
    ).all();
    const rows = result.results || [];
    await reply(env, chatId, rows.length
      ? "Очередь:\n" + rows.map(x => `#${x.id} — ${x.kind}`).join("\n")
      : "Очередь пуста.");
    return json({ ok: true });
  }

  if (text === "/publish") {
    const result = await env.DB.prepare(
      "UPDATE videos SET force_publish=1 WHERE id=(SELECT id FROM videos WHERE status='queued' ORDER BY id LIMIT 1)"
    ).run();
    durableSideEffectCommitted = Boolean(result.meta?.changes);
    await reply(env, chatId, result.meta?.changes
      ? "Следующее задание поднято в начало очереди. Обработчик заберёт его при ближайшем запуске GitHub Actions; расписание может задержаться."
      : "Очередь пуста.");
    return json({ ok: true });
  }

  if (text.startsWith("/retry")) {
    const id = Number(text.split(/\s+/)[1]);
    if (!Number.isInteger(id) || id < 1) {
      await reply(env, chatId, "Использование: /retry ID");
      return json({ ok: true });
    }
    const result = await env.DB.prepare(
      "UPDATE videos SET status='queued', claimed_at=NULL, publishing_started_at=NULL, error=NULL WHERE id=? AND status='failed'"
    ).bind(id).run();
    durableSideEffectCommitted = Boolean(result.meta?.changes);
    await reply(env, chatId, result.meta?.changes
      ? `Видео #${id} возвращено в очередь. Убедись, что предыдущая попытка не опубликовала его.`
      : "Не найдено видео с ошибкой.");
    return json({ ok: true });
  }

  if (message.video?.file_id) {
    await env.DB.prepare(
      "INSERT INTO videos(kind, telegram_file_id, source_caption) VALUES('telegram_file', ?, ?)"
    ).bind(message.video.file_id, message.caption || "").run();
    durableSideEffectCommitted = true;
    await reply(env, chatId, "Видео принято в очередь.");
    return json({ ok: true });
  }

  if (text.includes("tiktok.com/")) {
    await env.DB.prepare(
      "INSERT INTO videos(kind, source_url) VALUES('tiktok_url', ?)"
    ).bind(text).run();
    durableSideEffectCommitted = true;
    await reply(env, chatId, "Ссылка принята. Видео будет скачано и поставлено в очередь публикации.");
    return json({ ok: true });
  }

  await reply(env, chatId, "Пришли ссылку TikTok или видеофайл.");
  return json({ ok: true });
  } catch (error) {
    // If processing failed before a durable command/queue change, release the
    // dedupe key so Telegram's retry can safely try this update again.
    if (Number.isSafeInteger(update.update_id) && !durableSideEffectCommitted) {
      try {
        await env.DB.prepare(
          "DELETE FROM webhook_updates WHERE update_id=?"
        ).bind(update.update_id).run();
      } catch (cleanupError) {
        console.error("Could not release failed webhook update:", cleanupError);
      }
    }
    throw error;
  }
}

async function claimJob(env) {
  // Recover claims abandoned by a timed-out or terminated GitHub Actions runner.
  await env.DB.prepare(
    "UPDATE videos SET status='queued', claimed_at=NULL WHERE status='processing' AND publishing_started_at IS NULL AND claimed_at IS NOT NULL AND julianday(claimed_at) < julianday('now', '-20 minutes')"
  ).run();
  await env.DB.prepare(
    "UPDATE videos SET status='failed', claimed_at=NULL, error='UNCERTAIN DELIVERY: runner stopped after Telegram delivery started; check the channel before /retry' WHERE status='processing' AND publishing_started_at IS NOT NULL AND julianday(publishing_started_at) < julianday('now', '-20 minutes')"
  ).run();

  // Honor the owner's /publish command before normal FIFO queue order.
  const candidate = await env.DB.prepare(
    "SELECT * FROM videos WHERE status='queued' ORDER BY force_publish DESC, id LIMIT 1"
  ).first();
  if (!candidate) return null;

  const changed = await env.DB.prepare(
    "UPDATE videos SET status='processing', force_publish=0, claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error=NULL WHERE id=? AND status='queued'"
  ).bind(candidate.id).run();
  if (!changed.meta?.changes) return null;
  return candidate;
}

async function api(request, env, path) {
  if (!env.WORKER_API_SECRET ||
      request.headers.get("Authorization") !== `Bearer ${env.WORKER_API_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }


  if (path === "/api/audio/enqueue" && request.method === "POST") {
    const body = await request.json();
    const videoId = Number(body.video_id);
    const kind = String(body.kind || "");
    const sourceUrl = String(body.source_url || "");
    const telegramFileId = String(body.telegram_file_id || "");
    const title = String(body.title || "TikTok audio").slice(0, 64);
    if (!Number.isSafeInteger(videoId) || videoId < 1 ||
        !["tiktok_url", "telegram_file"].includes(kind) ||
        (kind === "tiktok_url" && !sourceUrl) ||
        (kind === "telegram_file" && !telegramFileId)) {
      return json({ ok: false, error: "Invalid audio task" }, 400);
    }
    const result = await env.DB.prepare(
      "INSERT OR IGNORE INTO audio_jobs(video_id, kind, source_url, telegram_file_id, title) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM videos WHERE id=? AND status='published')"
    ).bind(videoId, kind, sourceUrl || null, telegramFileId || null, title, videoId).run();
    return json({ ok: true, enqueued: Boolean(result.meta?.changes) });
  }

  if (path === "/api/audio/claim" && request.method === "POST") {
    await env.DB.prepare(
      "UPDATE audio_jobs SET status='queued', claimed_at=NULL WHERE status='processing' AND audio_started_at IS NULL AND claimed_at IS NOT NULL AND julianday(claimed_at) < julianday('now', '-20 minutes')"
    ).run();
    await env.DB.prepare(
      "UPDATE audio_jobs SET status='failed', claimed_at=NULL, error='UNCERTAIN DELIVERY: audio send started but runner stopped; check the channel before manual retry' WHERE status='processing' AND audio_started_at IS NOT NULL AND julianday(audio_started_at) < julianday('now', '-20 minutes')"
    ).run();
    const candidate = await env.DB.prepare(
      "SELECT * FROM audio_jobs WHERE status='queued' ORDER BY id LIMIT 1"
    ).first();
    if (!candidate) return new Response(null, { status: 204 });
    const changed = await env.DB.prepare(
      "UPDATE audio_jobs SET status='processing', claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error=NULL WHERE id=? AND status='queued'"
    ).bind(candidate.id).run();
    if (!changed.meta?.changes) return new Response(null, { status: 204 });
    return json({ job: candidate });
  }

  if (path === "/api/audio/started" && request.method === "POST") {
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ ok: false, error: "Invalid audio job ID" }, 400);
    const result = await env.DB.prepare(
      "UPDATE audio_jobs SET audio_started_at=COALESCE(audio_started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=? AND status='processing'"
    ).bind(id).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Audio job is not processing" }, 409);
    return json({ ok: true });
  }

  if (path === "/api/audio/complete" && request.method === "POST") {
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ ok: false, error: "Invalid audio job ID" }, 400);
    const result = await env.DB.prepare(
      "UPDATE audio_jobs SET status='published', claimed_at=NULL, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error=NULL WHERE id=? AND status='processing'"
    ).bind(id).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Audio job is not processing" }, 409);
    return json({ ok: true });
  }

  if (path === "/api/audio/fail" && request.method === "POST") {
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ ok: false, error: "Invalid audio job ID" }, 400);
    const result = await env.DB.prepare(
      "UPDATE audio_jobs SET status='failed', claimed_at=NULL, error=CASE WHEN audio_started_at IS NOT NULL THEN 'UNCERTAIN DELIVERY: ' || ? ELSE ? END WHERE id=? AND status='processing'"
    ).bind(String(body.error || "Unknown audio error").slice(0, 450), String(body.error || "Unknown audio error").slice(0, 500), id).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Audio job is not processing" }, 409);
    return json({ ok: true });
  }

  if (path === "/api/claim" && request.method === "POST") {
    const job = await claimJob(env);
    return job ? json({ job }) : new Response(null, { status: 204 });
  }

  if (path === "/api/photo-progress" && request.method === "POST") {
    const body = await request.json();
    const id = Number(body.id);
    const nextOffset = Number(body.next_offset);
    if (!Number.isSafeInteger(id) || id < 1 ||
        !Number.isSafeInteger(nextOffset) || nextOffset < 1) {
      return json({ ok: false, error: "Invalid photo progress" }, 400);
    }
    const result = await env.DB.prepare(
      "UPDATE videos SET album_next_offset=MAX(album_next_offset, ?) WHERE id=? AND status='processing' AND kind='tiktok_url'"
    ).bind(nextOffset, id).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Photo job is not processing" }, 409);
    return json({ ok: true, next_offset: nextOffset });
  }

  if (path === "/api/started" && request.method === "POST") {
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ ok: false, error: "Invalid video ID" }, 400);
    const result = await env.DB.prepare(
      "UPDATE videos SET publishing_started_at=COALESCE(publishing_started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=? AND status='processing'"
    ).bind(id).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Video is not in the expected state" }, 409);
    return json({ ok: true });
  }

  if (path === "/api/complete" && request.method === "POST") {
    const body = await request.json();
    const local = localParts(new Date(), env.TIMEZONE || "Asia/Tashkent");
    const day = `${local.year}-${local.month}-${local.day}`;
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ ok: false, error: "Invalid video ID" }, 400);
    // Persist the optional audio task atomically with video completion. This
    // prevents a runner crash/API hiccup between /complete and /audio/enqueue
    // from permanently losing the MP3 task.
    const audioTask = body.audio_task;
    if (audioTask != null) {
      const kind = String(audioTask.kind || "");
      const sourceUrl = String(audioTask.source_url || "");
      const telegramFileId = String(audioTask.telegram_file_id || "");
      const title = String(audioTask.title || "TikTok audio").slice(0, 64);
      if (!["tiktok_url", "telegram_file"].includes(kind) ||
          (kind === "tiktok_url" && !sourceUrl) ||
          (kind === "telegram_file" && !telegramFileId)) {
        return json({ ok: false, error: "Invalid audio task" }, 400);
      }
      const insertAudio = env.DB.prepare(
        "INSERT OR IGNORE INTO audio_jobs(video_id, kind, source_url, telegram_file_id, title) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM videos WHERE id=? AND status='processing')"
      ).bind(id, kind, sourceUrl || null, telegramFileId || null, title, id);
      const updateVideo = env.DB.prepare(
        "UPDATE videos SET status='published', claimed_at=NULL, published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), published_local_date=?, error=NULL WHERE id=? AND status='processing'"
      ).bind(day, id);
      const results = await env.DB.batch([insertAudio, updateVideo]);
      if (!results[1]?.meta?.changes) return json({ ok: false, error: "Video is not in the expected state" }, 409);
      return json({ ok: true, audio_enqueued: Boolean(results[0]?.meta?.changes) });
    }

    const updateVideo = env.DB.prepare(
      "UPDATE videos SET status='published', claimed_at=NULL, published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), published_local_date=?, error=NULL WHERE id=? AND status='processing'"
    ).bind(day, id);
    const result = await updateVideo.run();
    if (!result.meta?.changes) return json({ ok: false, error: "Video is not in the expected state" }, 409);
    return json({ ok: true });
  }

  if (path === "/api/fail" && request.method === "POST") {
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ ok: false, error: "Invalid video ID" }, 400);
    const result = await env.DB.prepare(
      "UPDATE videos SET status='failed', claimed_at=NULL, error=CASE WHEN publishing_started_at IS NOT NULL THEN 'UNCERTAIN DELIVERY: ' || ? ELSE ? END WHERE id=? AND status='processing'"
    ).bind(String(body.error || "Unknown error").slice(0, 450), String(body.error || "Unknown error").slice(0, 500), id).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Video is not currently processing" }, 409);
    return json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "fisha-tiktok-bot" });
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      return handleTelegram(request, env);
    }
    if (url.pathname.startsWith("/api/")) return api(request, env, url.pathname);
    return new Response("Not found", { status: 404 });
  },
};