#!/bin/bash
# semantic-relay demo — EC2 t2.micro bootstrap script
# Run on: Amazon Linux 2023
# Usage: bash deploy.sh
set -e

echo ""
echo "=== semantic-relay-ai deployment ==="
echo ""

# ── Node.js 20 ────────────────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo "[1/5] Installing Node.js 20..."
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo yum install -y nodejs
else
  echo "[1/5] Node.js already installed: $(node --version)"
fi

# ── PM2 ───────────────────────────────────────────────────────────────────────
if ! command -v pm2 &> /dev/null; then
  echo "[2/5] Installing PM2..."
  sudo npm install -g pm2
else
  echo "[2/5] PM2 already installed: $(pm2 --version)"
fi

# ── Clone or update repo ──────────────────────────────────────────────────────
APP_DIR="/home/ec2-user/semantic-relay-ai"
echo "[3/5] Fetching latest code..."
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull origin main
else
  git clone https://github.com/Varundhyani69/Semantic-Relay-AI.git "$APP_DIR"
fi

# ── Install dependencies ──────────────────────────────────────────────────────
echo "[4/5] Installing dependencies..."
cd "$APP_DIR/semantic-relay" && npm install
cd "$APP_DIR/semantic-relay-demo" && npm install

# ── Environment setup ─────────────────────────────────────────────────────────
ENV_FILE="$APP_DIR/semantic-relay-demo/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/semantic-relay-demo/.env.example" "$ENV_FILE"
  echo ""
  echo "┌─────────────────────────────────────────────────────────┐"
  echo "│  ACTION REQUIRED                                        │"
  echo "│  Edit $ENV_FILE          │"
  echo "│  and add your real API keys:                            │"
  echo "│    COHERE_API_KEY=your_key_here                         │"
  echo "│    GEMINI_API_KEY=your_key_here                         │"
  echo "│  Then re-run: bash deploy.sh                            │"
  echo "└─────────────────────────────────────────────────────────┘"
  echo ""
  exit 0
fi

# ── Start / restart with PM2 ──────────────────────────────────────────────────
echo "[5/5] Starting server..."
cd "$APP_DIR/semantic-relay-demo"
pm2 delete semantic-relay-demo 2>/dev/null || true
pm2 start server.js \
  --name semantic-relay-demo \
  --env production

# Persist across reboots
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true
pm2 save

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== Deployment complete ==="
echo ""
pm2 status semantic-relay-demo --no-color 2>/dev/null | head -6
echo ""
PUBLIC_IP=$(curl -s --max-time 2 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "check-aws-console")
echo "  Demo URL:    http://$PUBLIC_IP:3100"
echo "  AI status:   curl http://$PUBLIC_IP:3100/api/ai-decisions"
echo "  Metrics:     curl http://$PUBLIC_IP:3100/api/metrics"
echo ""
echo "  To test graceful degradation:"
echo "    1. Edit .env — set COHERE_API_KEY=invalid"
echo "    2. pm2 restart semantic-relay-demo"
echo "    3. Run benchmark — aiStatus should show 'degraded'"
echo ""
