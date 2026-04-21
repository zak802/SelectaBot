/**
 * 🐸 Zora Combined Bot
 * ─────────────────────────────────────────────────────────────────────────────
 * Modules:
 *   1. Group Watcher  — watches Telegram groups for Zora URLs / 0x addresses
 *   2. DCA Engine     — periodic leaderboard DCA + custom coin DCA
 *   3. Growth Engine  — TWAP-style repeated buys over time
 *   4. Position Mgr   — unified tracker with per-coin TP overrides, SL, watcher
 */

require('dotenv').config();
const TelegramBot  = require('node-telegram-bot-api');
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const https        = require('https');

// ── SDK (fast price fetching) ──────────────────────────────────────────────────
let sdkGetCoin = null;
try {
  const sdk = require('/home/node/.local/lib/node_modules/@zoralabs/cli/node_modules/@zoralabs/coins-sdk');
  sdkGetCoin = sdk.getCoin;
} catch { console.log('[SDK] coins-sdk not available, falling back to CLI'); }

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN            = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID         = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
const BUYER_WALLET     = process.env.BUYER_WALLET_PATH;
const DCA_WALLET       = process.env.DCA_WALLET_PATH;
const ZORA_CLI         = path.join(process.env.HOME, '.local/bin/zora');
const STATE_FILE       = path.join(__dirname, 'state.json');
const POSITIONS_FILE   = path.join(__dirname, 'positions.json');
const LOG_FILE         = path.join(__dirname, 'bot.log');

if (!TOKEN || !ADMIN_ID) { console.error('Missing env vars'); process.exit(1); }

// ── Address lookup (Telegram 64-byte callback_data limit) ────────────────────
const addrLookup = {};
// Rebuilt from positions on startup to survive restarts
function addrKey(address) {
  const k = 'a' + address.slice(2, 10).toLowerCase();
  addrLookup[k] = address;
  return k;
}
function addrFromKey(k) { return addrLookup[k] || k; }

// ── State ─────────────────────────────────────────────────────────────────────
function defaultState() {
  return {
    watcherEnabled: true,
    autoMode: true,
    ethAmount: 0.005,
    buyAmountMode: 'eth', // 'eth' or 'usd'
    stopLossPct: 20,
    watcherPriceCheckEnabled: true,
    tpOrders: [
      { pct: 25, sellPct: 33 },
      { pct: 50, sellPct: 33 },
      { pct: 100, sellPct: 34 },
    ],
    dca: {
      enabled: false,
      intervalHours: 6,
      ethPerCoin: 0.002,
      maxCoins: 5,
      minMcap: 100000,
      minHolders: 1000,
      slPct: 15,
      nextDcaAt: null,
      lastDcaAt: null,
      customCoins: [], // [{ address, name, ethPerCycle }]
    },
  };
}
function loadState() {
  if (fs.existsSync(STATE_FILE)) return { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  return defaultState();
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
let state = loadState();

// Migrate old single-TP state
if (!state.tpOrders) {
  state.tpOrders = [{ pct: state.takeProfitPct || 25, sellPct: state.sellPct || 100 }];
  delete state.takeProfitPct; delete state.sellPct;
  saveState(state);
}
if (!state.dca) { state.dca = defaultState().dca; saveState(state); }

function loadPositions() {
  if (fs.existsSync(POSITIONS_FILE)) return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
  return {};
}
function savePositions(p) { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }
let positions = loadPositions();

// ── Growth Engines (in-memory) ────────────────────────────────────────────────
// engineId -> { address, coinName, total, remaining, ethPerBuy, intervalMs, walletPath, timer }
const activeEngines = {};

// ── Wizard sessions ───────────────────────────────────────────────────────────
// chatId -> { type, step, data, createdAt }
const sessions = {};

// Expire stale sessions after 10 min (in case user walks away mid-wizard)
setInterval(() => {
  const TTL = 10 * 60 * 1000;
  const now = Date.now();
  let cleaned = 0;
  for (const k of Object.keys(sessions)) {
    if (!sessions[k].createdAt || now - sessions[k].createdAt > TTL) {
      delete sessions[k]; cleaned++;
    }
  }
  if (cleaned > 0) console.log('[cleanup] Expired ' + cleaned + ' stale session(s)');
}, 5 * 60 * 1000);

// DexScreener rate limiter: 1 req/sec to avoid 429s
let _lastDexCall = 0;
async function dexFetchRL(url) {
  const wait = Math.max(0, 1100 - (Date.now() - _lastDexCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastDexCall = Date.now();
  return dexFetch(url);
}

// ── Logging ───────────────────────────────────────────────────────────────────
const LOG_MAX_BYTES = 500 * 1024; // 500KB max log size
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try {
    // Rotate log if too large
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > LOG_MAX_BYTES) {
        fs.renameSync(LOG_FILE, LOG_FILE + '.old');
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// ── Bot ───────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

// ── CLI helpers ───────────────────────────────────────────────────────────────
function walletKey(walletPath) {
  try { return JSON.parse(fs.readFileSync(walletPath, 'utf8')).privateKey; }
  catch { return null; }
}
function cliEnv(walletPath) {
  const pk = walletKey(walletPath);
  return { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH, ...(pk ? { ZORA_PRIVATE_KEY: pk } : {}) };
}

// Determine best token to spend (ETH vs $ZORA — whichever has more USD value)
function getBestToken(walletPath) {
  try {
    const bal = getBalance(walletPath);
    const tokens = bal?.wallet || [];
    const eth  = tokens.find(t => t.symbol === 'ETH');
    const zora = tokens.find(t => t.symbol === 'ZORA' || t.symbol === 'zora');
    if (zora && parseFloat(zora.usdValue || 0) > parseFloat(eth?.usdValue || 0)) {
      log('[token] Using $ZORA (\$' + parseFloat(zora.usdValue).toFixed(2) + ' vs ETH \$' + parseFloat(eth?.usdValue||0).toFixed(2) + ')');
      return 'zora';
    }
    return 'eth';
  } catch { return 'eth'; }
}

function executeBuy(address, eth, walletPath) {
  try {
    const token = getBestToken(walletPath);
    const cmd = ZORA_CLI + ' buy ' + address + ' --eth ' + eth + ' --token ' + token + ' --yes --json';
    const out = execSync(cmd, { env: cliEnv(walletPath) }).toString();
    return { success: true, data: JSON.parse(out), token };
  } catch (e) { return { success: false, error: e.message.slice(0, 200) }; }
}
function executeSell(address, pct, walletPath) {
  try {
    const out = execSync(ZORA_CLI + ' sell ' + address + ' --percent ' + pct + ' --yes --json', { env: cliEnv(walletPath) }).toString();
    return { success: true, data: JSON.parse(out) };
  } catch (e) { return { success: false, error: e.message.slice(0, 200) }; }
}
function getBalance(walletPath) {
  try {
    const out = execSync(ZORA_CLI + ' balance --json', { env: cliEnv(walletPath) }).toString();
    return JSON.parse(out);
  } catch { return null; }
}

// ── Price fetching (SDK fast path, CLI fallback) ──────────────────────────────
async function fetchPrice(address) {
  if (sdkGetCoin) {
    try {
      const r = await sdkGetCoin({ address });
      const c = r?.data?.zora20Token;
      if (c) return { name: c.name, priceUsd: parseFloat(c.marketCap || 0) / 1e9, marketCap: parseFloat(c.marketCap || 0), uniqueHolders: c.uniqueHolders };
    } catch {}
  }
  // CLI fallback
  try {
    const out = execSync(ZORA_CLI + ' get ' + address + ' --json', { env: cliEnv(BUYER_WALLET) }).toString();
    const d = JSON.parse(out);
    const priceUsd = d.priceUsd || (parseFloat(d.marketCap || 0) / 1e9);
    return { name: d.name, priceUsd, marketCap: parseFloat(d.marketCap || 0), uniqueHolders: d.uniqueHolders };
  } catch { return null; }
}
async function fetchPriceBulk(addresses) {
  const results = await Promise.all(addresses.map(a => fetchPrice(a)));
  const map = {};
  addresses.forEach((a, i) => { map[a] = results[i]; });
  return map;
}

// ── URL / address detection ───────────────────────────────────────────────────
const ZORA_RE   = /https?:\/\/(?:www\.)?zora\.co\/(?:coin\/(0x[a-fA-F0-9]{40})|collect\/base:(0x[a-fA-F0-9]{40}))/g;
const ADDR_RE   = /(?:^|\s)(0x[a-fA-F0-9]{40})(?:\s|$)/gm;
function extractAddresses(text) {
  const addrs = []; let m;
  const u = new RegExp(ZORA_RE.source, 'g');
  while ((m = u.exec(text)) !== null) addrs.push(m[1] || m[2]);
  const a = new RegExp(ADDR_RE.source, 'gm');
  while ((m = a.exec(text)) !== null) addrs.push(m[1]);
  return [...new Set(addrs)];
}

// ── Position helpers ──────────────────────────────────────────────────────────
function getEffectiveTps(pos) { return pos.customTpOrders || state.tpOrders; }
function ensureTpHits(pos) {
  const tps = getEffectiveTps(pos);
  if (!pos.tpHits || pos.tpHits.length !== tps.length) pos.tpHits = new Array(tps.length).fill(false);
}

// ── Buy flow (group watcher) ──────────────────────────────────────────────────
async function handleGroupBuy(address, groupName, fromUser) {
  const coin = await fetchPrice(address);
  const coinName = coin?.name || address.slice(0, 10) + '...';
  const buyPriceUsd = coin?.priceUsd || null;
  const tpSummary = state.tpOrders.map((t, i) => 'TP' + (i+1) + ': +' + t.pct + '% sell ' + t.sellPct + '%').join(' | ');

  log('Group buy: ' + coinName + ' from ' + fromUser + ' in ' + groupName);

  if (state.autoMode) {
    const result = executeBuy(address, state.ethAmount, BUYER_WALLET);
    if (result.success) {
      const tx = result.data?.txHash || result.data?.transactionHash || 'pending';
      positions[address] = {
        coinName, address, buyPriceUsd, boughtAt: Date.now(),
        ethSpent: state.ethAmount, source: 'watcher',
        tpHits: new Array(state.tpOrders.length).fill(false),
        customTpOrders: null, fullyExited: false,
      };
      savePositions(positions);
      addrKey(address); // register in lookup
      bot.sendMessage(ADMIN_ID,
        '🛒 *Bought ' + coinName + '*\n' + state.ethAmount + ' ETH\n' + tpSummary + '\nSL: -' + state.stopLossPct + '%\nTx: `' + tx + '`\nFrom @' + fromUser + ' in ' + (groupName || 'group'),
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: '⚙️ Configure ' + coinName, callback_data: 'pd_' + addrKey(address) }],
          [{ text: '📊 Positions', callback_data: 'positions' }],
        ]}}
      );
      log('Bought ' + coinName + ' tx:' + tx);
    } else {
      bot.sendMessage(ADMIN_ID, '❌ Buy failed: *' + coinName + '*\n`' + result.error + '`', { parse_mode: 'Markdown' });
      log('Buy failed ' + coinName + ': ' + result.error);
    }
  } else {
    const key = 'pend_' + Date.now();
    sessions[key] = { address, coinName, buyPriceUsd };
    bot.sendMessage(ADMIN_ID,
      '🔔 *' + coinName + '* shared in ' + (groupName || 'group') + '\nBy @' + fromUser + '\nBuy for *' + state.ethAmount + ' ETH*?',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '✅ Buy', callback_data: 'pby_' + key },
        { text: '❌ Skip', callback_data: 'psk_' + key },
      ]]}}
    );
  }
}

