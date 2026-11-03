#!/usr/bin/env bash
# Новый одноразовый код для страницы токена (если старый устарел или исчерпан): bash /opt/fridge-bot/server/deploy/claim.sh
set -euo pipefail
ENVF=/etc/fridge-bot.env
CODE=$(openssl rand -hex 4); UNTIL=$(( ($(date +%s) + 3600) * 1000 ))
sed -i '/^CLAIM_CODE=/d; /^CLAIM_UNTIL=/d' "$ENVF"
printf 'CLAIM_CODE=%s\nCLAIM_UNTIL=%s\n' "$CODE" "$UNTIL" >> "$ENVF"
systemctl restart fridge-bot
set -a; . "$ENVF"; set +a
printf '\n  Открой: \033[1m%s/claim\033[0m\n  Код:    \033[1m%s\033[0m  (действует час)\n\n' "$PUBLIC_URL" "$CODE"
