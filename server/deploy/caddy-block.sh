#!/usr/bin/env bash
# Дописывает в Caddyfile блок Фриджа между метками. Остальные блоки (например, дизайн-бота) не трогает.
# Перед изменением делает копию; если Caddy не принял файл, возвращает копию обратно.
set -euo pipefail
DOM=$1; PORT=$2; CADDY=/etc/caddy/Caddyfile
mkdir -p /etc/caddy; touch "$CADDY"
BAK="$CADDY.bak-fridge-$(date +%Y%m%d-%H%M%S)"
cp "$CADDY" "$BAK"
sed -i '/^# fridge-bot begin$/,/^# fridge-bot end$/d' "$CADDY"
printf '\n# fridge-bot begin\n%s {\n\treverse_proxy 127.0.0.1:%s\n\theader -Server\n}\n# fridge-bot end\n' "$DOM" "$PORT" >> "$CADDY"
if caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1; then
  systemctl enable --now caddy >/dev/null 2>&1 || true
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  printf '  \033[32m✓\033[0m Caddy: %s → 127.0.0.1:%s (копия старого файла: %s)\n' "$DOM" "$PORT" "$BAK"
else
  cp "$BAK" "$CADDY"
  printf '\n\033[31m✗ Caddy не принял новый файл, вернул старый. Другие боты не затронуты.\033[0m\n'
  caddy validate --config "$CADDY" --adapter caddyfile || true
  exit 1
fi
