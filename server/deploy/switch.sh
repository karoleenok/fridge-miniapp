#!/usr/bin/env bash
# Переключить кнопку «Холодильник» в боте на этот сервер и обновить команды бота.
set -euo pipefail
set -a; . /etc/fridge-bot.env; set +a
curl -fsS -m 60 "http://127.0.0.1:${PORT:-8081}/setup?key=$SETUP_KEY"; echo
