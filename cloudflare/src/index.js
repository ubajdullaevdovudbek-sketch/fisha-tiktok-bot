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

  const chatId = message.chat.id;
  const text = String(message.text || "").trim();

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
      `В очереди: ${counts.queued || 0}\nВ обработке: ${counts.processing || 0}\nОпубликовано: ${counts.published || 0}\nОшибки: ${counts.failed || 0}`);
    return json({ ok: true });
  }

  if (text === "/queue") {
    const result = await env.DB.prepare(
      "SELECT id, kind, created_at FROM videos WHERE status='queued' ORDER BY id LIMIT 20"
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
    await reply(env, chatId, result.meta?.changes
      ? "Для следующего видео включена внеочередная публикация."
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
      "UPDATE videos SET status='queued', error=NULL WHERE id=? AND status='failed'"
    ).bind(id).run();
    await reply(env, chatId, result.meta?.changes
      ? `Видео #${id} возвращено в очередь.`
      : "Не найдено видео с ошибкой.");
    return json({ ok: true });
  }

  if (message.video?.file_id) {
    await env.DB.prepare(
      "INSERT INTO videos(kind, telegram_file_id, source_caption) VALUES('telegram_file', ?, ?)"
    ).bind(message.video.file_id, message.caption || "").run();
    await reply(env, chatId, "Видео принято в очередь.");
    return json({ ok: true });
  }

  if (text.includes("tiktok.com/")) {
    await env.DB.prepare(
      "INSERT INTO videos(kind, source_url) VALUES('tiktok_url', ?)"
    ).bind(text).run();
    await reply(env, chatId, "Ссылка принята. Видео будет скачано и поставлено в очередь публикации.");
    return json({ ok: true });
  }

  await reply(env, chatId, "Пришли ссылку TikTok или видеофайл.");
  return json({ ok: true });
}

async function claimJob(env) {
  // Recover claims abandoned by a timed-out or terminated GitHub Actions runner.
  await env.DB.prepare(
    "UPDATE videos SET status='queued', claimed_at=NULL WHERE status='processing' AND claimed_at IS NOT NULL AND julianday(claimed_at) < julianday('now', '-20 minutes')"
  ).run();

  const now = new Date();
  const timeZone = env.TIMEZONE || "Asia/Tashkent";
  const local = localParts(now, timeZone);
  const today = `${local.year}-${local.month}-${local.day}`;
  const currentMinute = Number(local.hour) * 60 + Number(local.minute);
  const start = minutes(env.PUBLISH_START || "10:00");
  const end = minutes(env.PUBLISH_END || "21:00");
  const inWindow = end > start
    ? currentMinute >= start && currentMinute <= end
    : currentMinute >= start || currentMinute <= end;

  const candidate = await env.DB.prepare(
    "SELECT * FROM videos WHERE status='queued' ORDER BY id LIMIT 1"
  ).first();
  if (!candidate) return null;

  const force = Number(candidate.force_publish) === 1;
  if (!force && !inWindow) return null;

  const dailyLimit = Math.max(1, Number(env.POSTS_PER_DAY || 3));
  const published = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM videos WHERE status='published' AND published_local_date=?"
  ).bind(today).first();
  if (!force && Number(published?.n || 0) >= dailyLimit) return null;

  if (!force && Number(published?.n || 0) > 0) {
    const last = await env.DB.prepare(
      "SELECT published_at FROM videos WHERE status='published' ORDER BY published_at DESC LIMIT 1"
    ).first();
    const windowLength = end > start ? end - start : 1440 - start + end;
    const spacingMs = Math.floor(windowLength / dailyLimit) * 60_000;
    if (last?.published_at && now.getTime() - Date.parse(last.published_at) < spacingMs) return null;
  }

  const changed = await env.DB.prepare(
    "UPDATE videos SET status='processing', claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error=NULL WHERE id=? AND status='queued'"
  ).bind(candidate.id).run();
  if (!changed.meta?.changes) return null;
  return candidate;
}

async function api(request, env, path) {
  if (!env.WORKER_API_SECRET ||
      request.headers.get("Authorization") !== `Bearer ${env.WORKER_API_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (path === "/api/claim" && request.method === "POST") {
    const job = await claimJob(env);
    return job ? json({ job }) : new Response(null, { status: 204 });
  }

  if (path === "/api/complete" && request.method === "POST") {
    const body = await request.json();
    const local = localParts(new Date(), env.TIMEZONE || "Asia/Tashkent");
    const day = `${local.year}-${local.month}-${local.day}`;
    await env.DB.prepare(
      "UPDATE videos SET status='published', claimed_at=NULL, published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), published_local_date=?, error=NULL WHERE id=? AND status='processing'"
    ).bind(day, Number(body.id)).run();
    return json({ ok: true });
  }

  if (path === "/api/fail" && request.method === "POST") {
    const body = await request.json();
    await env.DB.prepare(
      "UPDATE videos SET status='failed', claimed_at=NULL, error=? WHERE id=? AND status='processing'"
    ).bind(String(body.error || "Unknown error").slice(0, 500), Number(body.id)).run();
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
