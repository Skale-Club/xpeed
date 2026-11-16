#!/usr/bin/env bash
# Instala o carrinho num Raspberry Pi (Raspberry Pi OS Lite 64-bit).
# Rode de dentro da pasta rc-car:  bash deploy/install.sh
# Pode rodar de novo depois de mudar algo: ele só atualiza.
set -euo pipefail

MTX_VERSION="${MTX_VERSION:-v1.21.2}"
DEST=/opt/rc-car
RUN_USER="${SUDO_USER:-$(id -un)}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> pacotes"
sudo apt-get update -q
sudo apt-get install -y -q python3-websockets i2c-tools curl
sudo apt-get install -y -q python3-smbus2 || sudo apt-get install -y -q python3-smbus

echo "==> I2C ligado, usuário $RUN_USER nos grupos i2c e video"
sudo raspi-config nonint do_i2c 0
sudo usermod -aG i2c,video "$RUN_USER"

echo "==> arquivos em $DEST"
sudo mkdir -p "$DEST"
# config.toml só é copiado na primeira vez, para não apagar sua calibração.
[ -f "$DEST/config.toml" ] || sudo cp "$SRC/car/config.toml" "$DEST/config.toml"
sudo rm -rf "$DEST/car" "$DEST/pilot" "$DEST/video"
sudo cp -r "$SRC/car" "$SRC/pilot" "$SRC/video" "$DEST/"
sudo chown -R "$RUN_USER:" "$DEST"

echo "==> MediaMTX $MTX_VERSION"
case "$(uname -m)" in
  aarch64) MTX_ARCH=arm64 ;;
  armv7l) MTX_ARCH=armv7 ;;
  armv6l) MTX_ARCH=armv6 ;;
  *) echo "arquitetura $(uname -m) não suportada"; exit 1 ;;
esac
if [ "$("$DEST/mediamtx" --version 2>/dev/null || true)" != "$MTX_VERSION" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/mtx.tar.gz" \
    "https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/mediamtx_${MTX_VERSION}_linux_${MTX_ARCH}.tar.gz"
  tar -xzf "$tmp/mtx.tar.gz" -C "$tmp" mediamtx
  sudo install -m 755 "$tmp/mediamtx" "$DEST/mediamtx"
  rm -rf "$tmp"
fi

echo "==> serviços"
sudo tee /etc/systemd/system/rc-control.service >/dev/null <<EOF
[Unit]
Description=Carrinho RC - controle (ESC + servo)
After=network.target

[Service]
User=$RUN_USER
WorkingDirectory=$DEST/car
ExecStart=/usr/bin/python3 $DEST/car/control_server.py --config $DEST/config.toml
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/rc-video.service >/dev/null <<EOF
[Unit]
Description=Carrinho RC - vídeo (MediaMTX)
After=network.target

[Service]
User=$RUN_USER
ExecStart=$DEST/mediamtx $DEST/video/mediamtx.yml
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable rc-control rc-video
sudo systemctl restart rc-control rc-video

echo "==> página do piloto via Tailscale (HTTPS)"
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  sudo tailscale serve --bg --set-path / "$DEST/pilot"
  sudo tailscale serve --bg --set-path /control http://127.0.0.1:8765
  sudo tailscale serve --bg --set-path /cam http://127.0.0.1:8889/cam
  tailscale serve status
else
  echo "Tailscale ainda não está ligado. Rode 'sudo tailscale up --hostname=carro' e depois este script de novo."
fi

echo
echo "Pronto. Logs: journalctl -fu rc-control   |   journalctl -fu rc-video"
