# SelectaBot — Installation Guide

This guide is written for AI agents (Claude Code, OpenClaw, Hermes, Cursor, etc.) to follow step by step. Ask the user each question before proceeding.

---

## Step 0: Choose Hosting Method

Ask the user:

> "Where do you want to run SelectaBot?"
> 
> **A) VPS or server** (Hostinger, DigitalOcean, Hetzner, etc.) — best performance, ~$4-6/month  
> **B) Railway** — easiest, no server knowledge needed, ~$5/month  
> **C) My own laptop/Mac** — free, but bot stops when laptop sleeps  

Then follow the matching section below.

---

## Option A: VPS / Server

### Prerequisites Check

```bash
node --version     # need v20+
zora --version 2>/dev/null || echo "NOT INSTALLED"
pm2 --version 2>/dev/null || echo "NOT INSTALLED"
```

Install missing tools:
```bash
# Zora CLI
npm install -g @zoralabs/cli --prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# pm2
npm install -g pm2 --prefix ~/.local
```

### Get Telegram Bot Token

1. Message **@BotFather** on Telegram
2. Send `/newbot`, follow prompts
3. Copy the token it gives you

### Get Your Telegram User ID

1. Message **@userinfobot** on Telegram
2. Copy your numeric ID

### Create Zora Wallet

```bash
zora setup --create
```

Show the wallet address to the user:
```bash
zora wallet info
```

Tell them: fund this address with **ETH on Base chain** before trading.

### Write .env

```bash
cat > .env << EOF
TELEGRAM_BOT_TOKEN=PASTE_TOKEN_HERE
ADMIN_TELEGRAM_ID=PASTE_ID_HERE
BUYER_WALLET_PATH=$HOME/.config/zora/wallet.json
DCA_WALLET_PATH=$HOME/.config/zora/wallet.json
EOF
```

### Install & Start

```bash
npm install
pm2 start bot.js --name selectabot
pm2 save
pm2 startup   # makes bot survive server reboots
```

### Verify

```bash
pm2 status
pm2 logs selectabot --lines 10 --nostream
```

DM your bot `/start` — you should see the main menu. ✅

---

## Option B: Railway

### 1. Fork or use the template

Click **"Use this template"** on `github.com/zak802/SelectaBot` to get your own copy on GitHub.

### 2. Deploy to Railway

Go to `railway.app` → New Project → Deploy from GitHub repo → select your copy of SelectaBot.

### 3. Set Environment Variables

In Railway dashboard → your project → Variables tab, add:

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | Your token from @BotFather |
| `ADMIN_TELEGRAM_ID` | Your Telegram user ID (from @userinfobot) |
| `BUYER_WALLET_PATH` | `/app/wallet.json` |
| `DCA_WALLET_PATH` | `/app/wallet.json` |
| `ZORA_PRIVATE_KEY` | Your wallet private key (see below) |

### 4. Create Zora Wallet

Run locally (need Node.js):
```bash
npm install -g @zoralabs/cli --prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"
zora setup --create
cat ~/.config/zora/wallet.json
```

Copy the `privateKey` value → paste as `ZORA_PRIVATE_KEY` in Railway variables.

**Back up the private key somewhere safe.**

### 5. Update bot.js for Railway

Railway uses environment variables directly instead of wallet files. Add to the top of bot.js (or update .env handling):

```js
// In bot.js, the cliEnv() function already reads ZORA_PRIVATE_KEY from env
// No wallet file needed on Railway — just set ZORA_PRIVATE_KEY in dashboard
```

### 6. Deploy

Railway auto-deploys when you push to GitHub. Check the deploy logs in Railway dashboard.

DM your bot `/start` — you should see the main menu. ✅

---

## Option C: Local (Mac/Linux laptop)

### Prerequisites

```bash
node --version     # need v20+
```

Install Zora CLI:
```bash
npm install -g @zoralabs/cli --prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"
```

### Setup

Same as Option A (VPS), but use:
```bash
node bot.js   # instead of pm2
```

Or with pm2 to keep it running in background:
```bash
npm install -g pm2 --prefix ~/.local
pm2 start bot.js --name selectabot
```

**Note:** Bot will stop when you shut down your laptop. For always-on, use Option A or B.

---


## Option D: Other (Docker, Render, Fly.io, custom)

If none of the above match, here's what you need to know so your agent can figure it out:

**Requirements:**
- Node.js 20+
- Bot runs as: `node bot.js`
- No HTTP port needed — uses Telegram long-polling
- Process must stay alive (use your platform's restart policy)

**Environment variables to set:**

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `ADMIN_TELEGRAM_ID` | ✅ | Your Telegram numeric ID |
| `ZORA_PRIVATE_KEY` | ✅ if no wallet file | Private key from wallet.json |
| `BUYER_WALLET_PATH` | ✅ if no ZORA_PRIVATE_KEY | Path to wallet.json |
| `DCA_WALLET_PATH` | ✅ if no ZORA_PRIVATE_KEY | Path to wallet-dca.json (can be same as buyer) |

**Platform quick-start:**

```bash
# Docker
docker run -e TELEGRAM_BOT_TOKEN=... -e ADMIN_TELEGRAM_ID=... -e ZORA_PRIVATE_KEY=... node:20 node bot.js

# Render — set env vars in dashboard, start command: node bot.js

# Fly.io
fly secrets set TELEGRAM_BOT_TOKEN=... ADMIN_TELEGRAM_ID=... ZORA_PRIVATE_KEY=...
fly deploy

# Heroku
heroku config:set TELEGRAM_BOT_TOKEN=... ADMIN_TELEGRAM_ID=... ZORA_PRIVATE_KEY=...
git push heroku main
```

**Getting your Zora private key:**
```bash
npm install -g @zoralabs/cli --prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"
zora setup --create
cat ~/.config/zora/wallet.json   # copy the privateKey value
```

The bot checks for `ZORA_PRIVATE_KEY` in env first, then falls back to wallet files. So on hosted platforms, just set the env var — no file system needed.

## Updating (all options)

### VPS / Local:
```bash
bash update.sh
```

### Railway:
Push to your GitHub repo — Railway auto-deploys.

Or tell your agent: **"update SelectaBot"**

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

**Check wallet balance:**
```bash
zora balance --json
```
