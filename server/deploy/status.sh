#!/usr/bin/env bash
# Состояние Фриджа: служба, очередь сообщений, последняя связь с Telegram, последние строки лога.
set -a; . /etc/fridge-bot.env; set +a
systemctl is-active fridge-bot
curl -s -m 5 "http://127.0.0.1:${PORT:-8081}/health"; echo
journalctl -u fridge-bot -n 15 --no-pager