// ── DCA cycle ─────────────────────────────────────────────────────────────────
async function runDcaCycle() {
  if (!state.dca.enabled) return;
  log('=== DCA CYCLE START ===');
  bot.sendMessage(ADMIN_ID, '🔄 *DCA cycle starting...*', { parse_mode: 'Markdown' });

  const bal = getBalance(DCA_WALLET);
  const ethBal = parseFloat(bal?.wallet?.[0]?.balance || '0');
  log('DCA wallet balance: ' + ethBal + ' ETH');

  if (ethBal <= 0) {
    bot.sendMessage(ADMIN_ID, '⚠️ DCA wallet empty! Top up: `' + (JSON.parse(fs.readFileSync(DCA_WALLET)).address) + '`', { parse_mode: 'Markdown' });
    return;
  }

  // ── Leaderboard coins ──
  let leaderboardCoins = [];
  try {
    const out = execSync(ZORA_CLI + ' explore --sort mcap --json', { env: cliEnv(DCA_WALLET) }).toString();
    const all = JSON.parse(out).coins || [];
    leaderboardCoins = all
      .filter(c => c.marketCap >= state.dca.minMcap && c.uniqueHolders >= state.dca.minHolders && !c.platformBlocked)
      .slice(0, state.dca.maxCoins);
  } catch (e) { log('Leaderboard fetch failed: ' + e.message); }

  // ── Custom coins ──
  const customCoins = state.dca.customCoins || [];

  const allToBuy = [
    ...leaderboardCoins.map(c => ({ address: c.address, name: c.name, eth: state.dca.ethPerCoin, priceUsd: c.priceUsd })),
    ...customCoins.map(c => ({ address: c.address, name: c.name, eth: c.ethPerCycle, priceUsd: null })),
  ];

  if (allToBuy.length === 0) {
    bot.sendMessage(ADMIN_ID, '⚠️ No coins to DCA into this cycle.');
    return;
  }

  const summary = [];
  for (const coin of allToBuy) {
    if (ethBal < coin.eth) { summary.push('⚠️ ' + coin.name + ' (insufficient balance)'); continue; }
    log('DCA buying ' + coin.name + ' for ' + coin.eth + ' ETH');
    const result = executeBuy(coin.address, coin.eth, DCA_WALLET);
    if (result.success) {
      const tx = result.data?.txHash || result.data?.transactionHash || 'pending';
      addrKey(coin.address);
      if (!positions[coin.address]) {
        positions[coin.address] = {
          coinName: coin.name, address: coin.address,
          buyPriceUsd: coin.priceUsd, avgBuyPrice: coin.priceUsd,
          totalEthSpent: coin.eth, buyCount: 1,
          boughtAt: Date.now(), source: 'dca',
          tpHits: new Array(state.tpOrders.length).fill(false),
          customTpOrders: null, fullyExited: false,
        };
      } else {
        const pos = positions[coin.address];
        if (pos.avgBuyPrice && coin.priceUsd) {
          const total = pos.totalEthSpent + coin.eth;
          pos.avgBuyPrice = ((pos.avgBuyPrice * pos.totalEthSpent) + (coin.priceUsd * coin.eth)) / total;
          pos.totalEthSpent = total;
        }
        pos.buyCount = (pos.buyCount || 1) + 1;
      }
      savePositions(positions);
      summary.push('✅ ' + coin.name + ' @$' + (coin.priceUsd?.toFixed(6) || '?'));
      log('DCA bought ' + coin.name + ' tx:' + tx);
    } else {
      summary.push('❌ ' + coin.name + ' (failed)');
      log('DCA buy failed ' + coin.name + ': ' + result.error);
    }
  }

  state.dca.lastDcaAt = Date.now();
  state.dca.nextDcaAt = Date.now() + state.dca.intervalHours * 3600000;
  saveState(state);

  bot.sendMessage(ADMIN_ID,
    '✅ *DCA Cycle Complete*\n\n' + summary.join('\n') + '\n\nNext: ' + new Date(state.dca.nextDcaAt).toUTCString(),
    { parse_mode: 'Markdown' }
  );
  log('=== DCA CYCLE END ===');
}

// DCA interval timer
let dcaTimer = null;
function scheduleDca() {
  if (dcaTimer) clearInterval(dcaTimer);
  dcaTimer = setInterval(() => {
    if (state.dca.enabled) runDcaCycle();
  }, state.dca.intervalHours * 3600000);
}
scheduleDca();

// ── Growth Engine ─────────────────────────────────────────────────────────────
// Randomize a value by ±variance (0.15 = ±15%)
function jitter(value, variance) {
  const factor = 1 + (Math.random() * 2 - 1) * variance;
  return Math.max(0.0001, value * factor);
}

