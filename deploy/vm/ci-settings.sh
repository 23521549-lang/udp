#!/usr/bin/env bash
# Cấu hình máy diễn tập của job `vm` trong CI (Plan #52 QĐ-11) — CHỈ cho runner, không bao giờ cho máy thật:
# host `udp.ci.test` trỏ về IP của node (không có DNS công khai nên Let's Encrypt không cấp được ⇒ CA tự ký của
# cert-manager), đích sao lưu là bồn nhận mà E2E mở trên runner (cổng CI_BACKUP_SINK_PORT).
set -euo pipefail

readonly HOST=udp.ci.test
readonly CI_BACKUP_SINK_PORT=8099
readonly SETTINGS="$HOME/udp/vm.env"

node_ip="$(hostname -I | awk '{print $1}')"
if [[ -z "$node_ip" ]]; then
  echo "không đọc được IP của runner" >&2
  exit 1
fi

# IP của node chứ không 127.0.0.1: ServiceLB của k3s mở 80/443 trên địa chỉ của node
echo "$node_ip $HOST" | sudo tee -a /etc/hosts >/dev/null

mkdir -p "$(dirname "$SETTINGS")"
(
  umask 077
  cat >"$SETTINGS" <<EOF
UDP_PUBLIC_HOST=$HOST
ACME_EMAIL=ci@example.com
TLS_ISSUER=self-signed
UDP_BACKUP_UPLOAD_URL=http://$node_ip:$CI_BACKUP_SINK_PORT/
EOF
)
echo "máy diễn tập: https://$HOST → $node_ip"
