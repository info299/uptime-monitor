#!/usr/bin/env node
/**
 * Uptime pinger pro jankabes.cz
 * ------------------------------------------------------------------
 * SHRNUTÍ
 * Běží v GitHub Actions (tedy MIMO monitorovaný server — když spadne
 * Wedos, měřič běží dál). Pro každý web z konfigurace:
 *   1. změří HTTP status + odezvu (volitelně zkontroluje výskyt textu),
 *   2. při chybě zkusí ještě jednou (potvrzení, ať nealertuje na blik),
 *   3. výsledek POSTne na /uptime/ingest.php (historie pro dashboard),
 *   4. při ZMĚNĚ stavu (up→down, down→up) pošle Telegram alert.
 *
 * Stav mezi běhy se drží v STATE_FILE (v Actions přes actions/cache).
 * Když se cache ztratí, nanejvýš přijde jeden duplicitní alert.
 *
 * ENV: SITES_JSON | soubor sites.json, INGEST_URL, INGEST_TOKEN,
 *      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, STATE_FILE
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const UA = 'jankabes-uptime/1.0 (+https://www.jankabes.cz)';
const STATE_FILE = process.env.STATE_FILE || '.state/state.json';

// ---------- konfigurace ----------
function loadConfig() {
  if (process.env.SITES_JSON) {
    try {
      return JSON.parse(process.env.SITES_JSON);
    } catch (e) {
      fail(`SITES_JSON není platný JSON: ${e.message}`);
    }
  }
  if (existsSync('sites.json')) return JSON.parse(readFileSync('sites.json', 'utf8'));
  fail('Chybí konfigurace — nastav secret SITES_JSON nebo vytvoř lokální sites.json.');
}

function fail(msg) {
  console.error(`KONFIGURAČNÍ CHYBA: ${msg}`);
  process.exit(1);
}

const cfg = loadConfig();
const sites = Array.isArray(cfg.sites) ? cfg.sites : [];
if (!sites.length) fail('Konfigurace neobsahuje žádné weby.');

const TIMEOUT_MS = cfg.timeoutMs ?? 10000;
const RETRY_DELAY_MS = cfg.retryDelayMs ?? 4000;
const INTERVAL_MIN = cfg.intervalMinutes ?? 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- jedno měření ----------
async function probe(site) {
  const started = process.hrtime.bigint();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;

  try {
    const res = await fetch(site.url, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Cache-Control': 'no-cache' },
    });

    // Tělo čteme jen když ho potřebujeme — jinak spojení zavřeme.
    let body = '';
    if (site.mustContain) body = (await res.text()).slice(0, 300000);
    else await res.body?.cancel().catch(() => {});

    const ms = Math.round(elapsed());

    if (res.status >= 400) {
      return { ok: false, status: res.status, ms, err: `HTTP ${res.status}` };
    }
    if (site.mustContain && !body.includes(site.mustContain)) {
      return { ok: false, status: res.status, ms, err: `stránka neobsahuje „${site.mustContain}“` };
    }
    return { ok: true, status: res.status, ms, err: null };
  } catch (e) {
    const ms = Math.round(elapsed());
    const reason =
      e.name === 'AbortError'
        ? `timeout > ${TIMEOUT_MS} ms`
        : String(e.cause?.code || e.cause?.message || e.message).slice(0, 140);
    return { ok: false, status: 0, ms, err: reason };
  } finally {
    clearTimeout(timer);
  }
}

// Chybu vždy potvrdíme druhým pokusem — jeden zahozený paket není výpadek.
async function check(site) {
  let r = await probe(site);
  let attempts = 1;
  if (!r.ok) {
    await sleep(RETRY_DELAY_MS);
    r = await probe(site);
    attempts = 2;
  }
  return {
    site: site.label || new URL(site.url).hostname,
    url: site.url,
    ts: Math.floor(Date.now() / 1000),
    attempts,
    ...r,
  };
}

// ---------- stav mezi běhy ----------
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Telegram ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.log('[telegram] přeskočeno — chybí TELEGRAM_BOT_TOKEN nebo TELEGRAM_CHAT_ID');
    console.log(text.replace(/<[^>]+>/g, ''));
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`[telegram] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[telegram] selhalo: ${e.message}`);
    return false;
  }
}

const czTime = (ts) =>
  new Date(ts * 1000).toLocaleString('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function duration(fromTs, toTs) {
  const s = Math.max(0, toTs - fromTs);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

// ---------- odeslání do dashboardu ----------
const INGEST_TIMEOUT_MS = 25000;

async function ingestOnce(url, token, checks) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INGEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Uptime-Token': token,
        'User-Agent': UA,
      },
      body: JSON.stringify({ interval: INTERVAL_MIN, checks }),
    });
    const text = (await res.text()).slice(0, 300);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, text };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Zápis se stejně jako měření webu potvrzuje druhým pokusem. Sdílený hosting
// občas na pár vteřin zaškobrtne a jednorázový timeout není výpadek.
async function ingest(checks) {
  const url = process.env.INGEST_URL;
  const token = process.env.INGEST_TOKEN;
  if (!url || !token) {
    console.log('[ingest] přeskočeno — chybí INGEST_URL nebo INGEST_TOKEN');
    return { ok: false, skipped: true };
  }

  let r = await ingestOnce(url, token, checks);
  if (!r.ok) {
    console.error(`[ingest] 1. pokus selhal: ${r.error} — zkouším znovu`);
    await sleep(3000);
    r = await ingestOnce(url, token, checks);
  }

  if (r.ok) console.log(`[ingest] ok: ${r.text}`);
  else console.error(`[ingest] selhalo: ${r.error}`);
  return r;
}

// ---------- hlavní běh ----------
const checks = await Promise.all(sites.map(check));
const now = Math.floor(Date.now() / 1000);

for (const c of checks) {
  const line = c.ok
    ? `OK    ${c.site} — ${c.status}, ${c.ms} ms`
    : `DOWN  ${c.site} — ${c.err} (${c.attempts} pokusy)`;
  console.log(line);
}

const ingestResult = await ingest(checks);

// Alerty
const state = loadState();
const down = checks.filter((c) => !c.ok);
const messages = [];

// Když hlásí výpadek všechno, chyba je nejspíš na straně měřiče (síť runneru),
// ne u N webů zvlášť. Pošli jedno varování, ne N falešných alertů.
const allDown = checks.length > 1 && down.length === checks.length;

for (const c of checks) {
  const prev = state[c.url];
  const prevStatus = prev?.status;
  const curStatus = c.ok ? 'up' : 'down';

  if (prevStatus === curStatus) continue;

  if (curStatus === 'down' && !allDown) {
    messages.push(
      `🔴 <b>${esc(c.site)}</b> nedostupný\n` +
        `${esc(c.err)} · odezva ${c.ms} ms · ${c.attempts} pokusy\n` +
        `${esc(c.url)}\n` +
        `${czTime(c.ts)}`
    );
  } else if (curStatus === 'up' && prevStatus === 'down') {
    messages.push(
      `🟢 <b>${esc(c.site)}</b> zase běží\n` +
        `HTTP ${c.status} · odezva ${c.ms} ms\n` +
        `výpadek trval ${duration(prev.since, c.ts)}\n` +
        `${czTime(c.ts)}`
    );
  }

  state[c.url] = { status: curStatus, since: c.ts, site: c.site, err: c.err };
}

if (allDown) {
  const wasAllDown = state.__allDown === true;
  if (!wasAllDown) {
    messages.push(
      `⚠️ <b>Všech ${checks.length} webů hlásí výpadek</b>\n` +
        `To bývá problém měřiče (síť GitHub runneru), ne webů. Ověř ručně.\n` +
        `${czTime(now)}`
    );
  }
  state.__allDown = true;
} else {
  state.__allDown = false;
}

// Jedno neúspěšné odeslání znamená pětiminutovou díru v historii, ne poruchu —
// hlásí se až tři selhání po sobě, tedy čtvrt hodiny bez zápisu.
const INGEST_ALERT_AFTER = 3;
if (!ingestResult.skipped) {
  const failed = state.__ingestFails || 0;
  if (!ingestResult.ok) {
    const streak = failed + 1;
    state.__ingestFails = streak;
    if (streak === INGEST_ALERT_AFTER) {
      messages.push(
        `📉 <b>Zápis do dashboardu selhal ${streak}× po sobě</b>\n` +
          `${esc(ingestResult.error)}\n` +
          `Weby se měří dál a alerty chodí, ale historie na /home/uptime.html se nedoplňuje.\n` +
          `${czTime(now)}`
      );
    }
  } else {
    if (failed >= INGEST_ALERT_AFTER) {
      messages.push(
        `📈 <b>Zápis do dashboardu zase funguje</b>\n` +
          `Nedoplněno zůstane ${failed} měření.\n` +
          `${czTime(now)}`
      );
    }
    state.__ingestFails = 0;
  }
}

for (const m of messages) await telegram(m);

saveState(state);

const ingestLabel = ingestResult.ok ? 'ok' : ingestResult.skipped ? 'přeskočen' : 'selhal';
console.log(
  `\nHotovo: ${checks.length - down.length}/${checks.length} online, ` +
    `${messages.length} alertů, ingest ${ingestLabel}`
);
