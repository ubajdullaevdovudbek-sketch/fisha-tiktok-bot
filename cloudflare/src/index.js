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


function parseTikTokIdentity(input) {
  const match = String(input || "").match(/(?:https?:\/\/)?(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s<>"']+/i);
  if (!match) return null;
  let raw = match[0].replace(/[),.!?;]+$/g, "");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!(host === "tiktok.com" || host.endsWith(".tiktok.com"))) return null;
  const path = parsed.pathname.replace(/\/+$/g, "") || "/";
  const videoId = path.match(/\/video\/(\d+)/i)?.[1] || null;
  const sourceKey = videoId ? `tt:${videoId}` : `url:${host}${path.toLowerCase()}`;
  return { url: parsed.toString(), sourceKey, videoId };
}

function isRetryableBeforeDelivery(message) {
  return /timeout|timed out|temporar|connection|network|reset|econn|dns|\b429\b|\b5\d\d\b|rate.?limit|remote end closed|incomplete read|socket|try again|\b502\b|\b503\b|\b504\b/i.test(String(message || ""));
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
      "SELECT id, kind, created_at, attempt_count, next_attempt_at FROM videos WHERE status='queued' ORDER BY force_publish DESC, id LIMIT 20"
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
    const dispatch = result.meta?.changes ? await dispatchPublisher(env) : { dispatched: false };
    await reply(env, chatId, result.meta?.changes
      ? dispatch.dispatched
        ? "Следующее задание поднято в начало очереди; немедленный запуск обработчика запрошен."
        : "Следующее задание поднято в начало очереди. Его подхватит плановый обработчик; немедленный запуск требует GITHUB_ACTIONS_TOKEN."
      : "Очередь пуста.");
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
      "UPDATE videos SET status='queued', claimed_at=NULL, publishing_started_at=NULL, attempt_count=0, next_attempt_at=NULL, album_next_offset=?, album_pending_offset=NULL, error=NULL WHERE id=? AND status='failed' AND album_pending_offset=? AND album_total_count=?"
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
      "UPDATE videos SET status='queued', claimed_at=NULL, publishing_started_at=NULL, attempt_count=0, next_attempt_at=NULL, error=NULL WHERE id=? AND status='failed' AND album_pending_offset IS NULL AND (error IS NULL OR error NOT LIKE 'UNCERTAIN DELIVERY:%' OR ?=1)"
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
      ? "Видео принято. Немедленный запуск обработчика запрошен."
      : "Видео принято в очередь. Его подхватит плановый обработчик.");
    return json({ ok: true, dispatched: dispatch.dispatched });
  }

  if (text.includes("tiktok.com/")) {
    const identity = parseTikTokIdentity(text);
    if (!identity) {
      await reply(env, chatId, "Не удалось разобрать ссылку TikTok. Пришли полную ссылку ещё раз.");
      return json({ ok: true });
    }
    const duplicate = await env.DB.prepare(
      "SELECT id, status FROM videos WHERE source_key=? OR (? IS NOT NULL AND tiktok_video_id=?) OR (? IS NOT NULL AND source_url LIKE ?) ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'processing' THEN 1 WHEN 'published' THEN 2 ELSE 3 END, id DESC LIMIT 1"
    ).bind(identity.sourceKey, identity.videoId, identity.videoId, identity.videoId,
      identity.videoId ? `%/video/${identity.videoId}%` : null).first();
    if (duplicate) {
      durableSideEffectCommitted = true;
      await reply(env, chatId, `Эта ссылка уже есть в системе: задание #${duplicate.id} (статус: ${duplicate.status}). Повторно не добавляю.`);
      return json({ ok: true, duplicate: true, id: duplicate.id });
    }
    const inserted = await env.DB.prepare(
      "INSERT OR IGNORE INTO videos(kind, source_url, source_key, tiktok_video_id) VALUES('tiktok_url', ?, ?, ?)"
    ).bind(identity.url, identity.sourceKey, identity.videoId).run();
    if (!inserted.meta?.changes) {
      const existing = await env.DB.prepare(
        "SELECT id, status FROM videos WHERE source_key=? LIMIT 1"
      ).bind(identity.sourceKey).first();
      durableSideEffectCommitted = true;
      await reply(env, chatId, existing
        ? `Эта ссылка уже есть: задание #${existing.id} (статус: ${existing.status}). Повторно не добавляю.`
        : "Ссылка уже была добавлена параллельно. Повторно не добавляю.");
      return json({ ok: true, duplicate: true, id: existing?.id || null });
    }
    durableSideEffectCommitted = true;
    const jobId = Number(inserted.meta?.last_row_id);
    const keyboard = Number.isSafeInteger(jobId) && jobId > 0 ? {
      inline_keyboard: [[{ text: "Опубликовать сейчас", callback_data: `publish:${jobId}` }]],
    } : null;
    const dispatch = await dispatchPublisher(env);
    const statusText = dispatch.dispatched
      ? "Ссылка принята. Запросил немедленный запуск обработчика; обычно это быстрее пяти минут, но старт GitHub Actions и загрузка TikTok зависят от внешних сервисов."
      : dispatch.reason === "token_missing"
        ? "Ссылка принята и поставлена в очередь. Её подхватит обработчик по расписанию; для немедленного запуска нужен Worker secret GITHUB_ACTIONS_TOKEN."
        : "Ссылка принята и поставлена в очередь. Не удалось запросить внеплановый запуск; её подхватит плановый обработчик.";
    await reply(env, chatId, statusText, keyboard);
    return json({ ok: true, dispatched: dispatch.dispatched, id: jobId });
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
  // A runner abandoned before Telegram send can be retried, but only three
  // total claims are allowed. Once delivery starts, never retry automatically.
  await env.DB.prepare(
    "UPDATE videos SET status=CASE WHEN attempt_count < 3 THEN 'queued' ELSE 'failed' END, claimed_at=NULL, next_attempt_at=CASE WHEN attempt_count < 3 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute') ELSE NULL END, error=CASE WHEN attempt_count < 3 THEN 'Runner stopped before Telegram delivery; retry scheduled' ELSE 'Retry limit reached after runner stopped before Telegram delivery' END WHERE status='processing' AND publishing_started_at IS NULL AND claimed_at IS NOT NULL AND julianday(claimed_at) < julianday('now', '-20 minutes')"
  ).run();
  await env.DB.prepare(
    "UPDATE videos SET status='failed', claimed_at=NULL, next_attempt_at=NULL, error='UNCERTAIN DELIVERY: runner stopped after Telegram delivery started; check the channel before /retry' WHERE status='processing' AND publishing_started_at IS NOT NULL AND julianday(publishing_started_at) < julianday('now', '-20 minutes')"
  ).run();

  const candidate = await env.DB.prepare(
    "SELECT * FROM videos WHERE status='queued' AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday('now')) ORDER BY force_publish DESC, id LIMIT 1"
  ).first();
  if (!candidate) return null;

  const changed = await env.DB.prepare(
    "UPDATE videos SET status='processing', force_publish=0, attempt_count=attempt_count+1, next_attempt_at=NULL, claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error=NULL WHERE id=? AND status='queued' AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday('now'))"
  ).bind(candidate.id).run();
  if (!changed.meta?.changes) return null;
  return candidate;
}

