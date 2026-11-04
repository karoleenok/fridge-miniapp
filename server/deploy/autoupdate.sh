#!/usr/bin/env bash
# Автообновление Фриджа: раз в несколько минут (systemd-таймер) проверяем GitHub.
# Есть новая версия -> подтягиваем, проверяем синтаксис, перезапускаем бота, ждём /health.
# Если не поднялся -> возвращаем прошлую версию. Если изменилось только то, что не относится к серверу
# (README, демо для GitHub Pages), бота не трогаем.
set -uo pipefail
APP="${APP:-/opt/fridge-bot}"
ENVF="${ENVF:-/etc/fridge-bot.env}"
SVC="${SVC:-fridge-bot}"
exec 9>"${LOCK:-/run/fridge-autoupdate.lock}"; flock -n 9 || exit 0   # не запускаться двумя копиями сразу
cd "$APP" || exit 1
[ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
PORT="${PORT:-8081}"
BAD="${BAD:-/var/tmp/fridge-autoupdate.bad}"   # версия, на которой бот не поднялся: повторно не ставим
git fetch -q origin main || exit 0
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/main)
[ "$OLD" = "$NEW" ] && exit 0
[ -f "$BAD" ] && [ "$(cat "$BAD")" = "$NEW" ] && exit 0
git merge -q --ff-only origin/main || { echo "автообновление Фриджа: не fast-forward, пропускаю"; exit 0; }
if ! git diff --name-only "$OLD" "$NEW" | grep -q '^server/'; then
  echo "автообновление Фриджа: $OLD -> $NEW, серверный код не менялся, перезапуск не нужен"; exit 0
fi
for f in server/src/*.js server/scripts/*.js; do
  node --check "$f" || { echo "автообновление Фриджа: ошибка в $f, откат на $OLD"; git reset -q --hard "$OLD"; echo "$NEW" > "$BAD"; exit 1; }
done
# если Caddyfile перезаписали целиком, возвращаем блок Фриджа (как в update.sh)
grep -q '^# fridge-bot begin$' /etc/caddy/Caddyfile 2>/dev/null || { [ -n "${PUBLIC_URL:-}" ] && bash "$APP/server/deploy/caddy-block.sh" "${PUBLIC_URL#https://}" "$PORT"; }
health() { for i in $(seq 1 12); do curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
systemctl restart "$SVC"
if health; then
  echo "автообновление Фриджа: $OLD -> $NEW, бот работает"
else
  echo "автообновление Фриджа: бот не ответил на $NEW, откат на $OLD"
  git reset -q --hard "$OLD"
  echo "$NEW" > "$BAD"
  systemctl restart "$SVC"
  exit 1
fi
