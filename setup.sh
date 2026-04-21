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
echo ""
read -rp "Choose A, B, or C: " HOSTING

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

  *)
    echo "❌ Please choose A, B, or C"
    exit 1
    ;;
esac