function startGrowthEngine(engineId, address, coinName, totalBuys, ethPerBuy, intervalMs, variance) {
  const v = (variance !== undefined) ? variance : 0.15; // default ±15%
  const engine = { address, coinName, total: totalBuys, remaining: totalBuys, ethPerBuy, intervalMs, variance: v, done: 0, totalSpent: 0 };
  activeEngines[engineId] = engine;

  function doBuy() {
    if (!activeEngines[engineId]) return; // cancelled
    const eng = activeEngines[engineId];
    if (eng.remaining <= 0) {
      bot.sendMessage(ADMIN_ID, '🏁 *Growth Engine Complete!*\n*' + eng.coinName + '*\nActual spent: ' + eng.totalSpent.toFixed(5) + ' ETH over ' + eng.total + ' buys', { parse_mode: 'Markdown' });
      delete activeEngines[engineId];
      return;
    }
    // Randomize amount and interval
    const thisEth = parseFloat(jitter(eng.ethPerBuy, eng.variance).toFixed(5));
    const nextInterval = Math.round(jitter(eng.intervalMs, eng.variance));
    const current = eng.total - eng.remaining + 1;

    log('[growth] Buy ' + current + '/' + eng.total + ' ' + eng.coinName + ' ' + thisEth + ' ETH (next in ' + Math.round(nextInterval/1000) + 's)');
    const result = executeBuy(eng.address, thisEth, BUYER_WALLET);

    if (result.success) {
      const tx = result.data?.txHash || result.data?.transactionHash || 'pending';
      eng.remaining--;
      eng.done++;
      eng.totalSpent += thisEth;
      addrKey(eng.address);

      // Fetch price for P&L tracking (async, don't block)
      fetchPrice(eng.address).then(priceData => {
        const currentPrice = priceData?.priceUsd || null;
        if (!positions[eng.address]) {
          positions[eng.address] = {
            coinName: eng.coinName, address: eng.address,
            buyPriceUsd: currentPrice,
            avgBuyPrice: currentPrice,
            boughtAt: Date.now(),
            ethSpent: thisEth, source: 'growth',
            tpHits: new Array(state.tpOrders.length).fill(false),
            customTpOrders: null, fullyExited: false,
          };
        } else {
          const pos = positions[eng.address];
          // DCA-average the buy price
          if (currentPrice && pos.avgBuyPrice) {
            const totalEth = pos.ethSpent + thisEth;
            pos.avgBuyPrice = ((pos.avgBuyPrice * pos.ethSpent) + (currentPrice * thisEth)) / totalEth;
          } else if (currentPrice && !pos.avgBuyPrice) {
            pos.avgBuyPrice = currentPrice;
            pos.buyPriceUsd = currentPrice;
          }
          pos.ethSpent = (pos.ethSpent || 0) + thisEth;
        }
        savePositions(positions);
      }).catch(() => {
        // Price fetch failed — still track position without price
        if (!positions[eng.address]) {
          positions[eng.address] = {
            coinName: eng.coinName, address: eng.address,
            buyPriceUsd: null, avgBuyPrice: null,
            boughtAt: Date.now(), ethSpent: thisEth, source: 'growth',
            tpHits: new Array(state.tpOrders.length).fill(false),
            customTpOrders: null, fullyExited: false,
          };
        } else {
          positions[eng.address].ethSpent = (positions[eng.address].ethSpent || 0) + thisEth;
        }
        savePositions(positions);
      });
      savePositions(positions);
      bot.sendMessage(ADMIN_ID, '⚡ Growth ' + current + '/' + eng.total + ' *' + eng.coinName + '* ✅\n' + thisEth + ' ETH | Tx: `' + tx + '`', { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(ADMIN_ID, '❌ Growth buy ' + current + '/' + eng.total + ' failed: `' + result.error + '`', { parse_mode: 'Markdown' });
      eng.remaining--;
    }
    if (eng.remaining > 0 && activeEngines[engineId]) {
      eng.timer = setTimeout(doBuy, nextInterval);
    } else if (eng.remaining <= 0) {
      bot.sendMessage(ADMIN_ID, '🏁 *Growth Engine Complete!*\n*' + eng.coinName + '*\nActual spent: ' + eng.totalSpent.toFixed(5) + ' ETH', { parse_mode: 'Markdown' });
      delete activeEngines[engineId];
    }
  }

  activeEngines[engineId].timer = setTimeout(doBuy, 100); // start immediately
}

// ── Price Watcher ─────────────────────────────────────────────────────────────
setInterval(async () => {
  if (!state.watcherPriceCheckEnabled) return;
  const addrs = Object.keys(positions).filter(a => !positions[a].fullyExited);
  if (!addrs.length) return;
  log('[watcher] Checking ' + addrs.length + ' positions');

  const priceMap = await fetchPriceBulk(addrs);

  for (const address of addrs) {
    const pos = positions[address];
    const ref = pos.avgBuyPrice || pos.buyPriceUsd;
    if (!ref) continue;
    const coin = priceMap[address];
    if (!coin?.priceUsd) continue;

    const chg = ((coin.priceUsd - ref) / ref) * 100;
    const chgStr = (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%';
    const activeTps = getEffectiveTps(pos);
    ensureTpHits(pos);
    const slPct = pos.source === 'dca' ? state.dca.slPct : state.stopLossPct;

    // Fire TPs
    for (let i = 0; i < activeTps.length; i++) {
      if (pos.tpHits[i]) continue;
      if (chg >= activeTps[i].pct) {
        bot.sendMessage(ADMIN_ID, '🟢 *TP' + (i+1) + ' triggered!* ' + pos.coinName + ' ' + chgStr + '\nSelling ' + activeTps[i].sellPct + '%...', { parse_mode: 'Markdown' });
        const walletPath = pos.source === 'dca' ? DCA_WALLET : BUYER_WALLET;
        const r = executeSell(address, activeTps[i].sellPct, walletPath);
        if (r.success) {
          pos.tpHits[i] = true;
          const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
          bot.sendMessage(ADMIN_ID, '✅ TP' + (i+1) + ' sold ' + activeTps[i].sellPct + '% of *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
          if (i === activeTps.length - 1) pos.fullyExited = true;
        } else {
          bot.sendMessage(ADMIN_ID, '❌ TP' + (i+1) + ' sell failed: *' + pos.coinName + '*\n`' + r.error + '`', { parse_mode: 'Markdown' });
        }
        break;
      }
    }

    // Stop loss
    if (!pos.fullyExited && chg <= -Math.abs(slPct)) {
      bot.sendMessage(ADMIN_ID, '🔴 *Stop-Loss!* ' + pos.coinName + ' ' + chgStr + '\nSelling 100%...', { parse_mode: 'Markdown' });
      const walletPath = pos.source === 'dca' ? DCA_WALLET : BUYER_WALLET;
      const r = executeSell(address, 100, walletPath);
      if (r.success) {
        pos.fullyExited = true;
        const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
        bot.sendMessage(ADMIN_ID, '✅ SL exit *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
      }
    }

    savePositions(positions);
  }
}, 5 * 60 * 1000);

// ── Group message handler ─────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const isAdmin = msg.from.id === ADMIN_ID;
  const text = msg.text || msg.caption || '';

  if (msg.chat.type === 'private') {
    if (!isAdmin) { bot.sendMessage(chatId, '⛔ Unauthorized.'); return; }
    handleAdminMessage(msg);
    return;
  }

  if (!isGroup || !state.watcherEnabled) return;
  const addrs = extractAddresses(text);
  for (const a of addrs) {
    await handleGroupBuy(a, msg.chat.title, msg.from.username || msg.from.first_name);
  }
});

// ── Admin DM message handler ──────────────────────────────────────────────────
function handleAdminMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // ── Active wizard ──
  const sess = sessions[chatId];
  if (sess && !text.startsWith('/')) {
    handleWizardInput(chatId, text, sess);
    return;
  }
  if (sess && text.startsWith('/')) { delete sessions[chatId]; } // cancel wizard on /cmd

  // ── Commands ──
  // ── Raw address scan (no wizard active, not a command) ──
  const rawAddr = text.trim().match(/^(0x[a-fA-F0-9]{40})$/);
  if (rawAddr) { scanToken(chatId, rawAddr[1]); return; }

  if (text === '/start' || text === '/admin') { sendMainMenu(chatId); }
  else if (text === '/positions') { sendPositionsList(chatId); }
  else if (text === '/balance') { sendBalanceMsg(chatId); }
  else if (text === '/cancel') { delete sessions[chatId]; bot.sendMessage(chatId, '✅ Cancelled.'); sendMainMenu(chatId); }
  else if (text === '/runnow') { bot.sendMessage(chatId, '⚡ Running DCA now...'); runDcaCycle(); }
  else { sendMainMenu(chatId); }
}

// ── Wizard input handler ──────────────────────────────────────────────────────
async function handleWizardInput(chatId, text, sess) {
  const val = text.trim();

  // ── Set buy amount wizard ──
  if (sess.type === 'set_buy_amount') {
    let eth;
    if (val.startsWith('$')) {
      const usd = parseFloat(val.replace('$', ''));
      if (isNaN(usd) || usd <= 0) { bot.sendMessage(chatId, '❌ Enter a valid amount (e.g. `0.01` or `$10`):'); return; }
      eth = parseFloat((usd / cachedEthPrice).toFixed(5));
      state.buyAmountMode = 'usd';
      bot.sendMessage(chatId, '✅ Buy amount → ~$' + usd + ' (' + eth + ' ETH)', { parse_mode: 'Markdown' });
    } else {
      eth = parseFloat(val);
      if (isNaN(eth) || eth <= 0) { bot.sendMessage(chatId, '❌ Enter a valid amount (e.g. `0.01` or `$10`):'); return; }
      state.buyAmountMode = 'eth';
      bot.sendMessage(chatId, '✅ Buy amount → ' + eth + ' ETH');
    }
    state.ethAmount = eth;
    saveState(state);
    delete sessions[chatId];
    sendWatcherPanel(chatId);
    return;
  }

  // ── Growth engine wizard ──
  if (sess.type === 'growth') {
    if (sess.step === 'address') {
      const addr = val.match(/0x[a-fA-F0-9]{40}/)?.[0];
      if (!addr) { bot.sendMessage(chatId, '❌ Invalid address. Enter a valid 0x address:'); return; }
      sess.data.address = addr;
      const coin = await fetchPrice(addr);
      sess.data.coinName = coin?.name || addr.slice(0, 10) + '...';
      sess.step = 'total_eth';
      const buyerBal = getBalance(BUYER_WALLET);
      const availEth = parseFloat(buyerBal?.wallet?.[0]?.balance || '0').toFixed(4);
      bot.sendMessage(chatId, '🚀 *Growth Engine — ' + sess.data.coinName + '*\n\n💰 Buyer wallet: *' + availEth + ' ETH* available\n\nTotal ETH to spend:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '0.005', callback_data: 'geth_v0.005' }, { text: '0.01', callback_data: 'geth_v0.01' }, { text: '0.02', callback_data: 'geth_v0.02' }, { text: '0.05', callback_data: 'geth_v0.05' }],
          [{ text: '0.1', callback_data: 'geth_v0.1' }, { text: '0.5', callback_data: 'geth_v0.5' }, { text: '✏️ Custom', callback_data: 'geth_custom' }],
        ]}
      });
    } else if (sess.step === 'total_eth') {
      const v = parseFloat(val);
      if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter a valid ETH amount:'); return; }
      sess.data.totalEth = v;
      sess.step = 'num_buys';
      bot.sendMessage(chatId, 'Number of buys:', {
        reply_markup: { inline_keyboard: [
          [{ text: '3', callback_data: 'gbuys_3' }, { text: '5', callback_data: 'gbuys_5' }, { text: '10', callback_data: 'gbuys_10' }, { text: '20', callback_data: 'gbuys_20' }],
          [{ text: '30', callback_data: 'gbuys_30' }, { text: '50', callback_data: 'gbuys_50' }, { text: '✏️ Custom', callback_data: 'gbuys_custom' }],
        ]}
      });
    } else if (sess.step === 'num_buys') {
      const v = parseInt(val);
      if (isNaN(v) || v < 1) { bot.sendMessage(chatId, '❌ Enter a valid number:'); return; }
      sess.data.numBuys = v;
      sess.step = 'interval';
      bot.sendMessage(chatId, 'Interval between buys:', {
        reply_markup: { inline_keyboard: [
          [{ text: '30s', callback_data: 'gint_0.5' }, { text: '1 min', callback_data: 'gint_1' }, { text: '2 min', callback_data: 'gint_2' }, { text: '5 min', callback_data: 'gint_5' }],
          [{ text: '10 min', callback_data: 'gint_10' }, { text: '30 min', callback_data: 'gint_30' }, { text: '1 hour', callback_data: 'gint_60' }, { text: '✏️ Custom', callback_data: 'gint_custom' }],
        ]}
      });
    } else if (sess.step === 'interval') {
      const v = parseFloat(val);
      if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter a valid number:'); return; }
      sess.data.intervalMin = v;
      const ethPerBuy = (sess.data.totalEth / sess.data.numBuys).toFixed(5);
      sess.step = 'confirm';
      bot.sendMessage(chatId,
        '🚀 *Confirm Growth Engine*\n\nCoin: *' + sess.data.coinName + '*\n~' + ethPerBuy + ' ETH every ~' + v + ' min × ' + sess.data.numBuys + ' buys\nTotal: ~*' + sess.data.totalEth + ' ETH*\n🎲 ±15% jitter on amount & timing',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '✅ Start', callback_data: 'growth_confirm' },
          { text: '❌ Cancel', callback_data: 'growth_cancel' },
        ]]}}
      );
    }
    return;
  }

  // ── DCA custom coin wizard ──
  if (sess.type === 'dca_custom') {
    if (sess.step === 'address') {
      const addr = val.match(/0x[a-fA-F0-9]{40}/)?.[0];
      if (!addr) { bot.sendMessage(chatId, '❌ Invalid address:'); return; }
      sess.data.address = addr;
      const coin = await fetchPrice(addr);
      sess.data.name = coin?.name || addr.slice(0, 10) + '...';
      sess.step = 'eth';
      bot.sendMessage(chatId, '💎 *Add Custom DCA — ' + sess.data.name + '*\n\nETH per cycle (e.g. `0.002`):', { parse_mode: 'Markdown' });
    } else if (sess.step === 'eth') {
      const v = parseFloat(val);
      if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter a valid ETH amount:'); return; }
      state.dca.customCoins = state.dca.customCoins || [];
      state.dca.customCoins.push({ address: sess.data.address, name: sess.data.name, ethPerCycle: v });
      saveState(state);
      delete sessions[chatId];
      addrKey(sess.data.address);
      bot.sendMessage(chatId, '✅ Added *' + sess.data.name + '* to DCA\n' + v + ' ETH per cycle', { parse_mode: 'Markdown' });
      sendDcaPanel(chatId);
    }
    return;
  }

  // ── TP wizard ──
  if (sess.type === 'tp') {
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) { bot.sendMessage(chatId, '❌ Enter a valid number, or /cancel:'); return; }
    if (sess.step === 'pct') {
      sess.data.pct = num;
      sess.step = 'sell';
      bot.sendMessage(chatId, '🎯 Trigger at *+' + num + '%*\n\nNow enter sell % (1-100):', { parse_mode: 'Markdown' });
    } else if (sess.step === 'sell') {
      const sellPct = Math.min(100, Math.max(1, num));
      const forAddr = sess.data.forCoin;
      if (forAddr && positions[forAddr]) {
        const pos = positions[forAddr];
        if (!pos.customTpOrders) pos.customTpOrders = JSON.parse(JSON.stringify(state.tpOrders));
        if (sess.data.editIndex === -1) {
          pos.customTpOrders.push({ pct: sess.data.pct, sellPct });
        } else {
          pos.customTpOrders[sess.data.editIndex] = { pct: sess.data.pct, sellPct };
        }
        pos.customTpOrders.sort((a, b) => a.pct - b.pct);
        pos.tpHits = new Array(pos.customTpOrders.length).fill(false);
        savePositions(positions);
        delete sessions[chatId];
        bot.sendMessage(chatId, '✅ TP saved for *' + pos.coinName + '*: +' + sess.data.pct + '% → sell ' + sellPct + '%', { parse_mode: 'Markdown' });
        sendCoinTpManager(chatId, forAddr);
      } else {
        if (sess.data.editIndex === -1) {
          state.tpOrders.push({ pct: sess.data.pct, sellPct });
        } else {
          state.tpOrders[sess.data.editIndex] = { pct: sess.data.pct, sellPct };
        }
        state.tpOrders.sort((a, b) => a.pct - b.pct);
        saveState(state);
        delete sessions[chatId];
        bot.sendMessage(chatId, '✅ Global TP: +' + sess.data.pct + '% → sell ' + sellPct + '%');
        sendGlobalTpManager(chatId);
      }
    }
    return;
  }

  // ── Manual sell / buy wizard ──
  if (sess.type === 'manual_sell') {
    const pct = Math.min(100, Math.max(1, Math.round(parseFloat(val))));
    if (isNaN(pct)) { bot.sendMessage(chatId, '❌ Enter 1-100:'); return; }
    const addr = sess.data.address;
    const pos = positions[addr];
    delete sessions[chatId];
    const walletPath = pos.source === 'dca' ? DCA_WALLET : BUYER_WALLET;
    const r = executeSell(addr, pct, walletPath);
    if (r.success) {
      if (pct === 100) pos.fullyExited = true;
      savePositions(positions);
      const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
      bot.sendMessage(chatId, '✅ Sold *' + pct + '%* of *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
      sendCoinDetail(chatId, addr);
    } else {
      bot.sendMessage(chatId, '❌ Sell failed: `' + r.error + '`', { parse_mode: 'Markdown' });
    }
    return;
  }

  if (sess.type === 'buy_more') {
    const eth = parseFloat(val);
    if (isNaN(eth) || eth <= 0) { bot.sendMessage(chatId, '❌ Enter a valid ETH amount:'); return; }
    const addr = sess.data.address;
    const pos = positions[addr];
    delete sessions[chatId];
    const walletPath = pos.source === 'dca' ? DCA_WALLET : BUYER_WALLET;
    const r = executeBuy(addr, eth, walletPath);
    if (r.success) {
      pos.ethSpent = (pos.ethSpent || 0) + eth;
      savePositions(positions);
      const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
      bot.sendMessage(chatId, '✅ Bought more *' + pos.coinName + '* (' + eth + ' ETH)\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
      sendCoinDetail(chatId, addr);
    } else {
      bot.sendMessage(chatId, '❌ Buy failed: `' + r.error + '`', { parse_mode: 'Markdown' });
    }
    return;
  }
}

// ── ETH Price (cached) ───────────────────────────────────────────────────
let cachedEthPrice = 2400;
let ethPriceFetchedAt = 0;
async function getEthPrice() {
  if (Date.now() - ethPriceFetchedAt < 5 * 60 * 1000) return cachedEthPrice; // cache 5 min
  try {
    const res = await dexFetch('https://api.dexscreener.com/latest/dex/tokens/0x4200000000000000000000000000000000000006');
    const pair = (res?.pairs || []).find(p => p.chainId === 'base' && p.quoteToken?.symbol === 'USDC');
    if (pair?.priceUsd) { cachedEthPrice = parseFloat(pair.priceUsd); ethPriceFetchedAt = Date.now(); }
  } catch {}
  return cachedEthPrice;
}
function usdToEth(usd) { return usd / cachedEthPrice; }
function ethToUsd(eth) { return eth * cachedEthPrice; }

// ── Token Scanner ────────────────────────────────────────────────────────────
function dexFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ZoraBot/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

async function scanToken(chatId, address) {
  bot.sendMessage(chatId, '🔍 Scanning `' + address.slice(0, 10) + '...' + address.slice(-4) + '`...', { parse_mode: 'Markdown' });

  let dexData = null;
  let zoraCoin = null;

  // Fetch DexScreener (works for ALL Base tokens)
  try {
    const res = await dexFetchRL('https://api.dexscreener.com/latest/dex/tokens/' + address);
    const pairs = (res?.pairs || []).filter(p => p.chainId === 'base');
    if (pairs.length > 0) dexData = pairs[0]; // best pair
  } catch (e) { log('[scan] DexScreener error: ' + e.message); }

  // Try Zora SDK for extra Zora-specific data
  try {
    if (sdkGetCoin) {
      const r = await sdkGetCoin({ address });
      zoraCoin = r?.data?.zora20Token;
    }
  } catch {}

  if (!dexData && !zoraCoin) {
    bot.sendMessage(chatId, '❌ No data found for this address on Base.\n\nMake sure it\'s a valid Base chain token.');
    return;
  }

  const token = dexData?.baseToken || {};
  const name   = zoraCoin?.name || token.name || 'Unknown';
  const symbol = token.symbol || name;
  const mcap   = dexData?.marketCap ? '$' + parseFloat(dexData.marketCap).toLocaleString(undefined, {maximumFractionDigits: 0}) : (zoraCoin?.marketCap ? '$' + parseFloat(zoraCoin.marketCap).toLocaleString(undefined, {maximumFractionDigits: 0}) : '?');
  const price  = dexData?.priceUsd ? '$' + parseFloat(dexData.priceUsd).toFixed(8) : '?';
  const liqUsd = dexData?.liquidity?.usd ? '$' + parseFloat(dexData.liquidity.usd).toLocaleString(undefined, {maximumFractionDigits: 0}) : '?';
  const liqPct = dexData?.liquidity?.usd && dexData?.marketCap ? (parseFloat(dexData.liquidity.usd) / parseFloat(dexData.marketCap) * 100).toFixed(1) + '%' : '?';
  const vol24  = dexData?.volume?.h24 ? '$' + parseFloat(dexData.volume.h24).toLocaleString(undefined, {maximumFractionDigits: 0}) : '?';
  const chg1h  = dexData?.priceChange?.h1 != null ? (dexData.priceChange.h1 >= 0 ? '+' : '') + dexData.priceChange.h1 + '%' : '?';
  const chg24  = dexData?.priceChange?.h24 != null ? (dexData.priceChange.h24 >= 0 ? '+' : '') + dexData.priceChange.h24 + '%' : '?';
  const buys24 = dexData?.txns?.h24?.buys ?? '?';
  const sells24 = dexData?.txns?.h24?.sells ?? '?';
  const dex    = dexData?.dexId ? dexData.dexId.charAt(0).toUpperCase() + dexData.dexId.slice(1) : 'Unknown';
  const holders = zoraCoin?.uniqueHolders ? zoraCoin.uniqueHolders.toLocaleString() : '?';
  const created = dexData?.pairCreatedAt ? new Date(dexData.pairCreatedAt).toLocaleDateString() : '?';

  // Detect factory/platform
  const websites = dexData?.info?.websites || [];
  const labels = dexData?.labels || [];
  let factory = '❓ Unknown';
  if (websites.some(w => w.url?.includes('zora.co'))) factory = '🟣 Zora ✅';
  else if (websites.some(w => w.url?.includes('virtuals.io'))) factory = '🤖 Virtuals';
  else if (websites.some(w => w.url?.includes('clanker'))) factory = '🔧 Clanker';
  else if (labels.includes('v2')) factory = '🦄 Uniswap V2';
  else if (labels.includes('v3')) factory = '🦄 Uniswap V3';
  else if (labels.includes('v4')) factory = '🦄 Uniswap V4';

  // Liquidity safety signal
  const liqNum = parseFloat(dexData?.liquidity?.usd || 0);
  const liqWarning = liqNum < 1000 ? '\n🚨 *VERY LOW LIQUIDITY*' : liqNum < 5000 ? '\n⚠️ Low liquidity' : '';

  const msg =
    liqWarning + '\n\n' +
    '*' + name.toUpperCase() + '* (' + symbol + ')' +
    '\n`' + address + '`\n\n' +
    '*Pool Info*\n' +
    '🏭 Factory: ' + factory + '\n' +
    '📊 Mcap: *' + mcap + '*\n' +
    '💧 Liq: *' + liqUsd + '* | ' + liqPct + '\n' +
    '💹 Price: ' + price + '\n\n' +
    '*24h Stats*\n' +
    '📈 Change: *' + chg24 + '*  |  1h: ' + chg1h + '\n' +
    '📦 Vol: *' + vol24 + '*\n' +
    '🔄 Txns: ' + buys24 + ' buys / ' + sells24 + ' sells\n' +
    '👥 Holders: ' + holders + '\n' +
    '📅 Created: ' + created;

  addrKey(address);
  const k = addrKey(address);
  const inPosition = !!positions[address];

  bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🟢 BUY 0.005 ETH', callback_data: 'scanbuy_005_' + k }, { text: '🟢 BUY X ETH', callback_data: 'scanbuy_x_' + k }],
      [{ text: '🚀 Growth Engine', callback_data: 'scangrowth_' + k }, { text: '📊 DCA This Coin', callback_data: 'scandca_' + k }],
      inPosition ? [{ text: '📋 View Position', callback_data: 'pd_' + k }] : [],
      [{ text: '🔄 Refresh Scan', callback_data: 'scan_' + k }],
    ].filter(r => r.length > 0)}
  });
}

