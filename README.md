# SelectaBot 🎛️

> Your personal Zora trading bot for Telegram. Self-hosted, always yours.

Built by [@zak_krevitt](https://zora.co/@zak) · [ZoraCLI Skills](https://github.com/zak802/ZoraCLI_skills)

---

## What It Does

SelectaBot is a Telegram bot that gives you a full Zora trading desk in your pocket:

- **Group Watcher** — auto-buys coins shared in your Telegram group (silent, just watches)
- **DCA Engine** — recurring buys into leaderboard blue chips or any custom coins
- **Growth Engine** — TWAP accumulation with randomized timing (looks organic)
- **Limit Orders** — automated take-profit tiers and stop-loss execution
- **Portfolio** — live P&L in ETH and USD, manage all positions
- **Token Scanner** — drop any Base CA, get instant market data
- **Smart token selection** — auto-uses ETH or $ZORA, whichever you have more of
- **Follow** — watch wallets and get alerts on their activity

---

## Quick Install

### Option A: AI Agent (Claude Code, OpenClaw, Hermes, Cursor)

Tell your agent:

> "Install SelectaBot — follow the instructions in INSTALL.md"

Your agent will read `INSTALL.md` and walk you through setup step by step.

### Option B: Manual

```bash
# 1. Click "Use this template" on GitHub to get your own copy
# then clone it:
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME
cd YOUR_REPO_NAME

# 2. Run setup
bash setup.sh
```

---

## Updating

When new features ship, update with one command:

```bash
bash update.sh
```

Or tell your agent: **"update SelectaBot"**

Your `.env`, `positions.json`, and `state.json` are never touched by updates.

---

## Requirements

- Node.js 20+
- [Zora CLI](https://cli.zora.com) (`npm install -g @zoralabs/cli`)
- A Telegram account + bot token from @BotFather
- ETH on Base chain

---

## After Setup

1. Fund your wallet — send ETH on Base to the address shown by `zora wallet info`
2. Add your bot to a Telegram group
3. DM your bot `/start` for the admin panel
4. Drop any Zora URL in the group — SelectaBot handles the rest

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Open main menu |
| `/portfolio` | View open positions |
| `/balance` | Check wallet balances |
| `/cancel` | Cancel current action |

---

## License

MIT — fork it, ship it, make it yours.
