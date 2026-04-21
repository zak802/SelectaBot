# ZoraCLI Bot

> Your own Telegram trading bot for Zora coins on Base, powered by the [Zora CLI](https://cli.zora.com).

Built by [@zak_krevitt](https://zora.co/@zak) · [ZoraCLI Skills](https://github.com/zak802/ZoraCLI_skills)

---

## Features

- **Group Watcher** — auto-buys Zora coins when URLs are shared in your Telegram group
- **DCA Engine** — recurring buys into leaderboard blue chips or custom coins
- **Growth Engine** — TWAP-style accumulation with randomized timing
- **Limit Orders** — automated take-profit tiers and stop-loss execution
- **Portfolio** — live P&L in ETH and USD, manage all positions
- **Token Scanner** — drop any Base CA, get instant market data
- **Smart token selection** — auto-uses ETH or $ZORA, whichever you have more of

---

## Quick Start

### Prerequisites

- Node.js 20+
- A Telegram account
- ETH on Base chain to trade with

### Install

```bash
# 1. Use this template (click "Use this template" on GitHub)
# then clone your new repo:
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME
cd YOUR_REPO_NAME

# 2. Add upstream for updates
git remote add upstream https://github.com/zak802/zoraCLI-bot-template

# 3. Run setup wizard
bash setup.sh
```

The wizard will:
- Install the Zora CLI if needed
- Walk you through creating a Telegram bot via @BotFather
- Create your trading wallet
- Start the bot via PM2

---

## Updating

When updates are published, tell your AI agent:

> "Update the zak bot"

Or run manually:

```bash
git pull upstream main
pm2 restart zoraCLI-bot
```

Your `.env`, `positions.json`, and `state.json` are never touched by updates.

---

## Usage

1. **Fund your wallet** — send ETH on Base to the address shown by `zora wallet info`
2. **Add bot to group** — add your bot to any Telegram group
3. **DM your bot** — send `/start` for the admin panel
4. **Drop a coin** — paste any zora.co URL or Base contract address in the group

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Open main menu |
| `/portfolio` | View open positions |
| `/balance` | Check wallet balances |
| `/scan <0x...>` | Quick token scan |
| `/dca setup` | Configure DCA engine |
| `/cancel` | Cancel current action |

---

## License

MIT — fork it, ship it, make it yours.