// ── Main menu ─────────────────────────────────────────────────────────────────
function sendMainMenu(chatId) {
  const watchStatus = state.watcherEnabled ? '🟢' : '🔴';
  const dcaStatus   = state.dca.enabled   ? '🟢' : '🔴';
  const openPos     = Object.keys(positions).filter(a => !positions[a].fullyExited).length;
  const engines     = Object.keys(activeEngines).length;

  bot.sendMessage(chatId,
    '*🐸 Zora Bot*\n\n' +
    watchStatus + ' Group Watcher  |  ' + (state.autoMode ? '⚡ Auto' : '👋 Manual') + '\n' +
    dcaStatus + ' DCA Engine  |  Next: ' + (state.dca.nextDcaAt ? new Date(state.dca.nextDcaAt).toUTCString().slice(0,22) : 'not set') + '\n' +
    '📊 ' + openPos + ' open position(s)\n' +
    (engines > 0 ? '🚀 ' + engines + ' growth engine(s) running\n' : ''),
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: watchStatus + ' Group Watcher', callback_data: 'watcher_panel' }, { text: dcaStatus + ' DCA Engine', callback_data: 'dca_panel' }],
        [{ text: '🚀 Growth Engine', callback_data: 'growth_panel' }, { text: '📊 Positions', callback_data: 'positions' }],
        [{ text: '💰 Balance', callback_data: 'balance' }, { text: '🔄 Refresh', callback_data: 'main_menu' }],
      ]}
    }
  );
}

