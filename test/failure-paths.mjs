/**
 * Test poruchových cest pingeru.
 * Spustí lokální server, který umí na požádání vracet 500, viset,
 * nebo vracet špatný obsah — a proti němu pustí check.mjs.
 * Kontroluje NEJEN že se výpadek pozná, ale i že alert nespamuje
 * a že se ozve zpátky při zotavení.
 *
 * Spuštění: node test/failure-paths.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mode = 'ok'; // ok | 500 | slow | wrongtext

const server = createServer(async (req, res) => {
  // /live je referenční zdravý web — nesmí ho ovlivnit režim poruchy
  if (req.url.startsWith('/live')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<h1>Vítejte na webu</h1>');
  }
  if (mode === '500') {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    return res.end('<h1>Error 500</h1>');
  }
  // Falešný příjem měření — používá ho test prahu pro hlášení zápisu.
  if (req.url.startsWith('/ingest')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true,"stored":4}');
  }
  if (mode === 'slow') {
    await new Promise((r) => setTimeout(r, 3000));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(mode === 'wrongtext' ? '<h1>Údržba</h1>' : '<h1>Vítejte na webu</h1>');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'uptime-test-'));
const stateFile = join(dir, 'state.json');
const CHECK = join(import.meta.dirname, '..', 'check.mjs');

function config(sites, extra = {}) {
  return JSON.stringify({ intervalMinutes: 5, timeoutMs: 10000, retryDelayMs: 50, sites, ...extra });
}

function run(cfg, ownState = stateFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHECK], {
      env: {
        ...process.env,
        SITES_JSON: cfg,
        STATE_FILE: ownState,
        INGEST_URL: '',
        INGEST_TOKEN: '',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ out, code }));
  });
}

let failed = 0;
function assert(name, cond, detail = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failed++;
}

const LIVE = { url: `${base}/live`, label: 'live-web' };
const BROKEN = { url: `${base}/rozbity`, label: 'rozbity-web' };
const DEAD_DNS = { url: 'https://tato-domena-nikdy-neexistuje-9f3a1.cz/', label: 'mrtva-dns' };
const CONTENT = { url: `${base}/obsah`, label: 'obsah-web', mustContain: 'Vítejte' };

// ---------------------------------------------------------------
console.log('\n1) Rozpozná HTTP 500, mrtvou DNS a špatný obsah (a jeden web je zdravý)');
mode = '500';
let r = await run(config([LIVE, BROKEN, DEAD_DNS]));
assert('500 detekováno jako DOWN', /DOWN\s+rozbity-web.*HTTP 500/.test(r.out), r.out);
assert('mrtvá DNS detekována jako DOWN', /DOWN\s+mrtva-dns/.test(r.out), r.out);
assert('chybu potvrdil druhým pokusem', /2\spokusy/.test(r.out), r.out);
assert('zdravý web zůstal OK', /OK\s+live-web/.test(r.out), r.out);
assert('poslal 2 alerty', /2 alertů/.test(r.out), r.out);
assert('výpadek neshodil skript (exit 0)', r.code === 0, `exit ${r.code}`);

// ---------------------------------------------------------------
console.log('\n2) Trvající výpadek NESPAMUJE (druhý běh, stejný stav)');
r = await run(config([LIVE, BROKEN, DEAD_DNS]));
assert('žádný nový alert', /0 alertů/.test(r.out), r.out);
assert('web je pořád hlášený jako DOWN', /DOWN\s+rozbity-web/.test(r.out), r.out);

// ---------------------------------------------------------------
console.log('\n3) Zotavení pošle zelený alert s délkou výpadku');
mode = 'ok';
r = await run(config([LIVE, BROKEN]));
assert('rozbitý web je zase OK', /OK\s+rozbity-web/.test(r.out), r.out);
assert('poslal alert o zotavení', /zase běží/.test(r.out), r.out);
assert('alert obsahuje délku výpadku', /výpadek trval/.test(r.out), r.out);

// ---------------------------------------------------------------
console.log('\n4) Web vrací 200, ale chybí očekávaný text → taky DOWN');
mode = 'wrongtext';
r = await run(config([LIVE, CONTENT]), join(dir, 'state-obsah.json'));
assert('detekováno jako DOWN', /DOWN\s+obsah-web/.test(r.out), r.out);
assert('důvod je chybějící text', /neobsahuje/.test(r.out), r.out);

// ---------------------------------------------------------------
console.log('\n5) Timeout se pozná a nezasekne skript');
mode = 'slow';
r = await run(config([LIVE, { url: `${base}/pomaly`, label: 'pomaly-web' }], { timeoutMs: 800 }), join(dir, 'state-timeout.json'));
assert('timeout detekován', /DOWN\s+pomaly-web.*timeout/.test(r.out), r.out);
assert('skript skončil normálně', r.code === 0, `exit ${r.code}`);

// ---------------------------------------------------------------
console.log('\n6) Když hlásí výpadek VŠECHNO, pošli jedno varování místo N alertů');
const allDownState = join(dir, 'state-alldown.json');
r = await run(
  config([
    { url: 'https://tato-domena-nikdy-neexistuje-9f3a1.cz/', label: 'mrtva-1' },
    { url: 'https://tato-domena-nikdy-neexistuje-9f3a2.cz/', label: 'mrtva-2' },
    { url: 'https://tato-domena-nikdy-neexistuje-9f3a3.cz/', label: 'mrtva-3' },
  ]),
  allDownState
);
assert('varování o měřiči odesláno', /Všech\s3\swebů hlásí výpadek/.test(r.out), r.out);
assert('poslal jen 1 alert, ne 3', /1 alertů/.test(r.out), r.out);

// ---------------------------------------------------------------
console.log('\n7) Zápis do dashboardu: jedno selhání mlčí, tři po sobě se ohlásí');
mode = 'ok';
const ingestState = join(dir, 'state-ingest.json');
const DEAD = 'http://127.0.0.1:1/ingest.php'; // nikdo tam neposlouchá
const ALIVE = `${base}/ingest.php`;

function runIngest(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHECK], {
      env: {
        ...process.env,
        SITES_JSON: config([LIVE]),
        STATE_FILE: ingestState,
        INGEST_URL: url,
        INGEST_TOKEN: 'x',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ out, code }));
  });
}

r = await runIngest(DEAD);
assert('1. selhání neposílá alert', /0 alertů/.test(r.out), r.out);
assert('zkusil zápis podruhé', /1\. pokus selhal/.test(r.out), r.out);
assert('měření webu proběhlo i tak', /OK\s+live-web/.test(r.out), r.out);

r = await runIngest(DEAD);
assert('2. selhání pořád mlčí', /0 alertů/.test(r.out), r.out);

r = await runIngest(DEAD);
assert('3. selhání už alertuje', /Zápis do dashboardu selhal 3× po sobě/.test(r.out), r.out);

r = await runIngest(DEAD);
assert('4. selhání znovu nespamuje', /0 alertů/.test(r.out), r.out);

r = await runIngest(ALIVE);
assert('obnovení zápisu se ohlásí', /Zápis do dashboardu zase funguje/.test(r.out), r.out);

r = await runIngest(ALIVE);
assert('po obnovení už je ticho', /0 alertů/.test(r.out), r.out);

// ---------------------------------------------------------------
console.log('\n8) Rozbitá konfigurace spadne hlasitě, ne tichým 0 webů');
r = await new Promise((resolve) => {
  const child = spawn(process.execPath, [CHECK], {
    env: { ...process.env, SITES_JSON: '{nevalidni', STATE_FILE: join(dir, 's.json') },
    cwd: dir, // ať nenajde lokální sites.json a nespadne to na něj
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('close', (code) => resolve({ out, code }));
});
assert('skončil s chybou (exit 1)', r.code === 1, `exit ${r.code}`);
assert('řekl proč', /KONFIGURAČNÍ CHYBA/.test(r.out), r.out);

server.close();
console.log(`\n${failed === 0 ? 'VŠE PROŠLO' : `SELHALO: ${failed} kontrol`}`);
process.exit(failed === 0 ? 0 : 1);