const controlPage = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Fisha Bot — панель</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10141b;color:#eef2f7}
body{max-width:850px;margin:0 auto;padding:24px}
h1{font-size:25px}h2{font-size:18px;margin:0 0 12px}
.card{background:#1b2330;border:1px solid #303b4c;border-radius:14px;padding:16px;margin:14px 0}
input,button{font:inherit;border-radius:9px;padding:11px}
input{width:min(100%,420px);box-sizing:border-box;background:#0e141d;color:white;border:1px solid #46546a}
button{background:#8ab4ff;color:#101722;border:0;font-weight:700;cursor:pointer;margin:8px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.metric{background:#111923;padding:12px;border-radius:10px}.num{font-size:25px;font-weight:700}
.muted{color:#aab6c7;font-size:13px}.item{padding:10px 0;border-top:1px solid #303b4c;overflow-wrap:anywhere}
.error{color:#ff9b9b} .ok{color:#9fe0b2}
</style>
</head>
<body>
<h1>Fisha TikTok → Telegram</h1>
<p class="muted">Панель только для просмотра. Она не публикует видео и не меняет очередь.</p>
<section class="card">
<h2>Подключение</h2>
<input id="key" type="password" autocomplete="off" placeholder="Отдельный ключ панели (CONTROL_READ_SECRET)">
<br><button id="connect">Подключиться</button>
<button id="refresh" hidden>Обновить</button>
<p id="message" class="muted" aria-live="polite">Ключ используется только в памяти этой вкладки и не сохраняется.</p>
</section>
<div id="dashboard" hidden>
<section class="card"><h2>Состояние</h2><div id="metrics" class="grid"></div><p id="schedule" class="muted"></p></section>
<section class="card"><h2>Очередь и ошибки</h2><div id="items"></div></section>
</div>
<script>
let readKey="";
const el=id=>document.getElementById(id);
function say(t,kind="muted"){el("message").textContent=t;el("message").className=kind}
async function api(path){
 const r=await fetch(path,{headers:{Authorization:"Bearer "+readKey},cache:"no-store"});
 if(!r.ok) throw new Error(r.status===503?"Доступ панели ещё не настроен на сервере.":r.status===401?"Неверный ключ панели.":"Ошибка сервера: "+r.status);
 return r.json();
}
async function load(){
 try{
  const [s,q]=await Promise.all([api("/api/control/status"),api("/api/control/queue")]);
  const labels={queued:"В очереди",processing:"В обработке",published:"Опубликовано всего",failed:"С ошибками","published_today":"Опубликовано сегодня"};
  el("metrics").innerHTML=Object.entries(labels).map(([k,v])=>'<div class="metric"><div class="muted">'+v+'</div><div class="num">'+(s.counts[k]??0)+'</div></div>').join("");
  el("schedule").textContent="Режим: публикация без временного окна и дневного лимита · "+s.timezone;
  el("items").innerHTML=q.items.length?q.items.map(x=>'<div class="item"><b>#'+x.id+' · '+x.status+'</b><div class="muted">'+x.kind+' · '+(x.created_at||"")+'</div>'+(x.error?'<div class="error">'+String(x.error).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))+'</div>':"")+'</div>').join(""):'<p class="muted">Нет ожидающих или ошибочных видео.</p>';
  el("dashboard").hidden=false;el("refresh").hidden=false;say("Данные обновлены.","ok");
 }catch(e){el("dashboard").hidden=true;say(e.message,"error")}
}
el("connect").addEventListener("click",()=>{readKey=el("key").value.trim();if(!readKey){say("Введите ключ панели.","error");return}load()});
el("refresh").addEventListener("click",load);
window.addEventListener("pagehide",()=>{readKey="";el("key").value=""});
</script>
</body></html>`;

async function api(request, env, path) {
  if (path === "/api/control/status" || path === "/api/control/queue") {
    if (!env.CONTROL_READ_SECRET) return json({ ok: false, error: "Read-only dashboard access is not configured" }, 503);
    if (request.headers.get("Authorization") !== `Bearer ${env.CONTROL_READ_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  } else if (!env.WORKER_API_SECRET ||
      request.headers.get("Authorization") !== `Bearer ${env.WORKER_API_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (path === "/api/control/status" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM videos GROUP BY status").all();
    const counts = Object.fromEntries((result.results || []).map(row => [row.status, Number(row.n)]));
    const local = localParts(new Date(), env.TIMEZONE || "Asia/Tashkent");
    const today = `${local.year}-${local.month}-${local.day}`;
    const publishedToday = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM videos WHERE status='published' AND published_local_date=?"
    ).bind(today).first();
    return json({
      ok: true,
      timezone: env.TIMEZONE || "Asia/Tashkent",
      schedule: { mode: "unrestricted" },
      counts: {
        queued: counts.queued || 0,
        processing: counts.processing || 0,
        published: counts.published || 0,
        failed: counts.failed || 0,
        published_today: Number(publishedToday?.n || 0),
      },
    });
  }

  if (path === "/api/control/queue" && request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT id, kind, status, created_at, published_at, error, attempt_count, next_attempt_at FROM videos WHERE status IN ('queued','processing','failed') ORDER BY id DESC LIMIT 30"
    ).all();
    return json({ ok: true, items: result.results || [] });
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
    const errorText = String(body.error || "Unknown error").slice(0, 450);
    const retryable = isRetryableBeforeDelivery(errorText);
    const result = await env.DB.prepare(
      "UPDATE videos SET status=CASE WHEN publishing_started_at IS NULL AND attempt_count < 3 AND ?=1 THEN 'queued' ELSE 'failed' END, claimed_at=NULL, next_attempt_at=CASE WHEN publishing_started_at IS NULL AND attempt_count < 3 AND ?=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now', CASE attempt_count WHEN 1 THEN '+1 minute' ELSE '+5 minutes' END) ELSE NULL END, error=CASE WHEN publishing_started_at IS NULL AND attempt_count < 3 AND ?=1 THEN 'RETRY SCHEDULED: ' || ? WHEN publishing_started_at IS NOT NULL THEN 'UNCERTAIN DELIVERY: ' || ? ELSE ? END WHERE id=? AND status='processing'"
    ).bind(retryable ? 1 : 0, retryable ? 1 : 0, retryable ? 1 : 0, errorText, errorText, errorText, id).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Video is not currently processing" }, 409);
    return json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "fisha-tiktok-bot" });
    if (url.pathname === "/control" && request.method === "GET") {
      return new Response(controlPage, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      });
    }
    if (url.pathname === "/telegram/webhook" && request.method === "POST") return handleTelegram(request, env);
    if (url.pathname.startsWith("/api/")) return api(request, env, url.pathname);
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const queued = await env.DB.prepare(
        "SELECT id FROM videos WHERE status='queued' AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday('now')) AND NOT EXISTS (SELECT 1 FROM videos WHERE status='processing') LIMIT 1"
      ).first();
      if (queued) await dispatchPublisher(env);
    })());
  },
};