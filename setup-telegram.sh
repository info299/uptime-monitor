#!/usr/bin/env bash
# Napojení uptime monitoru na Telegram.
# Token vložíš jen sem do terminálu — neukládá se na disk ani se nevypisuje.
set -euo pipefail

cd "$(dirname "$0")"

command -v gh >/dev/null || { echo "Chybí GitHub CLI (gh)." >&2; exit 1; }
command -v python3 >/dev/null || { echo "Chybí python3." >&2; exit 1; }

cat <<'INFO'
────────────────────────────────────────────────────────────
 Napojení na Telegram
────────────────────────────────────────────────────────────
 1. Otevři Telegram a najdi kontakt  @BotFather
 2. Napiš mu:  /newbot
 3. Zadej jméno bota (např. Uptime Kabeš)
 4. Zadej uživatelské jméno — musí končit na "bot"
    (např. kabes_uptime_bot)
 5. BotFather odpoví tokenem ve tvaru  123456789:AAF...
 6. Ten token zkopíruj a vlož níž.
────────────────────────────────────────────────────────────
INFO

read -rsp "Vlož token od BotFathera (psaní není vidět): " TOKEN
echo
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"

if [ -z "$TOKEN" ]; then echo "Nic jsi nevložil, končím." >&2; exit 1; fi

# --- ověření tokenu ---
BOT=$(curl -s --max-time 15 "https://api.telegram.org/bot${TOKEN}/getMe" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["result"]["username"] if d.get("ok") else "")')

if [ -z "$BOT" ]; then
  echo "Token nesedí — Telegram ho nepřijal. Zkontroluj, že jsi zkopíroval celý řádek." >&2
  exit 1
fi
echo "✓ Token platí, bot je @${BOT}"
echo
echo "Teď otevři v Telegramu chat s @${BOT} a napiš mu cokoliv (třeba: ahoj)."
echo "Čekám na tvoji zprávu…"

# --- počkej na první zprávu, ať zjistíme chat ID ---
CHAT=""
for _ in $(seq 1 60); do
  CHAT=$(curl -s --max-time 15 "https://api.telegram.org/bot${TOKEN}/getUpdates" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
ids = [u["message"]["chat"]["id"] for u in d.get("result", []) if "message" in u]
print(ids[-1] if ids else "")')
  [ -n "$CHAT" ] && break
  sleep 3
done

if [ -z "$CHAT" ]; then
  echo "Zprávu jsem se nedočkal. Napiš botovi a spusť skript znovu." >&2
  exit 1
fi
echo "✓ Chat ID zjištěno: ${CHAT}"

# --- zkušební zpráva, ať je vidět, že to opravdu dojde ---
OK=$(curl -s --max-time 15 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\":\"${CHAT}\",\"text\":\"✅ <b>Uptime monitor je napojený.</b>\nTakhle budou chodit hlášky o výpadcích.\",\"parse_mode\":\"HTML\"}" \
  | python3 -c 'import sys,json; print("ano" if json.load(sys.stdin).get("ok") else "ne")')

[ "$OK" = "ano" ] && echo "✓ Zkušební zpráva odeslána — mrkni do Telegramu." || {
  echo "Zprávu se nepodařilo odeslat." >&2; exit 1; }

# --- uložení do secretů repa ---
printf '%s' "$TOKEN" | gh secret set TELEGRAM_BOT_TOKEN
printf '%s' "$CHAT"  | gh secret set TELEGRAM_CHAT_ID
unset TOKEN

echo
echo "✓ Secrety TELEGRAM_BOT_TOKEN a TELEGRAM_CHAT_ID uloženy v repu."
echo "Hotovo. Od příštího běhu chodí alerty na Telegram."
