#!/bin/bash
set -e

echo ""
echo "🐸 ZoraCLI Bot Setup"
echo "════════════════════════════════════"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org (v20+)"
  exit 1
fi

# Check/install Zora CLI
if ! command -v zora &>/dev/null; then
  echo "📦 Installing Zora CLI..."
  npm install -g @zoralabs/cli --prefix ~/.local
  export PATH="$HOME/.local/bin:$PATH"
  echo "✅ Zora CLI installed"
else
  echo "✅ Zora CLI found: $(zora --version 2>/dev/null | head -1)"
fi

echo ""
echo "━━━━ Step 1: Telegram Bot ━━━━"
echo "1. Open Telegram and message @BotFather"
echo "2. Send /newbot and follow the prompts"
echo "3. Copy the token it gives you"
echo ""
read -rp "Paste your Telegram bot token: " BOT_TOKEN

echo ""
echo "━━━━ Step 2: Your Telegram ID ━━━━"
echo "1. Message @userinfobot on Telegram"
echo "2. It will reply with your user ID"
echo ""
read -rp "Paste your Telegram user ID: " ADMIN_ID

echo ""
echo "━━━━ Step 3: Zora Wallet ━━━━"
echo "Creating a new Zora wallet (or press Enter to use existing)..."
echo ""
read -rp "Create new wallet? (y/n): " CREATE_WALLET

if [ "$CREATE_WALLET" = "y" ]; then
  zora setup --create
  echo ""
  echo "⚠️  IMPORTANT: Back up ~/.config/zora/wallet.json — this is your wallet!"
fi

WALLET_PATH="$HOME/.config/zora/wallet.json"

echo ""
echo "━━━━ Step 4: DCA Wallet (optional) ━━━━"
echo "Use a separate wallet for DCA buys? (recommended for tracking)"
read -rp "Create DCA wallet? (y/n): " CREATE_DCA

if [ "$CREATE_DCA" = "y" ]; then
  ZORA_WALLET_PATH="$HOME/.config/zora/wallet-dca.json" zora setup --create 2>/dev/null || true
  DCA_WALLET_PATH="$HOME/.config/zora/wallet-dca.json"
else
  DCA_WALLET_PATH="$WALLET_PATH"
fi

echo ""
echo "━━━━ Writing config ━━━━"
cat > .env << EOF
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
ADMIN_TELEGRAM_ID=$ADMIN_ID
BUYER_WALLET_PATH=$WALLET_PATH
DCA_WALLET_PATH=$DCA_WALLET_PATH
EOF

echo "✅ .env created"

echo ""
echo "━━━━ Installing dependencies ━━━━"
npm install

echo ""
echo "━━━━ Starting bot ━━━━"
if command -v pm2 &>/dev/null; then
  pm2 start bot.js --name zoraCLI-bot && pm2 save
  echo "✅ Bot running via PM2"
else
  npm install -g pm2 --prefix ~/.local 2>/dev/null || true
  export PATH="$HOME/.local/bin:$PATH"
  pm2 start bot.js --name zoraCLI-bot && pm2 save
fi

echo ""
echo "════════════════════════════════════"
echo "🚀 ZoraCLI Bot is live!"
echo ""
echo "→ DM your bot on Telegram and send /start"
echo "→ Fund your wallet: $(zora wallet info 2>/dev/null | grep Address || echo 'run: zora wallet info')"
echo ""
echo "To update later: git pull upstream main && pm2 restart zoraCLI-bot"
echo "════════════════════════════════════"