// ── Watcher panel ─────────────────────────────────────────────────────────────
function sendWatcherPanel(chatId) {
  const tpList = state.tpOrders.map((t, i) => 'TP' + (i+1) + ': +' + t.pct + '% sell ' + t.sellPct + '%').join('\n  ');
  bot.sendMessage(chatId,
    '*👁 Group Watcher*\n\n' +
    'Status: ' + (state.watcherEnabled ? '🟢 ON' : '🔴 OFF') + '  Mode: ' + (state.autoMode ? '⚡ Auto' : '👋 Manual') + '\n' +
    'Buy: *' + state.ethAmount + ' ETH*  |  SL: *-' + state.stopLossPct + '%*\n\n' +
    '*Global TPs:*\n  ' + tpList,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: state.watcherEnabled ? '🔴 Turn OFF' : '🟢 Turn ON', callback_data: 'w_toggle' }, { text: state.autoMode ? '👋 Manual' : '⚡ Auto', callback_data: 'w_mode' }],
        [{ text: '💰 Buy Amount', callback_data: 'w_amount' }, { text: '📉 Stop-Loss', callback_data: 'w_sl' }],
        [{ text: '📈 TP Orders', callback_data: 'tp_global' }, { text: state.watcherPriceCheckEnabled ? '🙈 Pause Watcher' : '👁 Resume Watcher', callback_data: 'w_price_toggle' }],
        [{ text: '◀️ Main Menu', callback_data: 'main_menu' }],
      ]}
    }
  );
}

