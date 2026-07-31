#!/usr/bin/env bash
# Nahraje lokální sites.json do repo secretu SITES_JSON.
# Seznam webů takhle zůstane privátní i ve veřejném repu.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f sites.json ]; then
  echo "Chybí sites.json — zkopíruj sites.example.json a vyplň weby." >&2
  exit 1
fi

# Validace: rozbitý JSON v secretu by shodil každý běh workflow.
node -e '
  const c = JSON.parse(require("fs").readFileSync("sites.json", "utf8"));
  if (!Array.isArray(c.sites) || !c.sites.length) throw new Error("sites je prázdné");
  for (const s of c.sites) new URL(s.url);
  console.log(`sites.json ok — ${c.sites.length} webů, interval ${c.intervalMinutes ?? 5} min`);
'

gh secret set SITES_JSON --body "$(cat sites.json)"
echo "SITES_JSON nastaven."

# Běžící smyčka si seznam načetla při startu, takže o změně neví.
# Bez restartu by nové weby začala hlídat až za ~3 hodiny.
RUNNING=$(gh run list --workflow=uptime.yml --status in_progress --json databaseId -q '.[].databaseId')
if [ -n "$RUNNING" ]; then
  for id in $RUNNING; do
    gh run cancel "$id" >/dev/null 2>&1 && echo "Zastavuju běžící smyčku ($id), aby načetla nový seznam."
  done
  # Zrušení chvíli trvá; než doběhne, nový běh by se zařadil do fronty za něj.
  for _ in $(seq 1 20); do
    [ -z "$(gh run list --workflow=uptime.yml --status in_progress --json databaseId -q '.[].databaseId')" ] && break
    sleep 3
  done
fi
gh workflow run uptime.yml && echo "Spuštěn nový běh s aktuálním seznamem."
