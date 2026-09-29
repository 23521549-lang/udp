#!/usr/bin/env bash
# Một bản phát hành UDP trên máy ảo (Plan #52 QĐ-9) — chạy TỪ thư mục mã nguồn của đúng commit: thư mục mà
# ship.sh vừa giải nén (workflow Deploy), hay bản checkout của job `vm` trong CI.
#
#   bash deploy/vm/release.sh <sha 40 ký tự>
#
# Cài gói deploy rồi `vm-up`: build image arm64 tại chỗ, nạp vào k3s với tag của commit, bổ sung Secret, áp bản
# phát hành sinh từ ~/udp/vm.env, migrate, chờ sẵn sàng.
set -euo pipefail

sha="${1:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "cần SHA đầy đủ 40 ký tự hex của commit, nhận \"$sha\"" >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
pnpm install --frozen-lockfile --filter "@udp/deploy..."
pnpm --filter @udp/deploy vm-up --release "$sha"
