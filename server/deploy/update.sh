#!/usr/bin/env bash
# Обновить Фридж: bash /opt/fridge-bot/server/deploy/update.sh
set -euo pipefail
APP=/opt/fridge-bot; ENVF=/etc/fridge-bot.env
git -C "$APP" pull --ff-only
set -a; . "$ENVF"; set +a
# если кто-то перезаписал Caddyfile целиком (например, переустановка другого бота), возвращаем блок Фриджа
grep -q '^# fridge-bot begin$' /etc/caddy/Caddyfile 2>/dev/null || bash "$APP/server/deploy/caddy-block.sh" "${PUBLIC_URL#https://}" "${PORT:-8081}"
systemctl restart fridge-bot
for i in $(seq 1 10); do curl -fsS -m 3 "http://127.0.0.1:${PORT:-8081}/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -m 3 "http://127.0.0.1:${PORT:-8081}/health" && echo || { journalctl -u fridge-bot -n 30 --no-pager; exit 1; }
