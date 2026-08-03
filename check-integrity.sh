#!/usr/bin/env bash
# Kontrola, jestli monitoring nikdo nerozbil.
#
# Proč to existuje: v repu ~/jankabes pracuje víc oken naráz. Soubory uptime
# monitoru tam tvoří jen malý ostrůvek a snadno se stane, že je někdo přepíše
# regenerací stránky nebo je vynechá při deployi. Tenhle skript to pozná.
#
# Spuštění: ~/uptime-monitor/check-integrity.sh
set -uo pipefail

REPO="$HOME/jankabes"
HOST="393294.w94.wedos.net"
USER="w393294"
FAILS=0

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILS=$((FAILS + 1)); }

PW=$(security find-generic-password -s "huttenplaner-jankabes-ftp" -a "jankabes-ftp" -w 2>/dev/null || echo "")
if [ -z "$PW" ]; then
  echo "Nenašel jsem FTP heslo v Keychainu — serverovou část přeskakuji." >&2
fi

echo "1) Soubory v repu"
for f in www/uptime/ingest.php www/uptime/api.php www/uptime/.htaccess www/home/uptime.html; do
  [ -s "$REPO/$f" ] && pass "$f" || fail "$f CHYBÍ nebo je prázdný"
done

echo "2) Odkaz na dashboard v /home"
grep -q 'href="/home/uptime.html"' "$REPO/www/home/index.html" \
  && pass "tab Uptime je v index.html" \
  || fail "tab Uptime z index.html ZMIZEL (nejspíš ho přepsalo jiné okno)"

echo "3) Necommitnuté změny v mých souborech"
DIRTY=$(cd "$REPO" && git status --porcelain -- www/uptime www/home/uptime.html)
[ -z "$DIRTY" ] && pass "vše zacommitováno" || fail "rozdělaná práce: $DIRTY"

if [ -n "$PW" ]; then
  echo "4) Shoda serveru s repem"
  for f in ingest.php api.php; do
    L=$(shasum -a 256 "$REPO/www/uptime/$f" | cut -d' ' -f1)
    R=$(curl -s --max-time 25 -u "$USER:$PW" "ftp://$HOST/www/uptime/$f" | shasum -a 256 | cut -d' ' -f1)
    [ "$L" = "$R" ] && pass "$f na serveru odpovídá repu" || fail "$f na serveru je JINÝ než v repu"
  done
  L=$(shasum -a 256 "$REPO/www/home/uptime.html" | cut -d' ' -f1)
  R=$(curl -s --max-time 25 -u "$USER:$PW" "ftp://$HOST/www/home/uptime.html" | shasum -a 256 | cut -d' ' -f1)
  [ "$L" = "$R" ] && pass "uptime.html na serveru odpovídá repu" || fail "uptime.html na serveru je JINÝ než v repu"

  curl -s --max-time 20 -u "$USER:$PW" "ftp://$HOST/www/uptime/" | grep -q '\.token' \
    && pass "token na serveru je na místě" || fail "na serveru CHYBÍ .token — zápis nebude fungovat"
fi

echo "5) Endpoint žije"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST https://www.jankabes.cz/uptime/ingest.php)
[ "$CODE" = "403" ] && pass "ingest.php odmítá požadavek bez tokenu (403)" || fail "ingest.php vrací $CODE, čekal jsem 403"

echo
[ "$FAILS" -eq 0 ] && echo "V POŘÁDKU — monitoring nikdo nerozbil." || echo "POZOR: $FAILS problémů výše."
exit $((FAILS > 0 ? 1 : 0))
