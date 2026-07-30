# uptime-monitor

Hlídač dostupnosti webů pro jankabes.cz. Měří z GitHub Actions, zapisuje historii
na jankabes.cz a při změně stavu píše na Telegram.

## Proč je tenhle repozitář veřejný

Standardní runnery jsou ve veřejných repech zdarma bez limitu. V privátním repu by
pětiminutový interval znamenal ~8 600 účtovaných minut měsíčně (limit je 2 000 pro
Free, 3 000 pro Pro), tedy zhruba 40 $ měsíčně navíc.

Proto tu **není nic citlivého**: seznam webů žije v repo secretu `SITES_JSON`,
lokální `sites.json` je v `.gitignore`.

## Jak to zapadá dohromady

```
GitHub Actions (každých ~5 min)
   │  změří weby, chybu potvrdí druhým pokusem
   ├─→ POST /uptime/ingest.php  → SQLite na Wedosu → /home/uptime.html
   └─→ Telegram (jen při ZMĚNĚ stavu: up→down, down→up)
```

Měřič běží mimo monitorovaný server. Když spadne Wedos, měření i alerty jedou dál —
jen se do dashboardu nezapíše historie (a přijde o tom zpráva).

## Nastavení

1. **Seznam webů**

   ```bash
   cp sites.example.json sites.json   # vyplň weby
   ./sync-sites.sh                    # nahraje ho do secretu SITES_JSON
   ```

   Volitelné pole `mustContain` hlídá, že na stránce je očekávaný text — odhalí web,
   který vrací 200, ale zobrazuje chybu nebo prázdno.

2. **Secrety** (`gh secret set NÁZEV`)

   | Secret | Odkud |
   |---|---|
   | `SITES_JSON` | `./sync-sites.sh` |
   | `INGEST_URL` | `https://www.jankabes.cz/uptime/ingest.php` |
   | `INGEST_TOKEN` | stejná hodnota jako v `www/uptime/.token` na serveru |
   | `TELEGRAM_BOT_TOKEN` | od [@BotFather](https://t.me/BotFather) |
   | `TELEGRAM_CHAT_ID` | napiš botovi zprávu, pak `https://api.telegram.org/bot<TOKEN>/getUpdates` |

3. **Zkouška** — v Actions spusť workflow ručně (`Run workflow`).

## Lokální spuštění

```bash
node check.mjs                 # jen změří a vypíše, nic nikam neposílá
node test/failure-paths.mjs    # testy poruchových cest
```

Bez `TELEGRAM_*` se zprávy jen vypíšou do konzole, bez `INGEST_URL` se nikam nezapisuje.

## Co tenhle nástroj vědomě neumí

- **Interval přesně 1 min.** GitHub cron má minimum 5 min a běžně se zpozdí.
  Skutečná perioda tak kolísá; dashboard proto počítá procenta ze zapsaných měření
  a chybějící měření hlásí zvlášť, aby 100 % nelhalo.
- **Root cause výpadku.** Umí říct HTTP status, odezvu, timeout a chybějící text.
  Nedokáže říct, proč aplikace uvnitř spadla.
- **Po 60 dnech bez commitu** GitHub plánované workflow uspí a pošle o tom mail.
