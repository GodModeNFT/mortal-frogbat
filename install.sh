#!/usr/bin/env bash
# Mortal Frogbat installer for a Ubuntu/Debian VPS (e.g. RackNerd).
# Installs Node.js 20, the game server as a systemd service, and a Cloudflare Tunnel for HTTPS.
# Safe to re-run: running it again pulls the latest code from GitHub and restarts the game.
#
# Usage (as root):
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/deploy/install.sh | bash
# It asks for anything it needs. You can also pass values as env vars:
#   REPO_URL, GIT_TOKEN (private repos), BOT_TOKEN, BOT_USERNAME, APP_SHORT_NAME, TUNNEL_TOKEN
set -euo pipefail

APP_DIR=/opt/frogbat
ENV_FILE=/etc/frogbat.env
PORT=3000

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
ask()  { # ask VAR "Prompt" [secret]  — reads from the terminal even when piped through curl
  local var=$1 prompt=$2 secret=${3:-}
  if [ -n "${!var:-}" ]; then return; fi
  if [ -n "$secret" ]; then read -rsp "$prompt: " val </dev/tty; echo; else read -rp "$prompt: " val </dev/tty; fi
  printf -v "$var" '%s' "$val"
}

[ "$(id -u)" -eq 0 ] || { echo "Run this as root (or with sudo)."; exit 1; }
command -v apt-get >/dev/null || { echo "This script needs Ubuntu or Debian."; exit 1; }

# keep earlier answers when re-running
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

ask REPO_URL "GitHub repo URL (e.g. https://github.com/you/mortal-frogbat)"
ask BOT_TOKEN "Telegram bot token from @BotFather" secret
ask BOT_USERNAME "Bot username, without the @"
APP_SHORT_NAME=${APP_SHORT_NAME:-pit}

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  say "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"

say "Getting the game code"
id frogbat >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin frogbat
CLONE_URL=$REPO_URL
if [ -n "${GIT_TOKEN:-}" ]; then CLONE_URL=$(echo "$REPO_URL" | sed "s#https://#https://x-access-token:${GIT_TOKEN}@#"); fi
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" remote set-url origin "$CLONE_URL"
  git -C "$APP_DIR" fetch -q origin && git -C "$APP_DIR" reset -q --hard origin/HEAD
else
  rm -rf "$APP_DIR"; git clone -q "$CLONE_URL" "$APP_DIR" || {
    echo "Could not clone $REPO_URL. If the repo is private, re-run with GIT_TOKEN=<a GitHub token with repo read access>."; exit 1; }
fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund >/dev/null
chown -R frogbat:frogbat "$APP_DIR"

say "Saving settings to $ENV_FILE"
umask 077
cat > "$ENV_FILE" <<EOF
REPO_URL=$REPO_URL
BOT_TOKEN=$BOT_TOKEN
BOT_USERNAME=$BOT_USERNAME
APP_SHORT_NAME=$APP_SHORT_NAME
PORT=$PORT
DATA_DIR=/var/lib/frogbat
${GIT_TOKEN:+GIT_TOKEN=$GIT_TOKEN}
EOF
umask 022

say "Creating the frogbat service"
cat > /etc/systemd/system/frogbat.service <<EOF
[Unit]
Description=Mortal Frogbat game server and Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
User=frogbat
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
StateDirectory=frogbat
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q frogbat
systemctl restart frogbat

if ! systemctl is-active -q cloudflared 2>/dev/null; then
  ask TUNNEL_TOKEN "Cloudflare Tunnel token (Zero Trust > Networks > Tunnels > your tunnel > install command)" secret
  say "Installing Cloudflare Tunnel"
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null
  cloudflared service install "$TUNNEL_TOKEN" >/dev/null 2>&1 || warn "cloudflared service install reported an error. Check the token."
fi

say "Checking"
sleep 3
if curl -fsS "http://localhost:$PORT/health" >/dev/null; then echo "Game server: running on port $PORT"; else warn "Game server is not answering. See: journalctl -u frogbat -n 50"; fi
systemctl is-active -q cloudflared && echo "Cloudflare Tunnel: running" || warn "Cloudflare Tunnel is not running. See: journalctl -u cloudflared -n 50"
journalctl -u frogbat -n 5 --no-pager | grep -E "Bot @|listening|error" || true

cat <<'EOF'

Done. Useful commands:
  journalctl -u frogbat -f        live logs
  systemctl restart frogbat       restart the game
  re-run this installer           update to the latest code from GitHub
  /var/lib/frogbat/stats.json     leaderboard data (kept across updates)
EOF