// ── DCA panel ─────────────────────────────────────────────────────────────────
function sendDcaPanel(chatId) {
  const d = state.dca;
  const customList = (d.customCoins || []).map((c, i) => '  • ' + c.name + ' (' + c.ethPerCycle + ' ETH) 🗑').join('\n') || '  None';
  const nextStr = d.nextDcaAt ? new Date(d.nextDcaAt).toUTCString().slice(0, 25) : 'Not set';

  const keyboard = [
    [{ text: d.enabled ? '⏸ Pause DCA' : '▶️ Start DCA', callback_data: 'dca_toggle' }, { text: '⚡ Run Now', callback_data: 'dca_runnow' }],
    [{ text: '⏱ Interval (' + d.intervalHours + 'h)', callback_data: 'dca_interval' }, { text: '💎 ETH/coin (' + d.ethPerCoin + ')', callback_data: 'dca_eth' }],
    [{ text: '📊 Min Mcap', callback_data: 'dca_mcap' }, { text: '👥 Min Holders', callback_data: 'dca_holders' }],
    [{ text: '➕ Add Custom Coin', callback_data: 'dca_add_custom' }],
  ];

  // Add remove buttons for custom coins
  (d.customCoins || []).forEach((c, i) => {
    addrKey(c.address);
    keyboard.push([{ text: '🗑 ' + c.name, callback_data: 'dca_rm_' + i }]);
  });

  keyboard.push([{ text: '◀️ Main Menu', callback_data: 'main_menu' }]);

  bot.sendMessage(chatId,
    '*📈 DCA Engine*\n\n' +
    'Status: ' + (d.enabled ? '🟢 Running' : '🔴 Paused') + '\n' +
    'Interval: *' + d.intervalHours + 'h*  |  ETH/coin: *' + d.ethPerCoin + '*\n' +
    'Max coins: *' + d.maxCoins + '*  |  Min mcap: *$' + (d.minMcap/1000).toFixed(0) + 'k*\n' +
    'Next DCA: ' + nextStr + '\n\n' +
    '*Custom DCA Coins:*\n' + customList,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ── Growth engine panel ───────────────────────────────────────────────────────
function sendGrowthPanel(chatId) {
  const engines = Object.entries(activeEngines);
  const keyboard = [[{ text: '🚀 New Growth Engine', callback_data: 'growth_new' }]];

  engines.forEach(([id, eng]) => {
    keyboard.push([
      { text: '⚡ ' + eng.coinName + ' (' + eng.done + '/' + eng.total + ')', callback_data: 'growth_status' },
      { text: '🛑 Cancel', callback_data: 'growth_stop_' + id.slice(0, 20) },
    ]);
  });

  keyboard.push([{ text: '◀️ Main Menu', callback_data: 'main_menu' }]);

  bot.sendMessage(chatId,
    '*🚀 Growth Engine*\n\n' +
    (engines.length ? engines.map(([_, e]) => '⚡ *' + e.coinName + '* — ' + e.done + '/' + e.total + ' buys done').join('\n') : 'No active engines.') + '\n\n' +
    'Start a new TWAP-style buy sequence:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ── Positions list ────────────────────────────────────────────────────────────
async function sendPositionsList(chatId) {
  const allAddrs = Object.keys(positions);
  if (!allAddrs.length) { bot.sendMessage(chatId, '📊 No positions yet.'); return; }

  // Show open positions by default; exited ones shown at bottom greyed out
  const openAddrs = allAddrs.filter(a => !positions[a].fullyExited);
  const exitedAddrs = allAddrs.filter(a => positions[a].fullyExited);
  const addrs = [...openAddrs, ...exitedAddrs];

  const priceMap = await fetchPriceBulk(openAddrs); // only fetch live prices for open
  const keyboard = [];

  for (const addr of addrs) {
    addrKey(addr);
    const p = positions[addr];
    const coin = priceMap[addr];
    const status = p.fullyExited ? '⚪' : (coin?.priceUsd && p.buyPriceUsd && ((coin.priceUsd - (p.avgBuyPrice || p.buyPriceUsd)) / (p.avgBuyPrice || p.buyPriceUsd)) >= 0 ? '🟢' : '🔴');
    let label = status + ' ' + p.coinName;
    if (coin?.priceUsd && (p.avgBuyPrice || p.buyPriceUsd)) {
      const ref = p.avgBuyPrice || p.buyPriceUsd;
      const chg = ((coin.priceUsd - ref) / ref * 100);
      label += '  ' + (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%';
    }
    keyboard.push([{ text: label, callback_data: 'pd_' + addrKey(addr) }]);
  }

  keyboard.push([{ text: '🔄 Refresh', callback_data: 'positions' }, { text: '◀️ Main Menu', callback_data: 'main_menu' }]);

  bot.sendMessage(chatId,
    '*📊 Positions (' + addrs.filter(a => !positions[a].fullyExited).length + ' open)*\nTap to manage.',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ── Coin detail ───────────────────────────────────────────────────────────────
async function sendCoinDetail(chatId, address) {
  const pos = positions[address];
  if (!pos) { bot.sendMessage(chatId, '❌ Position not found.'); return; }
  addrKey(address);

  // Fetch price + DexScreener data in parallel
  const [coin, dexRes] = await Promise.all([
    fetchPrice(address),
    dexFetchRL('https://api.dexscreener.com/latest/dex/tokens/' + address).catch(() => null),
  ]);
  const dex = (dexRes?.pairs || []).find(p => p.chainId === 'base');

  const ref = pos.avgBuyPrice || pos.buyPriceUsd;
  const activeTps = getEffectiveTps(pos);
  ensureTpHits(pos);
  const tpStr = pos.tpHits.map((h, i) => (h ? '✅' : '⬜') + 'TP' + (i+1)).join(' ');
  const openOrders = activeTps.filter((_, i) => !pos.tpHits[i]).length;
  const status = pos.fullyExited ? '⚪ EXITED' : '🟢 OPEN';
  const slPct = pos.source === 'dca' ? state.dca.slPct : state.stopLossPct;
  const k = addrKey(address);
  const ethSpent = parseFloat(pos.ethSpent || pos.totalEthSpent || 0);

  // Estimate ETH price from dex data (priceUsd / priceNative)
  let ETH_PRICE = 2400;
  if (dex?.priceUsd && dex?.priceNative && parseFloat(dex.priceNative) > 0) {
    ETH_PRICE = parseFloat(dex.priceUsd) / parseFloat(dex.priceNative);
  }

  // ─ P&L calculation ─
  // If no entry price recorded, use current price as basis (shows 0% — better than ?).
  // This happens for growth engine positions created before the price-tracking fix.
  const effectiveRef = ref || coin?.priceUsd || null;
  if (!ref && coin?.priceUsd && pos.source === 'growth') {
    // Backfill entry price for future calculations
    pos.buyPriceUsd = coin.priceUsd;
    pos.avgBuyPrice = coin.priceUsd;
    savePositions(positions);
  }

  let pnlLine = '';
  if (coin?.priceUsd && effectiveRef && ethSpent > 0) {
    const ref = effectiveRef; // shadow outer ref
    const chgPct = ((coin.priceUsd - ref) / ref * 100);
    const currentValueEth = ethSpent * (coin.priceUsd / ref);
    const pnlEth = currentValueEth - ethSpent;
    const pnlUsd = pnlEth * ETH_PRICE;
    const sign = chgPct >= 0 ? '+' : '';
    const emoji = chgPct >= 0 ? '🟢' : '🔴';
    pnlLine = emoji + ' *' + sign + chgPct.toFixed(2) + '%*' +
      '  ' + sign + pnlEth.toFixed(5) + ' ETH' +
      '  (~' + sign + '$' + pnlUsd.toFixed(2) + ')';
  }

  // ─ Market data (minimal) ─
  const mcap   = dex?.marketCap ? '$' + parseFloat(dex.marketCap).toLocaleString(undefined, {maximumFractionDigits:0}) : '?';
  const liq    = dex?.liquidity?.usd ? '$' + parseFloat(dex.liquidity.usd).toLocaleString(undefined, {maximumFractionDigits:0}) : '?';
  const vol24  = dex?.volume?.h24 ? '$' + parseFloat(dex.volume.h24).toLocaleString(undefined, {maximumFractionDigits:0}) : '?';
  const chg24  = dex?.priceChange?.h24 != null ? (dex.priceChange.h24 >= 0 ? '+' : '') + dex.priceChange.h24 + '%' : '?';
  const buys   = dex?.txns?.h24?.buys ?? '?';
  const sells  = dex?.txns?.h24?.sells ?? '?';
  // Mcap 24h change from dex (more meaningful than token price)
  const mcapChg24 = dex?.priceChange?.h24 != null ? (dex.priceChange.h24 >= 0 ? '+' : '') + dex.priceChange.h24 + '%' : null;
  const mcapChg1h = dex?.priceChange?.h1 != null ? (dex.priceChange.h1 >= 0 ? '+' : '') + dex.priceChange.h1 + '%' : null;
  const mcapStr = dex?.marketCap
    ? '$' + parseFloat(dex.marketCap).toLocaleString(undefined, {maximumFractionDigits:0})
      + (mcapChg24 ? '  *' + mcapChg24 + '*' : '')
      + (mcapChg1h ? '  1h: ' + mcapChg1h : '')
    : mcap;

  // TP status with levels
  const tpDetail = activeTps.map((t, i) => (pos.tpHits[i] ? '✅' : '⬜') + '+' + t.pct + '%').join('  ');
  const pnlPct = effectiveRef && coin?.priceUsd ? ((coin.priceUsd - effectiveRef) / effectiveRef * 100) : 0;
  const showPnl = pnlLine && Math.abs(pnlPct) > 0.01;

  const msg =
    '*' + pos.coinName.toUpperCase() + '*  ' + status + '\n' +
    (showPnl ? pnlLine + '\n' : '') +
    'In: *' + ethSpent.toFixed(5) + ' ETH*\n\n' +
    'Mcap: ' + mcapStr + '\n' +
    'Liq: ' + liq + '  |  Vol: ' + vol24 + '\n' +
    buys + '🟢 ' + sells + '🔴 (24h)\n\n' +
    'TPs: ' + tpDetail + '  |  SL: -' + slPct + '%';

  bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🟢 +0.001', callback_data: 'pb_001_' + k }, { text: '🟢 +0.005', callback_data: 'pb_005_' + k }, { text: '🟢 +X ETH', callback_data: 'pb_x_' + k }],
      [{ text: '🔴 25%', callback_data: 'ps_25_' + k }, { text: '🔴 50%', callback_data: 'ps_50_' + k }, { text: '🔴 100%', callback_data: 'ps_100_' + k }, { text: '🔴 X%', callback_data: 'ps_x_' + k }],
      [{ text: '🔴 Initials', callback_data: 'ps_init_' + k }, { text: '🔔 TPs (' + openOrders + ')', callback_data: 'ptpm_' + k }],
      [{ text: '🚀 Growth Engine', callback_data: 'pgrowth_' + k }, { text: '🔄 Refresh', callback_data: 'pd_' + k }],
      [{ text: '◀️ Positions', callback_data: 'positions' }],
    ]}
  });
}

// ── Coin TP manager ───────────────────────────────────────────────────────────
function sendCoinTpManager(chatId, address) {
  const pos = positions[address];
  if (!pos) { bot.sendMessage(chatId, '❌ Position not found.'); return; }
  const orders = pos.customTpOrders || state.tpOrders;
  const isCustom = !!pos.customTpOrders;
  const keyboard = [];
  const k = addrKey(address);

  for (let i = 0; i < orders.length; i++) {
    const t = orders[i];
    keyboard.push([
      { text: (pos.tpHits?.[i] ? '✅' : '🟢') + ' TP' + (i+1), callback_data: 'noop' },
      { text: '🎯 +' + t.pct + '%', callback_data: 'tpep_' + k + '_' + i },
      { text: '💰 ' + t.sellPct + '%', callback_data: 'tpes_' + k + '_' + i },
      { text: '🗑', callback_data: 'tpd_' + k + '_' + i },
    ]);
  }
  keyboard.push([
    { text: '➕ Add TP', callback_data: 'tpa_' + k },
    isCustom ? { text: '🔄 Reset to Global', callback_data: 'tpr_' + k } : { text: 'ℹ️ Using Global', callback_data: 'noop' },
  ]);
  keyboard.push([{ text: '◀️ Back', callback_data: 'pd_' + k }]);

  bot.sendMessage(chatId,
    '*' + pos.coinName + ' TP Config*\n' + (isCustom ? '🟡 Custom active' : '🔵 Using global') + '\n\nTap 🎯 or 💰 to edit, 🗑 to delete.',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ── Global TP manager ─────────────────────────────────────────────────────────
function sendGlobalTpManager(chatId) {
  const orders = state.tpOrders;
  const keyboard = [];

  for (let i = 0; i < orders.length; i++) {
    const t = orders[i];
    keyboard.push([
      { text: '🟢 TP' + (i+1), callback_data: 'noop' },
      { text: '🎯 +' + t.pct + '%', callback_data: 'gtpep_' + i },
      { text: '💰 ' + t.sellPct + '%', callback_data: 'gtpes_' + i },
      { text: '🗑', callback_data: 'gtpd_' + i },
    ]);
  }
  keyboard.push([{ text: '➕ Add TP', callback_data: 'gtpa' }, { text: '◀️ Back', callback_data: 'watcher_panel' }]);

  bot.sendMessage(chatId,
    '*📈 Global TP Orders*\n\nApply to all coins unless overridden.\nTap 🎯 trigger or 💰 sell % to edit.',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ── Balance ───────────────────────────────────────────────────────────────────
function sendBalanceMsg(chatId) {
  const buyerBal = getBalance(BUYER_WALLET);
  const dcaBal   = getBalance(DCA_WALLET);
  const bEth = buyerBal?.wallet?.[0]?.balance || '?';
  const bUsd = buyerBal?.wallet?.[0]?.usdValue?.toFixed(2) || '?';
  const dEth = dcaBal?.wallet?.[0]?.balance || '?';
  const dUsd = dcaBal?.wallet?.[0]?.usdValue?.toFixed(2) || '?';

  bot.sendMessage(chatId,
    '*💰 Wallets*\n\n🔵 Buyer: *' + bEth + ' ETH* (~$' + bUsd + ')\n🟣 DCA: *' + dEth + ' ETH* (~$' + dUsd + ')',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '◀️ Main Menu', callback_data: 'main_menu' }]] }}
  );
}

// ── Callback queries ──────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data   = query.data;
  const chatId = query.message.chat.id;

  if (userId !== ADMIN_ID) { bot.answerCallbackQuery(query.id, { text: '⛔ Unauthorized' }); return; }

  bot.answerCallbackQuery(query.id).catch(() => {});

  // ── Navigation ──
  if (data === 'main_menu')      { sendMainMenu(chatId); }
  else if (data === 'watcher_panel') { sendWatcherPanel(chatId); }
  else if (data === 'dca_panel')     { sendDcaPanel(chatId); }
  else if (data === 'growth_panel')  { sendGrowthPanel(chatId); }
  else if (data === 'positions')     { sendPositionsList(chatId); }
  else if (data === 'balance')       { sendBalanceMsg(chatId); }
  else if (data === 'noop')          { /* do nothing */ }
  else if (data === 'growth_status') { sendGrowthPanel(chatId); }

  // ── Watcher toggles ──
  else if (data === 'w_toggle')       { state.watcherEnabled = !state.watcherEnabled; saveState(state); sendWatcherPanel(chatId); }
  else if (data === 'w_mode')         { state.autoMode = !state.autoMode; saveState(state); sendWatcherPanel(chatId); }
  else if (data === 'w_price_toggle') { state.watcherPriceCheckEnabled = !state.watcherPriceCheckEnabled; saveState(state); sendWatcherPanel(chatId); }
  else if (data === 'w_amount' || data === 'wa_toggle_mode') {
    if (data === 'wa_toggle_mode') {
      state.buyAmountMode = state.buyAmountMode === 'eth' ? 'usd' : 'eth';
      saveState(state);
    }
    const mode = state.buyAmountMode || 'eth';
    const currentDisplay = mode === 'usd'
      ? '~$' + Math.round(state.ethAmount * cachedEthPrice) + ' USD'
      : state.ethAmount + ' ETH';
    const toggleLabel = mode === 'eth' ? '💵 Switch to USD' : '⚫ Switch to ETH';

    const keyboard = mode === 'eth'
      ? [
          [{ text: '0.001', callback_data: 'wa_v0.001' }, { text: '0.002', callback_data: 'wa_v0.002' }, { text: '0.005', callback_data: 'wa_v0.005' }, { text: '0.01', callback_data: 'wa_v0.01' }],
          [{ text: '0.02', callback_data: 'wa_v0.02' }, { text: '0.05', callback_data: 'wa_v0.05' }, { text: '✏️ Custom', callback_data: 'wa_custom' }],
          [{ text: toggleLabel, callback_data: 'wa_toggle_mode' }],
        ]
      : [
          [{ text: '$1', callback_data: 'wau_1' }, { text: '$2', callback_data: 'wau_2' }, { text: '$5', callback_data: 'wau_5' }, { text: '$10', callback_data: 'wau_10' }],
          [{ text: '$25', callback_data: 'wau_25' }, { text: '$50', callback_data: 'wau_50' }, { text: '✏️ Custom', callback_data: 'wa_custom' }],
          [{ text: toggleLabel, callback_data: 'wa_toggle_mode' }],
        ];

    bot.sendMessage(chatId, '💰 *Set Buy Amount* (current: ' + currentDisplay + ')', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
  else if (data.startsWith('wa_v')) {
    const eth = parseFloat(data.replace('wa_v', ''));
    state.ethAmount = eth; state.buyAmountMode = 'eth'; saveState(state);
    bot.answerCallbackQuery(query.id, { text: '✅ ' + eth + ' ETH' });
    sendWatcherPanel(chatId);
  }
  else if (data.startsWith('wau_')) {
    const usd = parseFloat(data.replace('wau_', ''));
    const eth = parseFloat((usd / cachedEthPrice).toFixed(5));
    state.ethAmount = eth; state.buyAmountMode = 'usd'; saveState(state);
    bot.answerCallbackQuery(query.id, { text: '✅ ~$' + usd + ' (' + eth + ' ETH)' });
    sendWatcherPanel(chatId);
  }
  else if (data.startsWith('wa_')) {
    const v = data.replace('wa_', '');
    if (v === 'custom') {
      sessions[chatId] = { type: 'set_buy_amount', createdAt: Date.now() };
      bot.sendMessage(chatId, 'Enter amount (e.g. `0.01` ETH or `$10` USD):', { parse_mode: 'Markdown' });
    }
  }
  else if (data === 'w_sl') {
    bot.sendMessage(chatId, '📉 *Stop-Loss* (current: -' + state.stopLossPct + '%)', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '-5%', callback_data: 'wsl_5' }, { text: '-10%', callback_data: 'wsl_10' },
        { text: '-15%', callback_data: 'wsl_15' }, { text: '-20%', callback_data: 'wsl_20' },
        { text: '-25%', callback_data: 'wsl_25' }, { text: '-30%', callback_data: 'wsl_30' },
      ]]}
    });
  }
  else if (data.startsWith('wsl_')) { state.stopLossPct = parseInt(data.replace('wsl_', '')); saveState(state); sendWatcherPanel(chatId); }

  // ── DCA controls ──
  else if (data === 'dca_toggle') {
    state.dca.enabled = !state.dca.enabled;
    if (state.dca.enabled && !state.dca.nextDcaAt) state.dca.nextDcaAt = Date.now() + state.dca.intervalHours * 3600000;
    saveState(state); sendDcaPanel(chatId);
  }
  else if (data === 'dca_runnow') { bot.sendMessage(chatId, '⚡ Running DCA now...'); runDcaCycle(); }
  else if (data === 'dca_add_custom') {
    sessions[chatId] = { type: 'dca_custom', step: 'address', data: {}, createdAt: Date.now() };
    bot.sendMessage(chatId, '➕ *Add Custom DCA Coin*\n\nPaste the contract address:', { parse_mode: 'Markdown' });
  }
  else if (data.startsWith('dca_rm_')) {
    const i = parseInt(data.replace('dca_rm_', ''));
    state.dca.customCoins.splice(i, 1);
    saveState(state); sendDcaPanel(chatId);
  }
  else if (data === 'dca_interval') {
    bot.sendMessage(chatId, '⏱ *DCA Interval* (current: ' + state.dca.intervalHours + 'h)', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '1h', callback_data: 'di_1' }, { text: '4h', callback_data: 'di_4' }, { text: '6h', callback_data: 'di_6' }, { text: '12h', callback_data: 'di_12' }],
        [{ text: '24h', callback_data: 'di_24' }, { text: '48h', callback_data: 'di_48' }, { text: '1 week', callback_data: 'di_168' }, { text: '1 month', callback_data: 'di_720' }],
      ]}
    });
  }
  else if (data.startsWith('di_')) { state.dca.intervalHours = parseInt(data.replace('di_', '')); scheduleDca(); saveState(state); sendDcaPanel(chatId); }
  else if (data === 'dca_eth') {
    const dcaBal = getBalance(DCA_WALLET);
    const dcaAvail = parseFloat(dcaBal?.wallet?.[0]?.balance || '0').toFixed(4);
    bot.sendMessage(chatId, '💎 *ETH per coin* (current: ' + state.dca.ethPerCoin + ')\n💰 DCA wallet: *' + dcaAvail + ' ETH* available', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '0.001', callback_data: 'de_001' }, { text: '0.002', callback_data: 'de_002' },
        { text: '0.005', callback_data: 'de_005' }, { text: '0.01', callback_data: 'de_01' },
      ]]}
    });
  }
  else if (data.startsWith('de_')) {
    const map = { '001': 0.001, '002': 0.002, '005': 0.005, '01': 0.01 };
    state.dca.ethPerCoin = map[data.replace('de_', '')] || 0.002;
    saveState(state); sendDcaPanel(chatId);
  }
  else if (data === 'dca_mcap') {
    bot.sendMessage(chatId, '🏦 *Min Mcap* (current: $' + state.dca.minMcap.toLocaleString() + ')', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '$10k', callback_data: 'dm_10k' }, { text: '$50k', callback_data: 'dm_50k' },
        { text: '$100k', callback_data: 'dm_100k' }, { text: '$500k', callback_data: 'dm_500k' },
      ]]}
    });
  }
  else if (data.startsWith('dm_')) {
    const map = { '10k': 10000, '50k': 50000, '100k': 100000, '500k': 500000 };
    state.dca.minMcap = map[data.replace('dm_', '')] || 100000;
    saveState(state); sendDcaPanel(chatId);
  }
  else if (data === 'dca_holders') {
    bot.sendMessage(chatId, '👥 *Min Holders* (current: ' + state.dca.minHolders + ')', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '100', callback_data: 'dh_100' }, { text: '500', callback_data: 'dh_500' },
        { text: '1000', callback_data: 'dh_1000' }, { text: '5000', callback_data: 'dh_5000' },
      ]]}
    });
  }
  else if (data.startsWith('dh_')) {
    state.dca.minHolders = parseInt(data.replace('dh_', '')); saveState(state); sendDcaPanel(chatId);
  }

  // ── Growth engine ──
  // Growth engine preset buttons
  else if (data.startsWith('geth_')) {
    const sess = sessions[chatId];
    if (!sess || sess.type !== 'growth') return;
    const v = data.replace('geth_', '');
    if (v === 'custom') {
      bot.sendMessage(chatId, '✏️ Enter total ETH amount:');
    } else {
      // v starts with 'v' prefix e.g. 'v0.005'
      const eth = parseFloat(v.replace('v', ''));
      if (isNaN(eth) || eth <= 0) { bot.sendMessage(chatId, '❌ Invalid amount.'); return; }
      sess.data.totalEth = eth;
      sess.step = 'num_buys';
      bot.sendMessage(chatId, 'Number of buys:', {
        reply_markup: { inline_keyboard: [
          [{ text: '3', callback_data: 'gbuys_3' }, { text: '5', callback_data: 'gbuys_5' }, { text: '10', callback_data: 'gbuys_10' }, { text: '20', callback_data: 'gbuys_20' }],
          [{ text: '30', callback_data: 'gbuys_30' }, { text: '50', callback_data: 'gbuys_50' }, { text: '✏️ Custom', callback_data: 'gbuys_custom' }],
        ]}
      });
    }
  }
  else if (data.startsWith('gbuys_')) {
    const sess = sessions[chatId];
    if (!sess || sess.type !== 'growth') return;
    const v = data.replace('gbuys_', '');
    if (v === 'custom') {
      bot.sendMessage(chatId, '✏️ Enter number of buys:');
    } else {
      sess.data.numBuys = parseInt(v);
      sess.step = 'interval';
      bot.sendMessage(chatId, 'Interval between buys:', {
        reply_markup: { inline_keyboard: [
          [{ text: '30s', callback_data: 'gint_0.5' }, { text: '1 min', callback_data: 'gint_1' }, { text: '2 min', callback_data: 'gint_2' }, { text: '5 min', callback_data: 'gint_5' }],
          [{ text: '10 min', callback_data: 'gint_10' }, { text: '30 min', callback_data: 'gint_30' }, { text: '1 hour', callback_data: 'gint_60' }, { text: '✏️ Custom', callback_data: 'gint_custom' }],
        ]}
      });
    }
  }
  else if (data.startsWith('gint_')) {
    const sess = sessions[chatId];
    if (!sess || sess.type !== 'growth') return;
    const v = data.replace('gint_', '');
    if (v === 'custom') {
      bot.sendMessage(chatId, '✏️ Enter interval in minutes (e.g. 1):');
    } else {
      const mins = parseFloat(v);
      sess.data.intervalMin = mins;
      const ethPerBuy = (sess.data.totalEth / sess.data.numBuys).toFixed(5);
      sess.step = 'confirm';
      bot.sendMessage(chatId,
        '🚀 *Confirm Growth Engine*\n\nCoin: *' + sess.data.coinName + '*\n~' + ethPerBuy + ' ETH every ~' + mins + ' min × ' + sess.data.numBuys + ' buys\nTotal: ~*' + sess.data.totalEth + ' ETH*\n🎲 ±15% jitter on amount & timing',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '✅ Start', callback_data: 'growth_confirm' },
          { text: '❌ Cancel', callback_data: 'growth_cancel' },
        ]]}}
      );
    }
  }
  else if (data === 'growth_new') {
    sessions[chatId] = { type: 'growth', step: 'address', data: {}, createdAt: Date.now() };
    bot.sendMessage(chatId, '🚀 *New Growth Engine*\n\nPaste coin address:', { parse_mode: 'Markdown' });
  }
  else if (data.startsWith('pgrowth_')) {
    const addr = addrFromKey(data.replace('pgrowth_', ''));
    const pos = positions[addr];
    const coinName = pos?.coinName || addr.slice(0, 10) + '...';
    // Pre-fill address, skip straight to ETH amount step
    sessions[chatId] = { type: 'growth', step: 'total_eth', data: { address: addr, coinName }, createdAt: Date.now() };
    const buyerBal = getBalance(BUYER_WALLET);
    const availEth = parseFloat(buyerBal?.wallet?.[0]?.balance || '0').toFixed(4);
    bot.sendMessage(chatId, '🚀 *Growth Engine — ' + coinName + '*\n\n💰 Buyer wallet: *' + availEth + ' ETH* available\n\nTotal ETH to spend:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '0.005', callback_data: 'geth_v0.005' }, { text: '0.01', callback_data: 'geth_v0.01' }, { text: '0.02', callback_data: 'geth_v0.02' }, { text: '0.05', callback_data: 'geth_v0.05' }],
        [{ text: '0.1', callback_data: 'geth_v0.1' }, { text: '0.5', callback_data: 'geth_v0.5' }, { text: '✏️ Custom', callback_data: 'geth_custom' }],
      ]}
    });
  }
  else if (data === 'growth_confirm') {
    const sess = sessions[chatId];
    if (!sess || sess.type !== 'growth' || sess.step !== 'confirm') { bot.sendMessage(chatId, '⚠️ No pending growth engine. Start a new one.'); return; }
    const { address, coinName, totalEth, numBuys, intervalMin } = sess.data;
    const ethPerBuy = totalEth / numBuys;
    const engineId = 'ge_' + Date.now();
    delete sessions[chatId];
    bot.sendMessage(chatId, '🚀 *Growth Engine Started!*\n*' + coinName + '*\n' + numBuys + ' buys ~' + ethPerBuy.toFixed(5) + ' ETH every ~' + intervalMin + ' min\n🎲 ±15% jitter on amount & timing', { parse_mode: 'Markdown' });
    startGrowthEngine(engineId, address, coinName, numBuys, ethPerBuy, intervalMin * 60000, 0.15);
  }
  else if (data === 'growth_cancel') { delete sessions[chatId]; bot.sendMessage(chatId, '❌ Growth engine cancelled.'); sendGrowthPanel(chatId); }
  else if (data.startsWith('growth_stop_')) {
    const id = Object.keys(activeEngines).find(k => k.startsWith(data.replace('growth_stop_', '').slice(0, 10)));
    if (id && activeEngines[id]) {
      const eng = activeEngines[id];
      if (eng.timer) clearTimeout(eng.timer);
      delete activeEngines[id];
      bot.sendMessage(chatId, '🛑 Growth engine for *' + eng.coinName + '* cancelled.', { parse_mode: 'Markdown' });
    }
    sendGrowthPanel(chatId);
  }

  // ── Position detail ──
  else if (data.startsWith('pd_')) {
    const addr = addrFromKey(data.replace('pd_', ''));
    sendCoinDetail(chatId, addr);
  }
  // ── Scanner action buttons ──
  else if (data.startsWith('scan_')) {
    const addr = addrFromKey(data.replace('scan_', ''));
    scanToken(chatId, addr);
  }
  else if (data.startsWith('scanbuy_')) {
    const parts = data.split('_'); const ethCode = parts[1]; const k = parts.slice(2).join('_');
    const addr = addrFromKey(k);
    if (ethCode === 'x') {
      sessions[chatId] = { type: 'buy_more', data: { address: addr }, createdAt: Date.now() };
      bot.sendMessage(chatId, '🟢 Enter ETH amount to buy:');
    } else {
      const eth = ethCode === '005' ? 0.005 : parseFloat('0.' + ethCode);
      const r = executeBuy(addr, eth, BUYER_WALLET);
      if (r.success) {
        addrKey(addr);
        const pos = positions[addr];
        if (!pos) {
          positions[addr] = { coinName: addr.slice(0,8)+'...', address: addr, buyPriceUsd: null, boughtAt: Date.now(), ethSpent: eth, source: 'watcher', tpHits: new Array(state.tpOrders.length).fill(false), customTpOrders: null, fullyExited: false };
        } else { pos.ethSpent = (pos.ethSpent||0) + eth; }
        savePositions(positions);
        const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
        bot.sendMessage(chatId, '✅ Bought ' + eth + ' ETH\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
      } else { bot.sendMessage(chatId, '❌ Buy failed: `' + r.error + '`', { parse_mode: 'Markdown' }); }
    }
  }
  else if (data.startsWith('scangrowth_')) {
    const addr = addrFromKey(data.replace('scangrowth_', ''));
    const pos = positions[addr];
    const coinName = pos?.coinName || addr.slice(0,10)+'...';
    sessions[chatId] = { type: 'growth', step: 'total_eth', data: { address: addr, coinName }, createdAt: Date.now() };
    const buyerBal = getBalance(BUYER_WALLET);
    const availEth = parseFloat(buyerBal?.wallet?.[0]?.balance || '0').toFixed(4);
    bot.sendMessage(chatId, '🚀 *Growth Engine — ' + coinName + '*\n\n💰 Available: *' + availEth + ' ETH*\n\nTotal ETH to spend:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '0.005', callback_data: 'geth_v0.005' }, { text: '0.01', callback_data: 'geth_v0.01' }, { text: '0.02', callback_data: 'geth_v0.02' }, { text: '0.05', callback_data: 'geth_v0.05' }],
        [{ text: '0.1', callback_data: 'geth_v0.1' }, { text: '0.5', callback_data: 'geth_v0.5' }, { text: '✏️ Custom', callback_data: 'geth_custom' }],
      ]}
    });
  }
  else if (data.startsWith('scandca_')) {
    const addr = addrFromKey(data.replace('scandca_', ''));
    const pos = positions[addr];
    const coinName = pos?.coinName || addr.slice(0,10)+'...';
    state.dca.customCoins = state.dca.customCoins || [];
    if (!state.dca.customCoins.find(c => c.address === addr)) {
      state.dca.customCoins.push({ address: addr, name: coinName, ethPerCycle: state.dca.ethPerCoin });
      saveState(state);
      addrKey(addr);
      bot.sendMessage(chatId, '✅ *' + coinName + '* added to DCA\n' + state.dca.ethPerCoin + ' ETH per cycle\nAdjust in 📈 DCA Engine panel.', { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, 'ℹ️ Already in DCA list.');
    }
  }

  else if (data.startsWith('pinfo_')) {
    const addr = addrFromKey(data.replace('pinfo_', ''));
    const coin = await fetchPrice(addr);
    if (coin) {
      bot.sendMessage(chatId, '*' + (coin.name || addr) + '*\n`' + addr + '`\nMcap: $' + coin.marketCap?.toLocaleString(undefined, {maximumFractionDigits:0}) + '\nHolders: ' + (coin.uniqueHolders || '?'), { parse_mode: 'Markdown' });
    }
  }

  // ── Coin buy/sell buttons ──
  else if (data.startsWith('pb_')) {
    const parts = data.split('_'); const ethCode = parts[1]; const k = parts.slice(2).join('_');
    const addr = addrFromKey(k);
    const pos = positions[addr];
    if (!pos) return;
    if (ethCode === 'x') {
      sessions[chatId] = { type: 'buy_more', data: { address: addr }, createdAt: Date.now() };
      bot.sendMessage(chatId, '🟢 Enter ETH amount to buy:');
    } else {
      const eth = ethCode === '001' ? 0.001 : ethCode === '005' ? 0.005 : parseFloat('0.' + ethCode);
      const walletPath = pos.source === 'dca' ? DCA_WALLET : BUYER_WALLET;
      const r = executeBuy(addr, eth, walletPath);
      if (r.success) {
        pos.ethSpent = (pos.ethSpent || 0) + eth;
        savePositions(positions);
        const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
        bot.sendMessage(chatId, '✅ Bought more *' + pos.coinName + '* (' + eth + ' ETH)\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
        sendCoinDetail(chatId, addr);
      } else {
        bot.sendMessage(chatId, '❌ Buy failed: `' + r.error + '`', { parse_mode: 'Markdown' });
      }
    }
  }
  else if (data.startsWith('ps_')) {
    const parts = data.split('_'); const pctCode = parts[1]; const k = parts.slice(2).join('_');
    const addr = addrFromKey(k);
    const pos = positions[addr];
    if (!pos) return;
    const walletPath = pos.source === 'dca' ? DCA_WALLET : BUYER_WALLET;

    if (pctCode === 'x') {
      sessions[chatId] = { type: 'manual_sell', data: { address: addr }, createdAt: Date.now() };
      bot.sendMessage(chatId, '🔴 Enter sell % (1-100):');
    } else if (pctCode === 'init') {
      const coin = await fetchPrice(addr);
      const ref = pos.avgBuyPrice || pos.buyPriceUsd;
      if (coin?.priceUsd && ref) {
        const mult = coin.priceUsd / ref;
        const pct = Math.min(100, Math.round(100 / mult));
        const r = executeSell(addr, pct, walletPath);
        if (r.success) {
          savePositions(positions);
          const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
          bot.sendMessage(chatId, '✅ Sold initials (~' + pct + '%) of *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
          sendCoinDetail(chatId, addr);
        } else {
          bot.sendMessage(chatId, '❌ Sell failed: `' + r.error + '`', { parse_mode: 'Markdown' });
        }
      } else {
        bot.sendMessage(chatId, '❌ Price data unavailable for initials calculation.');
      }
    } else {
      const pct = parseInt(pctCode);
      const r = executeSell(addr, pct, walletPath);
      if (r.success) {
        if (pct === 100) pos.fullyExited = true;
        savePositions(positions);
        const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
        bot.sendMessage(chatId, '✅ Sold *' + pct + '%* of *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
        sendCoinDetail(chatId, addr);
      } else {
        bot.sendMessage(chatId, '❌ Sell failed: `' + r.error + '`', { parse_mode: 'Markdown' });
      }
    }
  }

  // ── TP managers ──
  else if (data === 'tp_global') { sendGlobalTpManager(chatId); }
  else if (data.startsWith('ptpm_')) {
    const addr = addrFromKey(data.replace('ptpm_', ''));
    sendCoinTpManager(chatId, addr);
  }
  // Global TP edits
  else if (data === 'gtpa') {
    sessions[chatId] = { type: 'tp', step: 'pct', data: { editIndex: -1 }, createdAt: Date.now() };
    bot.sendMessage(chatId, '➕ *Add Global TP*\nEnter trigger %:', { parse_mode: 'Markdown' });
  }
  else if (data.startsWith('gtpd_')) {
    const i = parseInt(data.replace('gtpd_', ''));
    state.tpOrders.splice(i, 1); saveState(state); sendGlobalTpManager(chatId);
  }
  else if (data.startsWith('gtpep_')) {
    const i = parseInt(data.replace('gtpep_', ''));
    sessions[chatId] = { type: 'tp', step: 'pct', data: { editIndex: i }, createdAt: Date.now() };
    bot.sendMessage(chatId, '✏️ Edit TP' + (i+1) + ' trigger (current: +' + state.tpOrders[i].pct + '%):\nEnter new %:');
  }
  else if (data.startsWith('gtpes_')) {
    const i = parseInt(data.replace('gtpes_', ''));
    sessions[chatId] = { type: 'tp', step: 'sell', data: { editIndex: i, pct: state.tpOrders[i].pct }, createdAt: Date.now() };
    bot.sendMessage(chatId, '✏️ Edit TP' + (i+1) + ' sell % (current: ' + state.tpOrders[i].sellPct + '%):\nEnter new %:');
  }
  // Per-coin TP edits
  else if (data.startsWith('tpa_')) {
    const addr = addrFromKey(data.replace('tpa_', ''));
    sessions[chatId] = { type: 'tp', step: 'pct', data: { editIndex: -1, forCoin: addr }, createdAt: Date.now() };
    bot.sendMessage(chatId, '➕ *Add TP for ' + (positions[addr]?.coinName || addr) + '*\nEnter trigger %:', { parse_mode: 'Markdown' });
  }
  else if (data.startsWith('tpd_')) {
    const parts = data.split('_'); const i = parseInt(parts[parts.length-1]); const k = parts.slice(1, parts.length-1).join('_');
    const addr = addrFromKey(k);
    if (positions[addr]?.customTpOrders) { positions[addr].customTpOrders.splice(i, 1); positions[addr].tpHits.splice(i, 1); savePositions(positions); }
    sendCoinTpManager(chatId, addr);
  }
  else if (data.startsWith('tper_')) {
    const addr = addrFromKey(data.replace('tper_', ''));
    if (positions[addr]) { positions[addr].customTpOrders = null; positions[addr].tpHits = new Array(state.tpOrders.length).fill(false); savePositions(positions); }
    sendCoinTpManager(chatId, addr);
  }
  else if (data.startsWith('tpep_')) {
    const parts = data.split('_'); const i = parseInt(parts[parts.length-1]); const k = parts.slice(1, parts.length-1).join('_');
    const addr = addrFromKey(k);
    sessions[chatId] = { type: 'tp', step: 'pct', data: { editIndex: i, forCoin: addr }, createdAt: Date.now() };
    bot.sendMessage(chatId, '✏️ Edit trigger for TP' + (i+1) + ':');
  }
  else if (data.startsWith('tpes_')) {
    const parts = data.split('_'); const i = parseInt(parts[parts.length-1]); const k = parts.slice(1, parts.length-1).join('_');
    const addr = addrFromKey(k);
    const orders = positions[addr]?.customTpOrders || state.tpOrders;
    sessions[chatId] = { type: 'tp', step: 'sell', data: { editIndex: i, pct: orders[i].pct, forCoin: addr }, createdAt: Date.now() };
    bot.sendMessage(chatId, '✏️ Edit sell % for TP' + (i+1) + ':');
  }
  else if (data.startsWith('tpr_')) {
    const addr = addrFromKey(data.replace('tpr_', ''));
    if (positions[addr]) { positions[addr].customTpOrders = null; positions[addr].tpHits = new Array(state.tpOrders.length).fill(false); savePositions(positions); }
    sendCoinTpManager(chatId, addr);
  }

  // ── Manual pending buys ──
  else if (data.startsWith('pby_')) {
    const key = data.replace('pby_', '');
    const pending = sessions[key] || sessions[Object.keys(sessions).find(k => k.includes(key))];
    if (!pending) { bot.sendMessage(chatId, '⏰ Expired.'); return; }
    const r = executeBuy(pending.address, state.ethAmount, BUYER_WALLET);
    if (r.success) {
      addrKey(pending.address);
      positions[pending.address] = {
        coinName: pending.coinName, address: pending.address, buyPriceUsd: pending.buyPriceUsd,
        boughtAt: Date.now(), ethSpent: state.ethAmount, source: 'watcher',
        tpHits: new Array(state.tpOrders.length).fill(false), customTpOrders: null, fullyExited: false,
      };
      savePositions(positions);
      const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
      bot.sendMessage(chatId, '✅ Bought *' + pending.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, '❌ Buy failed: `' + r.error + '`', { parse_mode: 'Markdown' });
    }
    Object.keys(sessions).filter(k => k.includes(key)).forEach(k => delete sessions[k]);
  }
  else if (data.startsWith('psk_')) {
    const key = data.replace('psk_', '');
    Object.keys(sessions).filter(k => k.includes(key)).forEach(k => delete sessions[k]);
    bot.sendMessage(chatId, '⏭ Skipped.');
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Rebuild addrLookup from existing positions on startup
Object.keys(positions).forEach(addr => addrKey(addr));
log('Address lookup rebuilt: ' + Object.keys(addrLookup).length + ' entries');

log('🐸 Zora Combined Bot starting...');
bot.getMe().then(me => {
  log('Bot: @' + me.username + ' | Admin: ' + ADMIN_ID);
  log('Buyer wallet: ' + BUYER_WALLET);
  log('DCA wallet: ' + DCA_WALLET);
}).catch(e => { log('ERROR: ' + e.message); process.exit(1); });
