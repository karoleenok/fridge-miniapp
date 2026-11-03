#!/usr/bin/env bash
# Установка бота Фридж на сервер Ubuntu 24.04 рядом с другими ботами. Запуск от root, одной строкой:
#   curl --fail --silent --show-error --location --proto-default https -o /tmp/fi.sh raw.githubusercontent.com/karoleenok/fridge-miniapp/main/server/deploy/install.sh; bash /tmp/fi.sh
# Что НЕ трогает: другие боты, их службы и настройки, firewall. В Caddyfile только дописывает свой блок (с резервной копией).
# Секреты (токен бота, ключ моста) вводятся здесь и лежат только на этом сервере, в /etc/fridge-bot.env (читает только root).
set -euo pipefail

REPO="https://github.com/karoleenok/fridge-miniapp"
APP=/opt/fridge-bot
DATA=/var/lib/fridge-bot
ENVF=/etc/fridge-bot.env
SVC=fridge-bot
PORT=8081
CADDY=/etc/caddy/Caddyfile

say()  { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*"; exit 1; }
ask()  { local v; read -r -p "$1 " v </dev/tty || true; printf '%s' "$v"; }
asks() { local v; read -r -s -p "$1 " v </dev/tty || true; echo >&2; printf '%s' "$v"; }
yes()  { case "$1" in да|Да|ДА|y|Y|yes|д) return 0;; *) return 1;; esac; }

[ "$(id -u)" = 0 ] || die "Запусти от root (в консоли сервера ты и так root)."

say "1/8 Проверяю сервер"
command -v caddy >/dev/null || { apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null; }
command -v git >/dev/null || { apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null; }
command -v node >/dev/null || die "Нет Node.js. Он ставится вместе с дизайн-ботом; если его нет, напиши мне."
NODEV=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODEV" -ge 22 ] || die "Нужен Node.js 22 или новее, сейчас $(node -v)."
SQLFLAG=""
node -e "require('node:sqlite')" >/dev/null 2>&1 || SQLFLAG="--experimental-sqlite"
node $SQLFLAG -e "require('node:sqlite')" >/dev/null 2>&1 || die "В этой версии Node нет встроенного SQLite ($(node -v))."
if ss -ltn "( sport = :$PORT )" | grep -q LISTEN && ! systemctl is-active --quiet $SVC; then die "Порт $PORT занят другой программой."; fi
ok "Node $(node -v), Caddy есть, порт $PORT свободен"

say "2/8 Код Фриджа"
if [ -d "$APP/.git" ]; then git -C "$APP" pull -q --ff-only; else git clone -q --depth 1 "$REPO" "$APP"; fi
id fridge >/dev/null 2>&1 || useradd -r -m -d "$DATA" -s /usr/sbin/nologin fridge
mkdir -p "$DATA/backup"; chown -R fridge:fridge "$DATA"; chmod 750 "$DATA"
ok "код в $APP, база будет в $DATA"

