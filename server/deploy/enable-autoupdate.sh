#!/usr/bin/env bash
# Включить автообновление Фриджа с GitHub (раз в 3 минуты). Запустить на сервере один раз.
set -euo pipefail
APP=/opt/fridge-bot
cat > /etc/systemd/system/fridge-autoupdate.service <<UNIT
[Unit]
Description=Fridge bot autoupdate from GitHub
[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $APP/server/deploy/autoupdate.sh
UNIT
cat > /etc/systemd/system/fridge-autoupdate.timer <<'UNIT'
[Unit]
Description=Fridge bot autoupdate every 3 minutes
[Timer]
OnActiveSec=90s
OnBootSec=3min
OnUnitActiveSec=3min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now fridge-autoupdate.timer
systemctl is-active fridge-autoupdate.timer
echo "автообновление Фриджа включено: проверка GitHub раз в 3 минуты"
echo "смотреть журнал: journalctl -u fridge-autoupdate -n 20 --no-pager"
