#!/usr/bin/env bash
# Gửi một commit tới máy ảo rồi phát hành nó (Plan #52 QĐ-9) — bước của workflow Deploy, chạy trên runner. Máy ảo
# không cần quyền vào GitHub: mã nguồn đi bằng `git archive` qua SSH, host key đã GHIM trong known_hosts.
#
#   UDP_VM_HOST=… UDP_VM_USER=… bash deploy/vm/ship.sh <sha 40 ký tự>
#
# Khoá SSH ở ~/.ssh/udp_vm, host key ở ~/.ssh/known_hosts (workflow đặt từ secret). Giữ ba bản phát hành gần nhất.
set -euo pipefail

sha="${1:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "cần SHA đầy đủ 40 ký tự hex của commit, nhận \"$sha\"" >&2
  exit 2
fi
: "${UDP_VM_HOST:?thiếu UDP_VM_HOST}"
: "${UDP_VM_USER:?thiếu UDP_VM_USER}"

ssh_opts=(
  -i "$HOME/.ssh/udp_vm"
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts"
  -o ServerAliveInterval=30
)
target="$UDP_VM_USER@$UDP_VM_HOST"
# Đường tương đối từ thư mục nhà của user trên máy ảo; `sha` đã kiểm là hex nên an toàn trong chuỗi lệnh
dir="udp/releases/$sha"

git archive --format=tar "$sha" |
  ssh "${ssh_opts[@]}" "$target" "rm -rf '$dir' && mkdir -p '$dir' && tar -x -C '$dir'"
ssh "${ssh_opts[@]}" "$target" \
  "bash '$dir/deploy/vm/release.sh' '$sha' && ls -1dt udp/releases/*/ | tail -n +4 | xargs -r rm -rf"