say "3/8 Связь с Telegram"
CODE=$(curl -4 -s -m 12 -o /dev/null -w '%{http_code}' https://api.telegram.org || true)
MODE=polling; TG_API_ROOT=""; TG_RELAY_KEY=""
if [ -f "$ENVF" ]; then
  ok "настройки уже есть, связь не меняю"
elif [ "$CODE" != "000" ] && [ -n "$CODE" ] && ! yes "$(ask 'Telegram отвечает напрямую, но бывает с перебоями. Всё равно через мост? [да/нет]:')"; then
  ok "работаю напрямую"
else
  if [ -f /etc/di-sign-bot.env ] && grep -q '^TG_API_ROOT=.\+' /etc/di-sign-bot.env; then
    OLDROOT=$(grep '^TG_API_ROOT=' /etc/di-sign-bot.env | head -1 | cut -d= -f2-)
    if yes "$(ask "Нашёл мост дизайн-бота ($OLDROOT). Взять его же? [да/нет]:")"; then
      TG_API_ROOT=$OLDROOT
      TG_RELAY_KEY=$(grep '^TG_RELAY_KEY=' /etc/di-sign-bot.env | head -1 | cut -d= -f2-)
    fi
  fi
  if [ -z "$TG_API_ROOT" ]; then
    TG_API_ROOT=$(ask "Адрес моста (например https://tg-relay.имя.workers.dev):")
    TG_RELAY_KEY=$(asks "Ключ моста (RELAY_KEY, не отображается):")
  fi
  [ -n "$TG_API_ROOT" ] || die "Без моста бот не достучится до Telegram."
  ok "мост: $TG_API_ROOT"
fi

say "4/8 Токен и адрес"
if [ -f "$ENVF" ]; then
  warn "Настройки уже есть ($ENVF), использую их."
else
  # Токен в консоли не спрашиваем: его вставляют на одноразовой странице /claim (в обычном браузере, с копированием).
  BOT_TOKEN=""; BOT_USERNAME=""
  CLAIM_CODE=$(openssl rand -hex 4); CLAIM_UNTIL=$(( ($(date +%s) + 3600) * 1000 ))
  IP=$(curl -4 -s -m 8 https://ifconfig.me || hostname -I | awk '{print $1}')
  DOM=$(ask "Свой домен для Фриджа (Enter — бесплатный адрес):")
  [ -n "$DOM" ] || DOM="fridge.$(printf '%s' "$IP" | tr . -).sslip.io"
  OWNER_INFO=""; CONTACT=""   # данные оператора для /policy дописываются позже в /etc/fridge-bot.env
  umask 077
  cat > "$ENVF" <<EOT
BOT_TOKEN=$BOT_TOKEN
BOT_USERNAME=$BOT_USERNAME
PUBLIC_URL=https://$DOM
MODE=$MODE
TG_API_ROOT=$TG_API_ROOT
TG_RELAY_KEY=$TG_RELAY_KEY
SETUP_KEY=$(openssl rand -hex 16)
WEBHOOK_SECRET=$(openssl rand -hex 16)
DB_FILE=$DATA/fridge.db
PORT=$PORT
HOST=127.0.0.1
TZ_NAME=Europe/Moscow
OWNER_INFO="$OWNER_INFO"
CONTACT="$CONTACT"
CLAIM_CODE=$CLAIM_CODE
CLAIM_UNTIL=$CLAIM_UNTIL
EOT
  chmod 600 "$ENVF"
  unset TG_RELAY_KEY
fi
set -a; . "$ENVF"; set +a
DOM=${PUBLIC_URL#https://}
ok "адрес Фриджа: $PUBLIC_URL"

say "5/8 Служба"
cat > /etc/systemd/system/$SVC.service <<EOT
[Unit]
Description=Fridge bot and mini app
After=network-online.target
Wants=network-online.target

[Service]
User=fridge
WorkingDirectory=$APP/server
EnvironmentFile=$ENVF
ExecStart=$(command -v node) --no-warnings $SQLFLAG src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA
CapabilityBoundingSet=
MemoryMax=400M

[Install]
WantedBy=multi-user.target
EOT
cat > /etc/systemd/system/$SVC-backup.service <<EOT
[Unit]
Description=Fridge database backup
[Service]
Type=oneshot
User=fridge
EnvironmentFile=$ENVF
WorkingDirectory=$APP/server
ExecStart=$(command -v node) --no-warnings $SQLFLAG scripts/backup.js
EOT
cat > /etc/systemd/system/$SVC-backup.timer <<EOT
[Unit]
Description=Daily Fridge backup
[Timer]
OnCalendar=*-*-* 04:20:00
Persistent=true
[Install]
WantedBy=timers.target
EOT
systemctl daemon-reload
systemctl enable --now $SVC >/dev/null 2>&1
systemctl enable --now $SVC-backup.timer >/dev/null 2>&1
systemctl restart $SVC
for i in $(seq 1 10); do curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && ok "Фридж запущен, ежедневная копия базы в 04:20" || { journalctl -u $SVC -n 30 --no-pager; die "Не запустился (лог выше)."; }

say "6/8 HTTPS-адрес (дописываю блок в Caddy, чужие не трогаю)"
bash "$APP/server/deploy/caddy-block.sh" "$DOM" "$PORT"

say "7/8 Проверка снаружи"
for i in $(seq 1 30); do curl -fsS -m 5 "$PUBLIC_URL/health" >/dev/null 2>&1 && break; sleep 3; done
curl -fsS -m 5 "$PUBLIC_URL/health" >/dev/null 2>&1 && ok "$PUBLIC_URL открывается с сертификатом" || warn "адрес пока не открылся (сертификат ещё выпускается). Подожди минуту."

if [ ! -s "$DATA/bot-token" ] && [ -z "${BOT_TOKEN:-}" ]; then
  say "8/8 Токен бота: вставь его на одноразовой странице"
  set -a; . "$ENVF"; set +a
  printf '\n  Открой на телефоне или компьютере:\n\n      \033[1m%s/claim\033[0m\n\n  Код:  \033[1m%s\033[0m   (действует час)\n\n' "$PUBLIC_URL" "$CLAIM_CODE"
  echo "  Там же вставь токен из @BotFather и нажми «Сохранить». Жду…"
  for i in $(seq 1 720); do
    curl -fsS -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q waiting-token || break
    sleep 5
  done
  if curl -fsS -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q waiting-token; then
    warn "Токен так и не вставлен. Новый код: bash $APP/server/deploy/claim.sh"
  else
    ok "токен получен, бот работает"
  fi
else
  say "8/8 Переключить кнопку «Холодильник» в боте на этот сервер?"
  if yes "$(ask 'Переключить? [да/нет]:')"; then
    curl -fsS -m 60 "http://127.0.0.1:$PORT/setup?key=$SETUP_KEY" || warn "не получилось, повтори позже: bash $APP/server/deploy/switch.sh"
    echo; ok "готово"
  fi
fi

cat <<EOT

════════════════════════════════════════════
  Готово. Фридж: $PUBLIC_URL
  Проверка: напиши боту /start
  Обновить потом: bash $APP/server/deploy/update.sh
  Настройки: $ENVF (только root). Копии базы: $DATA/backup
════════════════════════════════════════════
EOT
