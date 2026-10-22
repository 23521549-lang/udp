#!/usr/bin/env bash
# Dựng máy ảo cho UDP MỘT lần (Plan #52 QĐ-10) — chạy lại được, bước đã xong thì bỏ qua. Trên máy ảo Ubuntu 24.04
# (Oracle Cloud Always Free, Ampere A1 arm64), bằng user có sudo không mật khẩu (user `ubuntu` mặc định):
#
#   git clone https://github.com/23521549-lang/udp.git && bash udp/deploy/vm/bootstrap.sh
#
# Job `vm` của CI chạy CHÍNH tệp này trên runner x86 trước khi phát hành thử. Phần ngoài máy (tài khoản, máy ảo,
# security list, DuckDNS, bucket sao lưu, secret GitHub) làm bằng trình duyệt theo deploy/README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"

readonly KUBECONFIG_FILE="$HOME/.kube/udp-vm.yaml"
readonly CONTEXT=udp-vm
readonly SETTINGS="$HOME/udp/vm.env"

log() { printf '\n==> %s\n' "$*"; }
kc() { kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" "$@"; }

# Thử lại một lệnh tới khi xanh — thứ k3s dựng bất đồng bộ (CRD của Traefik) chưa có ngay sau khi cài
retry() {
  local attempts=$1
  shift
  for ((i = 1; i <= attempts; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  echo "hết lượt chờ: $*" >&2
  return 1
}

open_web_ports() {
  log "Mở cổng 80/443 trong iptables"
  # Image Ubuntu của Oracle chặn mọi cổng trừ 22 bằng một luật REJECT cuối chuỗi INPUT (security list của VCN là
  # lớp thứ hai, mở trên Console). ACCEPT phải đứng TRƯỚC luật REJECT đó.
  for port in 80 443; do
    if ! sudo iptables -C INPUT -p tcp -m conntrack --ctstate NEW --dport "$port" -j ACCEPT 2>/dev/null; then
      sudo iptables -I INPUT 1 -p tcp -m conntrack --ctstate NEW --dport "$port" -j ACCEPT
    fi
  done
  # Image của Oracle lưu luật bằng netfilter-persistent; runner CI thì không có — luật chỉ sống tới hết lượt
  if command -v netfilter-persistent >/dev/null; then
    sudo netfilter-persistent save
  fi
}

install_docker() {
  if command -v docker >/dev/null; then return; fi
  log "Cài Docker từ kho apt chính thức"
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  local codename
  codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" |
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  # Có hiệu lực từ phiên SSH sau — workflow Deploy luôn mở phiên mới
  sudo usermod -aG docker "$USER"
}

install_node() {
  if command -v node >/dev/null && [[ "$(node --version)" == v22.* ]]; then return; fi
  log "Cài Node ${NODE_VERSION} (tarball chính thức, kiểm SHA-256)"
  local arch
  case "$(uname -m)" in
    aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *)
      echo "kiến trúc $(uname -m) không được hỗ trợ" >&2
      exit 1
      ;;
  esac
  local name="node-${NODE_VERSION}-linux-${arch}"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSLo "$tmp/$name.tar.xz" "https://nodejs.org/dist/${NODE_VERSION}/$name.tar.xz"
  curl -fsSLo "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c -)
  sudo tar -xJf "$tmp/$name.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$tmp"
}

enable_pnpm() {
  if command -v pnpm >/dev/null; then return; fi
  log "Bật pnpm qua corepack (phiên bản theo packageManager của repo)"
  sudo "$(command -v corepack)" enable
}

install_k3s() {
  if command -v k3s >/dev/null && k3s --version | grep -qF "$K3S_VERSION"; then return; fi
  log "Cài k3s ${K3S_VERSION}"
  # Trình cài chính thức tự kiểm SHA-256 của binary theo bản phát hành đã ghim
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server --write-kubeconfig-mode 0600
}

write_kubeconfig() {
  log "Kubeconfig riêng ${KUBECONFIG_FILE}, context ${CONTEXT}"
  mkdir -p "$HOME/.kube"
  local tmp="$KUBECONFIG_FILE.tmp"
  (umask 077 && sudo cat /etc/rancher/k3s/k3s.yaml >"$tmp")
  kubectl --kubeconfig "$tmp" config rename-context default "$CONTEXT" >/dev/null
  mv "$tmp" "$KUBECONFIG_FILE"
  retry 60 kc get nodes
  kc wait --for=condition=Ready node --all --timeout=300s
  # Overlay `vm` có Middleware của Traefik và HelmChartConfig — CRD phải có trước lần phát hành đầu
  retry 60 kc get crd middlewares.traefik.io
  kc wait --for=condition=Established crd/middlewares.traefik.io --timeout=120s
}

traefik_keeps_client_ip() {
  [[ "$(kc -n kube-system get svc traefik -o jsonpath='{.spec.externalTrafficPolicy}')" == Local ]]
}

configure_traefik() {
  log "Traefik giữ IP của khách (externalTrafficPolicy: Local)"
  # CÙNG tệp mà overlay `vm` áp mỗi lần phát hành — áp trước ở đây để lần phát hành đầu không khởi động lại Traefik
  # giữa lúc đang phục vụ; các lần sau nội dung không đổi nên helm-controller không làm gì
  kc apply -f "$here/../k8s/overlays/vm/traefik.yaml"
  retry 60 traefik_keeps_client_ip
  kc -n kube-system rollout status deployment/traefik --timeout=300s
}

install_cert_manager() {
  log "Cài cert-manager ${CERT_MANAGER_VERSION}"
  kc apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"
  for deployment in cert-manager cert-manager-cainjector cert-manager-webhook; do
    kc -n cert-manager rollout status "deployment/$deployment" --timeout=300s
  done
}

write_settings_template() {
  if [[ -f "$SETTINGS" ]]; then return; fi
  log "Tệp cấu hình mẫu ${SETTINGS}"
  mkdir -p "$(dirname "$SETTINGS")"
  install -m 600 "$here/vm.env.example" "$SETTINGS"
}

open_web_ports
install_docker
install_node
enable_pnpm
install_k3s
write_kubeconfig
configure_traefik
install_cert_manager
write_settings_template

cat <<EOF

Máy đã sẵn sàng. Còn lại (deploy/README.md):
  1. Điền ${SETTINGS}
  2. Chép UDP_KEK_V1 vào trình quản lý mật khẩu SAU lần phát hành đầu (bản sao lưu không mang nó)
  3. Chạy workflow Deploy trên GitHub (hay đẩy lên main)
EOF
