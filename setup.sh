#!/bin/bash
set -e

echo ""
echo "🎛️  SelectaBot Setup"
echo "════════════════════════════════════"
echo ""
echo "Where will SelectaBot run?"
echo ""
echo "  A) VPS or server (Hostinger, DigitalOcean, etc.)"
echo "  B) Railway (easiest, no server needed)"
echo "  C) My laptop / local machine"
echo "  D) Other (Docker, Render, Fly.io, etc.) — describe your setup"
echo ""
read -rp "Choose A, B, C, or D: " HOSTING

case "${HOSTING^^}" in

  A|VPS)
    echo ""
    echo "━━━━ VPS Setup ━━━━"

    # Check/install Zora CLI
    if ! command -v zora &>/dev/null; then
      echo "📦 Installing Zora CLI..."
      npm install -g @zoralabs/cli --prefix ~/.local
      export PATH="$HOME/.local/bin:$PATH"
      echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
    fi

    # Check/install pm2
    if ! command -v pm2 &>/dev/null; then
      echo "📦 Installing pm2..."
      npm install -g pm2 --prefix ~/.local
      export PATH="$HOME/.local/bin:$PATH"
    fi

    echo ""
    echo "━━━━ Telegram Bot ━━━━"
    echo "1. Message @BotFather on Telegram"
    echo "2. Send /newbot and follow the prompts"
    echo "3. Copy the token it gives you"
    echo ""
    read -rp "Paste your bot token: " BOT_TOKEN

    echo ""
    echo "━━━━ Your Telegram ID ━━━━"
    echo "Message @userinfobot on Telegram to get your ID"
    echo ""
    read -rp "Paste your Telegram user ID: " ADMIN_ID

    echo ""
    echo "━━━━ Zora Wallet ━━━━"
    read -rp "Create a new Zora wallet? (y/n): " CREATE_WALLET
    if [ "${CREATE_WALLET,,}" = "y" ]; then
      zora setup --create
      echo ""
      echo "⚠️  Back up ~/.config/zora/wallet.json — this is your private key!"
    fi

    cat > .env << EOF
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
ADMIN_TELEGRAM_ID=$ADMIN_ID
BUYER_WALLET_PATH=$HOME/.config/zora/wallet.json
DCA_WALLET_PATH=$HOME/.config/zora/wallet.json
EOF

    npm install
    pm2 start bot.js --name selectabot && pm2 save
    pm2 startup 2>/dev/null || true

    WALLET_ADDR=$(zora wallet info 2>/dev/null | grep -oE '0x[a-fA-F0-9]{40}' | head -1 || echo "run: zora wallet info")
    echo ""
    echo "════════════════════════════════════"
    echo "🚀 SelectaBot is live!"
    echo ""
    echo "Fund your wallet on Base chain:"
    echo "  $WALLET_ADDR"
    echo ""
    echo "Then DM your bot on Telegram and send /start"
    echo "════════════════════════════════════"
    ;;

  B|RAILWAY)
    echo ""
    echo "━━━━ Railway Setup ━━━━"
    echo ""
    echo "Steps:"
    echo ""
    echo "1. Push this repo to your GitHub account"
    echo "   (click 'Use this template' on github.com/zak802/SelectaBot)"
    echo ""
    echo "2. Go to railway.app → New Project → Deploy from GitHub"
    echo "   Select your copy of SelectaBot"
    echo ""
    echo "3. In Railway Variables tab, add:"
    echo "   TELEGRAM_BOT_TOKEN = (your bot token from @BotFather)"
    echo "   ADMIN_TELEGRAM_ID  = (your ID from @userinfobot)"
    echo "   ZORA_PRIVATE_KEY   = (your wallet private key — see below)"
    echo ""
    echo "━━━━ Creating Zora Wallet ━━━━"
    if ! command -v zora &>/dev/null; then
      npm install -g @zoralabs/cli --prefix ~/.local
      export PATH="$HOME/.local/bin:$PATH"
    fi
    zora setup --create
    echo ""
    echo "Your private key is in ~/.config/zora/wallet.json"
    echo "Copy the 'privateKey' value → paste as ZORA_PRIVATE_KEY in Railway"
    echo ""
    echo "⚠️  Back up this key somewhere safe. Do NOT commit it to GitHub."
    echo ""
    echo "4. Railway auto-deploys once variables are set."
    echo "   DM your bot /start to test."
    echo ""
    echo "To update later: push to GitHub → Railway auto-redeploys"
    ;;

  C|LOCAL)
    echo ""
    echo "━━━━ Local Setup ━━━━"

    if ! command -v zora &>/dev/null; then
      echo "📦 Installing Zora CLI..."
      npm install -g @zoralabs/cli --prefix ~/.local
      export PATH="$HOME/.local/bin:$PATH"
    fi

    echo ""
    echo "━━━━ Telegram Bot ━━━━"
    read -rp "Bot token from @BotFather: " BOT_TOKEN
    read -rp "Your Telegram user ID (@userinfobot): " ADMIN_ID

    read -rp "Create a new Zora wallet? (y/n): " CREATE_WALLET
    if [ "${CREATE_WALLET,,}" = "y" ]; then
      zora setup --create
    fi

    cat > .env << EOF
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
ADMIN_TELEGRAM_ID=$ADMIN_ID
BUYER_WALLET_PATH=$HOME/.config/zora/wallet.json
DCA_WALLET_PATH=$HOME/.config/zora/wallet.json
EOF

    npm install

    echo ""
    echo "════════════════════════════════════"
    echo "✅ Setup complete!"
    echo ""
    echo "Start the bot:"
    echo "  node bot.js"
    echo ""
    echo "Or keep it running in background:"
    echo "  npm install -g pm2 --prefix ~/.local"
    echo "  pm2 start bot.js --name selectabot"
    echo ""
    echo "⚠️  Bot will stop when your laptop sleeps."
    echo "   For always-on, use a VPS or Railway."
    echo "════════════════════════════════════"
    ;;

  D|OTHER)
    echo ""
    echo "━━━━ Custom Hosting Setup ━━━━"
    echo ""
    echo "Describe your hosting environment and this script will"
    echo "output the config you need. The key requirements are:"
    echo ""
    echo "  1. Node.js 20+ available"
    echo "  2. The bot process must stay running (use your platform's"
    echo "     process manager, healthcheck, or restart policy)"
    echo "  3. These environment variables must be set:"
    echo "     - TELEGRAM_BOT_TOKEN"
    echo "     - ADMIN_TELEGRAM_ID"
    echo "     - ZORA_PRIVATE_KEY  (or BUYER_WALLET_PATH + DCA_WALLET_PATH)"
    echo ""
    echo "  4. Start command: node bot.js"
    echo "  5. No port binding needed — bot uses Telegram polling, not HTTP"
    echo ""
    echo "Platform-specific notes:"
    echo "  Docker:  use ENV in Dockerfile or --env-file flag"
    echo "  Render:  set env vars in dashboard, start cmd = 'node bot.js'"
    echo "  Fly.io:  fly secrets set TELEGRAM_BOT_TOKEN=... then fly deploy"
    echo "  Heroku:  heroku config:set TELEGRAM_BOT_TOKEN=..."
    echo ""

    if ! command -v zora &>/dev/null; then
      echo "━━━━ Installing Zora CLI ━━━━"
      npm install -g @zoralabs/cli --prefix ~/.local
      export PATH="$HOME/.local/bin:$PATH"
    fi

    echo "━━━━ Generate wallet key for env var ━━━━"
    read -rp "Create a new Zora wallet? (y/n): " CREATE_WALLET
    if [ "${CREATE_WALLET,,}" = "y" ]; then
      zora setup --create
      PK=$(python3 -c "import json; print(json.load(open('$HOME/.config/zora/wallet.json'))['privateKey'])" 2>/dev/null || echo "check ~/.config/zora/wallet.json")
      echo ""
      echo "Set this as ZORA_PRIVATE_KEY in your platform:"
      echo "  $PK"
      echo ""
      echo "⚠️  Back this up. Do NOT commit to GitHub."
    fi

    echo ""
    echo "For AI agents: read INSTALL.md — the 'Other' section has"
    echo "platform-agnostic instructions your agent can adapt."
    ;;

  *)
    echo "❌ Please choose A, B, C, or D"
    exit 1
    ;;
esac
