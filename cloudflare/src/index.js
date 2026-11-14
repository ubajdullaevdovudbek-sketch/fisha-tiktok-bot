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

async function reply(env, chatId, text, replyMarkup) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function dispatchPublisher(env) {
  if (!env.GITHUB_ACTIONS_TOKEN) return { dispatched: false, reason: "token_missing" };
  try {
    const response = await fetch(
      "https://api.github.com/repos/ubajdullaevdovudbek-sketch/fisha-tiktok-bot/actions/workflows/publish.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );
    if (response.status === 204) return { dispatched: true };
    console.error("GitHub Actions dispatch failed:", response.status);
    return { dispatched: false, reason: "dispatch_failed" };
  } catch (error) {
    console.error("GitHub Actions dispatch request failed:", error);
    return { dispatched: false, reason: "dispatch_failed" };
  }
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
  const callback = update.callback_query;
  const message = update.message;
  const actor = callback?.from || message?.from;
  const ownerId = String(env.OWNER_ID || "");
  if (!actor || String(actor.id) !== ownerId) return json({ ok: true });

  // Telegram retries webhook deliveries. Deduplicate both messages and button callbacks.
  if (Number.isSafeInteger(update.update_id)) {
    const seen = await env.DB.prepare(
      "INSERT OR IGNORE INTO webhook_updates(update_id) VALUES(?)"
    ).bind(update.update_id).run();
    if (!seen.meta?.changes) return json({ ok: true, duplicate: true });
    try {
      await env.DB.prepare(
        "DELETE FROM webhook_updates WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')"
      ).run();
    } catch (error) {
      console.warn("Webhook update retention cleanup failed:", error);
    }
  }

  if (callback) {
    const match = /^publish:(\d+)$/.exec(String(callback.data || ""));
    if (!match) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Неизвестная команда" });
      return json({ ok: true });
    }
    const jobId = Number(match[1]);
    const prioritized = await env.DB.prepare(
      "UPDATE videos SET force_publish=1 WHERE id=? AND status='queued'"
    ).bind(jobId).run();
    if (!prioritized.meta?.changes) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Задание уже обрабатывается или опубликовано" });
      return json({ ok: true });
    }
    const dispatch = await dispatchPublisher(env);
    const messageText = dispatch.dispatched
      ? `Задание #${jobId} передано на немедленный запуск обработчика. Старт GitHub Actions всё равно может занять некоторое время.`
      : dispatch.reason === "token_missing"
        ? `Задание #${jobId} поднято в начало очереди. Для запуска без ожидания расписания ещё нужен секрет GITHUB_ACTIONS_TOKEN в Worker; пока обработчик подхватит его по расписанию.`
        : `Задание #${jobId} поднято в начало очереди, но GitHub не подтвердил запуск. Оно останется в очереди для планового обработчика.`;
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: dispatch.dispatched ? "Запуск запрошен" : "Очередь обновлена" });
    if (callback.message?.chat?.id) await reply(env, callback.message.chat.id, messageText);
    return json({ ok: true, dispatched: dispatch.dispatched });
  }

  if (!message || !message.chat || !message.from) return json({ ok: true });

  const chatId = message.chat.id;
  const text = String(message.text || "").trim();
  let durableSideEffectCommitted = false;

  try {
  if (text === "/start") {
    await reply(env, chatId, "Бот подключён. Пришли ссылку TikTok или видео. Команды: /status, /queue, /audio-queue, /publish, /retry ID, /retry-audio ID");
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

  if (text === "/audio-queue") {
    const result = await env.DB.prepare(
      "SELECT id, video_id, title, status FROM audio_jobs WHERE status IN ('queued', 'processing', 'failed') ORDER BY id LIMIT 20"
    ).all();
    const rows = result.results || [];
    await reply(env, chatId, rows.length
      ? "Очередь аудио:\\n" + rows.map(x => `#${x.id} — ${x.status} (видео #${x.video_id})`).join("\\n")
      : "Очередь аудио пуста.");
    return json({ ok: true });
  }
  if (text === "/publish") {
    const result = await env.DB.prepare(
      "UPDATE videos SET force_publish=1 WHERE id=(SELECT id FROM videos WHERE status='queued' ORDER BY id LIMIT 1)"
    ).run();
    durableSideEffectCommitted = Boolean(result.meta?.changes);
    if (!result.meta?.changes) {
      await reply(env, chatId, "Очередь пуста.");
      return json({ ok: true });
    }
    const dispatch = await dispatchPublisher(env);
    await reply(env, chatId, dispatch.dispatched
      ? "Следующее задание поднято в начало очереди. Запросил немедленный запуск обработчика."
      : dispatch.reason === "token_missing"
        ? "Следующее задание поднято в начало очереди. Нет GITHUB_ACTIONS_TOKEN — обработчик заберёт его по расписанию."
        : "Следующее задание поднято в начало очереди, но GitHub не подтвердил запуск. Оно останется в очереди для планового обработчика.");
    return json({ ok: true, dispatched: dispatch.dispatched });
  }

  if (text === "/retry-photo" || text.startsWith("/retry-photo ")) {
    const parts = text.split(/\s+/);
    const id = Number(parts[1]);
    const confirm = parts[2]?.toUpperCase() === "CONFIRM";
    const nextOffset = Number(parts[3]);
    if (!Number.isSafeInteger(id) || id < 1 || !confirm ||
        !Number.isSafeInteger(nextOffset) || nextOffset < 0 || parts.length !== 4) {
      await reply(env, chatId, "Использование: /retry-photo ID CONFIRM NEXT_OFFSET. Сначала проверь канал. NEXT_OFFSET — начало спорной группы (повторить её) или следующий блок после неё (пропустить её).");
      return json({ ok: true });
    }
    const job = await env.DB.prepare(
      "SELECT album_pending_offset, album_total_count FROM videos WHERE id=? AND status='failed' AND kind='tiktok_url' AND error LIKE 'UNCERTAIN DELIVERY:%'"
    ).bind(id).first();
    if (!job || job.album_pending_offset == null || job.album_total_count == null) {
      await reply(env, chatId, "Не найдено Photo Mode-задание с неясной отправкой. Проверь ID и статус.");
      return json({ ok: true });
    }
    const pending = Number(job.album_pending_offset);
    const total = Number(job.album_total_count);
    const nextAfterBatch = Math.min(pending + 10, total);
    if (nextOffset !== pending && nextOffset !== nextAfterBatch) {
      await reply(env, chatId, `Допустимы только ${pending} (повторить спорную группу) или ${nextAfterBatch} (пропустить её). Всего фото: ${total}.`);
      return json({ ok: true });
    }
    const result = await env.DB.prepare(
      "UPDATE videos SET status='queued', claimed_at=NULL, publishing_started_at=NULL, album_next_offset=?, album_pending_offset=NULL, error=NULL WHERE id=? AND status='failed' AND album_pending_offset=? AND album_total_count=?"
    ).bind(nextOffset, id, pending, total).run();
    durableSideEffectCommitted = Boolean(result.meta?.changes);
    await reply(env, chatId, result.meta?.changes
      ? `Photo Mode #${id} возвращён в очередь с изображения ${nextOffset + 1} из ${total}.`
      : "Состояние задания изменилось. Обнови /status и проверь задание перед повтором.");
    return json({ ok: true });
  }

  if (text === "/retry" || text.startsWith("/retry ")) {
    const parts = text.split(/\s+/);
    const id = Number(parts[1]);
    const confirmUncertain = parts[2]?.toUpperCase() === "CONFIRM";
    if (!Number.isInteger(id) || id < 1 || parts.length > 3 ||
        (parts.length === 3 && !confirmUncertain)) {
      await reply(env, chatId, "Использование: /retry ID [CONFIRM]. CONFIRM нужен только для UNCERTAIN DELIVERY после проверки канала.");
      return json({ ok: true });
    }
    const result = await env.DB.prepare(
      "UPDATE videos SET status='queued', claimed_at=NULL, publishing_started_at=NULL, error=NULL WHERE id=? AND status='failed' AND album_pending_offset IS NULL AND (error IS NULL OR error NOT LIKE 'UNCERTAIN DELIVERY:%' OR ?=1)"
    ).bind(id, confirmUncertain ? 1 : 0).run();
    durableSideEffectCommitted = Boolean(result.meta?.changes);
    await reply(env, chatId, result.meta?.changes
      ? `Видео #${id} возвращено в очередь.`
      : "Обычная ошибка не найдена. Для Photo Mode с неясной группой используй /retry-photo ID CONFIRM NEXT_OFFSET после проверки канала; для остальных UNCERTAIN DELIVERY — /retry ID CONFIRM.");
    return json({ ok: true });
  }

  if (text === "/retry-audio" || text.startsWith("/retry-audio ")) {
    const parts = text.split(/\s+/);
    const id = Number(parts[1]);
    const confirmUncertain = parts[2]?.toUpperCase() === "CONFIRM";
    if (!Number.isInteger(id) || id < 1 || parts.length > 3 ||
        (parts.length === 3 && !confirmUncertain)) {
      await reply(env, chatId, "Использование: /retry-audio ID [CONFIRM]. CONFIRM нужен только для UNCERTAIN DELIVERY после проверки канала.");
      return json({ ok: true });
    }
    const result = await env.DB.prepare(
      "UPDATE audio_jobs SET status='queued', claimed_at=NULL, audio_started_at=NULL, error=NULL WHERE id=? AND status='failed' AND (error IS NULL OR error NOT LIKE 'UNCERTAIN DELIVERY:%' OR ?=1)"
    ).bind(id, confirmUncertain ? 1 : 0).run();
    durableSideEffectCommitted = Boolean(result.meta?.changes);
    await reply(env, chatId, result.meta?.changes
      ? `Аудиозадание #${id} возвращено в очередь.`
      : "Обычная ошибка не найдена. Если это UNCERTAIN DELIVERY, сначала проверь канал, затем используй /retry-audio ID CONFIRM.");
    return json({ ok: true });
  }

  if (message.video?.file_id) {
    await env.DB.prepare(
      "INSERT INTO videos(kind, telegram_file_id, source_caption) VALUES('telegram_file', ?, ?)"
    ).bind(message.video.file_id, message.caption || "").run();
    durableSideEffectCommitted = true;
    const dispatch = await dispatchPublisher(env);
    await reply(env, chatId, dispatch.dispatched
      ? "Видео принято. Запросил немедленный запуск публикации."
      : dispatch.reason === "token_missing"
        ? "Видео принято в очередь. Для немедленного запуска нужен секрет GITHUB_ACTIONS_TOKEN; пока обработчик подхватит его по расписанию."
        : "Видео принято в очередь. Не удалось запросить внеплановый запуск, поэтому его подхватит плановый обработчик.");
    return json({ ok: true, dispatched: dispatch.dispatched });
  }

  if (text.includes("tiktok.com/")) {
    const inserted = await env.DB.prepare(
      "INSERT INTO videos(kind, source_url) VALUES('tiktok_url', ?)"
    ).bind(text).run();
    durableSideEffectCommitted = true;
    const jobId = Number(inserted.meta?.last_row_id);
    const keyboard = Number.isSafeInteger(jobId) && jobId > 0 ? {
      inline_keyboard: [[{ text: "Опубликовать сейчас", callback_data: `publish:${jobId}` }]],
    } : null;
    const dispatch = await dispatchPublisher(env);
    const statusText = dispatch.dispatched
      ? "Ссылка принята. Я запросил внеплановый запуск обработчика — публикация начнётся после старта GitHub Actions и загрузки видео."
      : dispatch.reason === "token_missing"
        ? "Ссылка принята и поставлена в очередь. Сейчас обработчик запустится по расписанию; для запуска сразу ещё нужен секрет GITHUB_ACTIONS_TOKEN в Worker."
        : "Ссылка принята и поставлена в очередь. Не удалось запросить внеплановый запуск, поэтому её подхватит плановый обработчик.";
    await reply(env, chatId, statusText, keyboard);
    return json({ ok: true, dispatched: dispatch.dispatched });
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

  if (path === "/api/photo-batch-start" && request.method === "POST") {
    const body = await request.json();
    const id = Number(body.id);
    const offset = Number(body.offset);
    const total = Number(body.total_count);
    if (!Number.isSafeInteger(id) || id < 1 ||
        !Number.isSafeInteger(offset) || offset < 0 || offset % 10 !== 0 ||
        !Number.isSafeInteger(total) || total < 1 || offset >= total) {
      return json({ ok: false, error: "Invalid photo batch start" }, 400);
    }
    const result = await env.DB.prepare(
      "UPDATE videos SET album_pending_offset=?, album_total_count=?, publishing_started_at=COALESCE(publishing_started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=? AND status='processing' AND kind='tiktok_url' AND album_pending_offset IS NULL AND album_next_offset=? AND (album_total_count IS NULL OR album_total_count=?)"
    ).bind(offset, total, id, offset, total).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Photo batch state conflict" }, 409);
    return json({ ok: true, pending_offset: offset, total_count: total });
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
      "UPDATE videos SET album_next_offset=MAX(album_next_offset, ?), album_pending_offset=NULL WHERE id=? AND status='processing' AND kind='tiktok_url' AND album_pending_offset IS NOT NULL AND ? > album_pending_offset AND ? <= album_total_count"
    ).bind(nextOffset, id, nextOffset, nextOffset).run();
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