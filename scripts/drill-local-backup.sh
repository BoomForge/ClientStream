#!/usr/bin/env bash
# Offline restore drill: fresh disposable D1, encrypted export, isolated re-import.
# No remote operations and no persistent credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export BACKUP_ENCRYPTION_PASSWORD="$(openssl rand -hex 32)"

rm -rf .wrangler/state
npx wrangler d1 migrations apply clientstream-db --local > /dev/null
npx wrangler d1 execute clientstream-db --local \
  --command "INSERT INTO users (id,email,display_name) VALUES ('restore-sentinel','restore@example.invalid','Restore sentinel')" > /dev/null
npx wrangler d1 export clientstream-db --local --output "$tmp/source.sql" > /dev/null

openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -in "$tmp/source.sql" -out "$tmp/backup.sql.enc" -pass env:BACKUP_ENCRYPTION_PASSWORD
rm "$tmp/source.sql"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$tmp/backup.sql.enc" -out "$tmp/restored.sql" -pass env:BACKUP_ENCRYPTION_PASSWORD
npx wrangler d1 execute clientstream-db --local --persist-to "$tmp/restored" \
  --file="$tmp/restored.sql" > /dev/null

result="$(npx wrangler d1 execute clientstream-db --local --persist-to "$tmp/restored" \
  --command "SELECT COUNT(*) AS n FROM users WHERE id = 'restore-sentinel'" --json)"
RESTORE_RESULT="$result" node -e '
  const parsed = JSON.parse(process.env.RESTORE_RESULT);
  const rows = Array.isArray(parsed) ? parsed[0]?.results : parsed.results;
  if (Number(rows?.[0]?.n) !== 1) throw Error("Restore sentinel is missing");
'
echo "Encrypted D1 local backup/decrypt/restore drill passed."
