# SelectaBot — Installation Guide

This guide is written for AI agents (Claude Code, OpenClaw, Hermes, Cursor, etc.) to follow step by step. Run each step in order.

---

## Prerequisites Check

```bash
# Check Node.js (need v20+)
node --version

# Check Zora CLI
zora --version 2>/dev/null || echo "NOT INSTALLED"

# Check pm2
pm2 --version 2>/dev/null || echo "NOT INSTALLED"
```

Install anything missing:
```bash
# Zora CLI
npm install -g @zoralabs/cli --prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"

# pm2 (process manager to keep bot running)
npm install -g pm2 --prefix ~/.local
```

---

## Step 1: Get a Telegram Bot Token

1. Open Telegram and message **@BotFather**
2. Send `/newbot`
3. Follow the prompts — choose a name and username
4. Copy the token it gives you (looks like `8573527678:AAH3Ez...`)

Ask the user to paste their token here before continuing.

---

## Step 2: Get Your Telegram User ID

1. Message **@userinfobot** on Telegram
2. It replies with your numeric ID (e.g. `178754373`)

Ask the user to paste their ID here before continuing.

---

## Step 3: Create a Zora Wallet

```bash
zora setup --create
```

This creates a wallet at `~/.config/zora/wallet.json`.

**Important:** Tell the user to back up `~/.config/zora/wallet.json` — it contains their private key. No backup = no recovery if lost.

Show them the wallet address:
```bash
zora wallet info
```

Tell them to fund this address with ETH on **Base chain** before trading.

---

## Step 4: (Optional) Create a Separate DCA Wallet

For tracking DCA performance separately from manual buys:

```bash
cp ~/.config/zora/wallet.json ~/.config/zora/wallet-buyer.json
zora setup --create  # creates a new wallet at wallet.json
cp ~/.config/zora/wallet.json ~/.config/zora/wallet-dca.json
cp ~/.config/zora/wallet-buyer.json ~/.config/zora/wallet.json
```

Or skip this and use the same wallet for everything (set both paths to `wallet.json`).

---

## Step 5: Write the .env File

Create a file called `.env` in the SelectaBot directory:

```bash
cat > .env << EOF
TELEGRAM_BOT_TOKEN=<paste token from Step 1>
ADMIN_TELEGRAM_ID=<paste ID from Step 2>
BUYER_WALLET_PATH=$HOME/.config/zora/wallet.json
DCA_WALLET_PATH=$HOME/.config/zora/wallet-dca.json
EOF
```

If using one wallet for everything:
```bash
cat > .env << EOF
TELEGRAM_BOT_TOKEN=<token>
ADMIN_TELEGRAM_ID=<id>
BUYER_WALLET_PATH=$HOME/.config/zora/wallet.json
DCA_WALLET_PATH=$HOME/.config/zora/wallet.json
EOF
```

---

## Step 6: Install Dependencies

```bash
npm install
```

---

## Step 7: Start the Bot

```bash
pm2 start bot.js --name selectabot
pm2 save
```

Verify it's running:
```bash
pm2 status
pm2 logs selectabot --lines 10 --nostream
```

---

## Step 8: Test

1. Open Telegram
2. Find your bot by the username you gave it in Step 1
3. Send `/start`
4. You should see the main menu

---

## Done! 🎉

Your SelectaBot is live. Fund your wallet and start trading.

---

## Updating

When updates are released, run:

```bash
bash update.sh
```

Or tell your AI agent: **"update SelectaBot"**

---

## Troubleshooting

**Bot not responding:**
```bash
pm2 logs selectabot --lines 20 --nostream
pm2 restart selectabot
```

**Zora CLI not found:**
```bash
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

**Wrong wallet balance:**
```bash
zora balance --json
```
