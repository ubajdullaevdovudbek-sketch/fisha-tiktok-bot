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
    await env.DB.prepare(
      "DELETE FROM webhook_updates WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')"
    ).run();
  }

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
  el("schedule").textContent="Расписание: "+s.schedule.start+"–"+s.schedule.end+" · "+s.timezone+" · лимит "+s.schedule.daily_limit+" в день";
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
  // The dashboard has its own read-only credential. It is deliberately
  // separate from WORKER_API_SECRET, which can claim and complete publishing jobs.
  if (path === "/api/control/status" || path === "/api/control/queue") {
    if (!env.CONTROL_READ_SECRET) {
      return json({ ok: false, error: "Read-only dashboard access is not configured" }, 503);
    }
    if (request.headers.get("Authorization") !== `Bearer ${env.CONTROL_READ_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  } else if (!env.WORKER_API_SECRET ||
      request.headers.get("Authorization") !== `Bearer ${env.WORKER_API_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (path === "/api/control/status" && request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT status, COUNT(*) AS n FROM videos GROUP BY status"
    ).all();
    const counts = Object.fromEntries((result.results || []).map(row => [row.status, Number(row.n)]));
    const local = localParts(new Date(), env.TIMEZONE || "Asia/Tashkent");
    const today = `${local.year}-${local.month}-${local.day}`;
    const publishedToday = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM videos WHERE status='published' AND published_local_date=?"
    ).bind(today).first();
    return json({
      ok: true,
      timezone: env.TIMEZONE || "Asia/Tashkent",
      schedule: { start: env.PUBLISH_START || "10:00", end: env.PUBLISH_END || "21:00", daily_limit: Number(env.POSTS_PER_DAY || 3) },
      counts: {
        queued: counts.queued || 0,
        processing: counts.processing || 0,
        published: counts.published || 0,
        failed: counts.failed || 0,
        published_today: Number(publishedToday?.n || 0)
      }
    });
  }

  if (path === "/api/control/queue" && request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT id, kind, status, created_at, published_at, error FROM videos WHERE status IN ('queued','processing','failed') ORDER BY id DESC LIMIT 30"
    ).all();
    return json({ ok: true, items: result.results || [] });
  }

  if (path === "/api/claim" && request.method === "POST") {
    const job = await claimJob(env);
    return job ? json({ job }) : new Response(null, { status: 204 });
  }

  if (path === "/api/complete" && request.method === "POST") {
    const body = await request.json();
    const local = localParts(new Date(), env.TIMEZONE || "Asia/Tashkent");
    const day = `${local.year}-${local.month}-${local.day}`;
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ ok: false, error: "Invalid video ID" }, 400);
    const result = await env.DB.prepare(
      "UPDATE videos SET status='published', claimed_at=NULL, published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), published_local_date=?, error=NULL WHERE id=? AND status='processing'"
    ).bind(day, id).run();
    if (!result.meta?.changes) return json({ ok: false, error: "Video is not currently processing" }, 409);
    return json({ ok: true });
  }

  if (path === "/api/fail" && request.method === "POST") {
    const body = await request.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return json({ ok: false, error: "Invalid video ID" }, 400);
    const result = await env.DB.prepare(
      "UPDATE videos SET status='failed', claimed_at=NULL, error=? WHERE id=? AND status='processing'"
    ).bind(String(body.error || "Unknown error").slice(0, 500), id).run();
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
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        }
      });
    }
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      return handleTelegram(request, env);
    }
    if (url.pathname.startsWith("/api/")) return api(request, env, url.pathname);
    return new Response("Not found", { status: 404 });
  },
};
