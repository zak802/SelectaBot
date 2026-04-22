/**
 * 🎵 SelectaBot — Zora Trading Bot
 * ─────────────────────────────────────────────────────────────────────────────
 * Features:
 *   1. 👂 Listener     — group watcher, auto/manual buy
 *   2. 📈 DCA          — basket-based DCA engine
 *   3. 💰 Wallets      — balances, transfer, cash out
 *   4. 📊 Positions    — grouped P&L, buy more, sell
 */

'use strict';
require('dotenv').config();
const TelegramBot  = require('node-telegram-bot-api');
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const https        = require('https');

// ── SDK (fast price fetching) ─────────────────────────────────────────────────
let sdkGetCoin = null;
try {
  const sdk = require('/home/node/.local/lib/node_modules/@zoralabs/cli/node_modules/@zoralabs/coins-sdk');
  sdkGetCoin = sdk.getCoin;
} catch { /* fallback to CLI */ }

// ── Config ────────────────────────────────────────────────────────────────────
const TOKEN          = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID       = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
const BUYER_WALLET   = process.env.BUYER_WALLET_PATH || '/home/node/.config/zora/wallet.json';
const DCA_WALLET     = process.env.DCA_WALLET_PATH   || '/home/node/.config/zora/wallet-dca.json';
const ZORA_CLI       = path.join(process.env.HOME, '.local/bin/zora');
const STATE_FILE     = path.join(__dirname, 'state.json');
const POSITIONS_FILE = path.join(__dirname, 'positions.json');
const LOG_FILE       = path.join(__dirname, 'bot.log');
const LOG_MAX        = 500 * 1024; // 500 KB

if (!TOKEN || !ADMIN_ID) { console.error('Missing env: TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID'); process.exit(1); }

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try {
    try { if (fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// ── Address helpers (64-byte callback_data limit) ─────────────────────────────
const addrLookup = {};  // key -> address

function addrKey(address) {
  const k = 'a' + address.slice(2, 10).toLowerCase();
  addrLookup[k] = address.toLowerCase();
  return k;
}
function addrFromKey(k) {
  return addrLookup[k] || k;
}
function shortId(id) { return id.slice(0, 8); }
function findBasketByShort(sid) {
  return (state.dca.baskets || []).find(b => b.id && b.id.startsWith(sid));
}
function genId() { return 'b_' + Math.random().toString(16).slice(2, 10); }

// ── State ─────────────────────────────────────────────────────────────────────
function defaultState() {
  return {
    botName: process.env.BOT_NAME || 'SelectaBot',
    watcherEnabled: true,
    autoMode: true,
    ethAmount: 0.005,
    buyAmountMode: 'eth',  // 'eth' or 'usd'
    stopLossPct: 20,
    watcherPriceCheckEnabled: true,
    tpOrders: [
      { pct: 25,  sellPct: 33 },
      { pct: 50,  sellPct: 33 },
      { pct: 100, sellPct: 34 },
    ],
    dca: { baskets: [] },
  };
}

function migrateState(raw) {
  const s = { ...defaultState(), ...raw };
  // Migrate: missing botName
  if (!s.botName) s.botName = process.env.BOT_NAME || 'SelectaBot';
  // Migrate: old flat DCA -> basket array
  if (s.dca && !Array.isArray(s.dca.baskets)) {
    const old = s.dca;
    const basket = {
      id: genId(),
      name: 'Default',
      enabled: old.enabled || false,
      intervalMinutes: (old.intervalHours || 6) * 60,
      ethPerCoin: old.ethPerCoin || 0.002,
      totalBudget: null,
      totalSpent: 0,
      maxRuns: null,
      runsCompleted: 0,
      nextRunAt: old.nextDcaAt || null,
      lastRunAt: old.lastDcaAt || null,
      mode: 'leaderboard',
      minMcap: old.minMcap || 100000,
      minHolders: old.minHolders || 1000,
      maxCoins: old.maxCoins || 5,
      coinType: 'all',
      lbSort: 'mcap',
      coins: (old.customCoins || []).map(c => ({ address: c.address, name: c.name })),
      tpOrders: s.tpOrders,
      slPct: old.slPct || 15,
    };
    s.dca = { baskets: [basket] };
    log('[migrate] Converted flat DCA -> basket: ' + basket.name);
  }
  // Ensure baskets have all fields
  for (const b of (s.dca.baskets || [])) {
    if (!b.id)              b.id = genId();
    if (b.coinType == null) b.coinType = 'all';
    if (b.lbSort == null)   b.lbSort = 'mcap';
    if (!b.mode)            b.mode = 'leaderboard';
    if (!b.coins)           b.coins = [];
    if (!b.tpOrders)        b.tpOrders = [...s.tpOrders];
    if (b.slPct == null)    b.slPct = 15;
    if (b.totalSpent == null) b.totalSpent = 0;
  }
  return s;
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return migrateState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch {}
  }
  return defaultState();
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
let state = loadState();

function loadPositions() {
  if (fs.existsSync(POSITIONS_FILE)) {
    try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch {}
  }
  return {};
}
function savePositions(p) { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }
let positions = loadPositions();

// Rebuild addrLookup from positions on startup
Object.keys(positions).forEach(a => addrKey(a));

// ── ETH Price Oracle ──────────────────────────────────────────────────────────
// WETH on Base: 0x4200000000000000000000000000000000000006
let _ethPrice = 3500;
let _ethPriceFetchedAt = 0;

async function getEthPrice() {
  if (Date.now() - _ethPriceFetchedAt < 5 * 60 * 1000) return _ethPrice;
  try {
    const res = await dexFetch('https://api.dexscreener.com/latest/dex/tokens/0x4200000000000000000000000000000000000006');
    const pairs = (res?.pairs || []).filter(p => p.chainId === 'base' && p.quoteToken?.symbol === 'USDC');
    if (pairs[0]?.priceUsd) {
      _ethPrice = parseFloat(pairs[0].priceUsd);
      _ethPriceFetchedAt = Date.now();
    }
  } catch {}
  return _ethPrice;
}

// ── DexScreener helpers ───────────────────────────────────────────────────────
function dexFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SelectaBot/2.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

// 1 req/sec rate limit
let _lastDexCall = 0;
async function dexRL(url) {
  const wait = Math.max(0, 1100 - (Date.now() - _lastDexCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastDexCall = Date.now();
  return dexFetch(url);
}

// ── CLI helpers ───────────────────────────────────────────────────────────────
function walletKey(walletPath) {
  try { return JSON.parse(fs.readFileSync(walletPath, 'utf8')).privateKey; }
  catch { return null; }
}
function cliEnv(walletPath) {
  const pk = walletKey(walletPath);
  return {
    ...process.env,
    PATH: process.env.HOME + '/.local/bin:/usr/local/bin:' + process.env.PATH,
    ...(pk ? { ZORA_PRIVATE_KEY: pk } : {}),
  };
}
function getWalletAddress(walletPath) {
  try {
    const w = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    if (w.address) return w.address;
    const out = execSync(ZORA_CLI + ' wallet info --json', { env: cliEnv(walletPath) }).toString();
    return JSON.parse(out).address || null;
  } catch { return null; }
}
function executeBuy(address, eth, walletPath) {
  try {
    const out = execSync(ZORA_CLI + ' buy ' + address + ' --eth ' + eth + ' --yes --json',
      { env: cliEnv(walletPath), timeout: 60000 }).toString();
    return { success: true, data: JSON.parse(out) };
  } catch (e) { return { success: false, error: e.message.slice(0, 200) }; }
}
function executeSell(address, pct, walletPath) {
  try {
    const out = execSync(ZORA_CLI + ' sell ' + address + ' --percent ' + pct + ' --yes --json',
      { env: cliEnv(walletPath), timeout: 60000 }).toString();
    return { success: true, data: JSON.parse(out) };
  } catch (e) { return { success: false, error: e.message.slice(0, 200) }; }
}
function executeTransfer(fromWalletPath, toAddress, ethAmount) {
  try {
    const pk = walletKey(fromWalletPath);
    if (!pk) throw new Error('No private key in wallet file');
    const wei = BigInt(Math.round(parseFloat(ethAmount) * 1e18)).toString();
    const out = execSync(
      'cast send --private-key ' + pk + ' --value ' + wei + ' ' + toAddress +
      ' --rpc-url https://mainnet.base.org --json',
      { env: { ...process.env, PATH: process.env.HOME + '/.local/bin:/usr/local/bin:' + process.env.PATH }, timeout: 60000 }
    ).toString();
    return { success: true, data: JSON.parse(out) };
  } catch (e) { return { success: false, error: e.message.slice(0, 200) }; }
}
function getBalance(walletPath) {
  try {
    const out = execSync(ZORA_CLI + ' balance --json', { env: cliEnv(walletPath), timeout: 30000 }).toString();
    return JSON.parse(out);
  } catch { return null; }
}

// ── Price fetching ────────────────────────────────────────────────────────────
async function fetchPrice(address) {
  if (sdkGetCoin) {
    try {
      const r = await sdkGetCoin({ address });
      const c = r?.data?.zora20Token;
      if (c) return {
        name: c.name, priceUsd: parseFloat(c.marketCap || 0) / 1e9,
        marketCap: parseFloat(c.marketCap || 0), uniqueHolders: c.uniqueHolders,
      };
    } catch {}
  }
  try {
    const out = execSync(ZORA_CLI + ' get ' + address + ' --json',
      { env: cliEnv(BUYER_WALLET), timeout: 20000 }).toString();
    const d = JSON.parse(out);
    const priceUsd = d.priceUsd || (parseFloat(d.marketCap || 0) / 1e9);
    return { name: d.name, priceUsd, marketCap: parseFloat(d.marketCap || 0), uniqueHolders: d.uniqueHolders };
  } catch { return null; }
}

// ── URL / address detection ───────────────────────────────────────────────────
const ZORA_RE = /https?:\/\/(?:www\.)?zora\.co\/(?:coin\/(0x[a-fA-F0-9]{40})|collect\/base:(0x[a-fA-F0-9]{40}))/g;
const ADDR_RE = /(?:^|\s)(0x[a-fA-F0-9]{40})(?:\s|$)/gm;

function extractAddresses(text) {
  const out = []; let m;
  const uz = new RegExp(ZORA_RE.source, 'g');
  while ((m = uz.exec(text)) !== null) out.push((m[1] || m[2]).toLowerCase());
  const ua = new RegExp(ADDR_RE.source, 'gm');
  while ((m = ua.exec(text)) !== null) out.push(m[1].toLowerCase());
  return [...new Set(out)];
}

// ── Session management ────────────────────────────────────────────────────────
const sessions = {};
const SESSION_TTL = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const k of Object.keys(sessions)) {
    if (!sessions[k].createdAt || now - sessions[k].createdAt > SESSION_TTL) { delete sessions[k]; n++; }
  }
  if (n > 0) log('[cleanup] Expired ' + n + ' session(s)');
}, 5 * 60 * 1000);

// ── Position helpers ──────────────────────────────────────────────────────────
function getEffectiveTps(pos) { return pos.customTpOrders || state.tpOrders; }
function ensureTpHits(pos) {
  const tps = getEffectiveTps(pos);
  if (!pos.tpHits || pos.tpHits.length !== tps.length) pos.tpHits = new Array(tps.length).fill(false);
}
function posWallet(pos) {
  if (pos.source && pos.source.startsWith('b_')) return DCA_WALLET;
  return BUYER_WALLET;
}

// ── USD/ETH helpers ───────────────────────────────────────────────────────────
async function ethFromAmount(ethAmount) {
  // ethAmount is always stored in ETH; USD mode just controls display
  return parseFloat(ethAmount);
}
async function usdLabel(eth) {
  const price = await getEthPrice();
  return '$' + (eth * price).toFixed(2);
}
async function buyAmountLine() {
  const eth = state.ethAmount;
  if (state.buyAmountMode === 'usd') {
    const usd = await usdLabel(eth);
    return usd + ' (~' + eth.toFixed(5) + ' ETH)';
  }
  const usd = await usdLabel(eth);
  return eth + ' ETH (~' + usd + ')';
}

// ── Bot instance ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

// ── DCA Basket Engine ─────────────────────────────────────────────────────────
async function getLeaderboard(basket) {
  try {
    const sortFlag = basket.lbSort === 'volume' ? '--sort volume' :
                     basket.lbSort === 'holders' ? '--sort holders' : '--sort mcap';
    const coinTypeFlag = basket.coinType === 'zora' ? '--platform zora' :
                         basket.coinType === 'virtuals' ? '--platform virtuals' : '';
    const cmd = ZORA_CLI + ' explore ' + sortFlag + ' ' + coinTypeFlag + ' --json';
    const out = execSync(cmd, { env: cliEnv(DCA_WALLET), timeout: 30000 }).toString();
    const all = JSON.parse(out).coins || [];
    return all.filter(c =>
      (c.marketCap || 0) >= basket.minMcap &&
      (c.uniqueHolders || 0) >= basket.minHolders &&
      !c.platformBlocked
    ).slice(0, basket.maxCoins);
  } catch (e) {
    log('[dca] Leaderboard fetch failed: ' + e.message);
    return [];
  }
}

async function runBasket(basket) {
  log('[dca] Running basket: ' + basket.name);
  const lines = [];

  // Budget check
  if (basket.totalBudget !== null && basket.totalSpent >= basket.totalBudget) {
    log('[dca] Basket ' + basket.name + ' budget exhausted');
    basket.enabled = false;
    saveState(state);
    bot.sendMessage(ADMIN_ID, '💸 *' + basket.name + '* budget exhausted — basket paused.', { parse_mode: 'Markdown' });
    return;
  }
  // Max runs check
  if (basket.maxRuns !== null && basket.runsCompleted >= basket.maxRuns) {
    log('[dca] Basket ' + basket.name + ' max runs reached');
    basket.enabled = false;
    saveState(state);
    bot.sendMessage(ADMIN_ID, '🏁 *' + basket.name + '* max runs reached — basket paused.', { parse_mode: 'Markdown' });
    return;
  }

  let coinsToBuy = [];
  if (basket.mode === 'leaderboard') {
    const lb = await getLeaderboard(basket);
    coinsToBuy = lb.map(c => ({ address: c.address, name: c.name, priceUsd: c.priceUsd }));
  } else {
    // Specific coins mode
    coinsToBuy = (basket.coins || []).map(c => ({ address: c.address, name: c.name, priceUsd: null }));
  }

  if (!coinsToBuy.length) {
    bot.sendMessage(ADMIN_ID, '⚠️ *' + basket.name + '*: no coins to buy this cycle.', { parse_mode: 'Markdown' });
    return;
  }

  const balRaw = getBalance(DCA_WALLET);
  const bal = parseFloat(balRaw?.wallet?.[0]?.balance || '0');

  for (const coin of coinsToBuy) {
    const eth = basket.ethPerCoin;
    if (bal < eth * 0.99) { lines.push('⚠️ ' + coin.name + ' (low balance)'); continue; }
    // Budget cap
    const remaining = basket.totalBudget !== null ? basket.totalBudget - basket.totalSpent : Infinity;
    if (eth > remaining) { lines.push('⚠️ ' + coin.name + ' (over budget)'); continue; }

    const r = executeBuy(coin.address, eth, DCA_WALLET);
    if (r.success) {
      const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
      addrKey(coin.address);
      basket.totalSpent = (basket.totalSpent || 0) + eth;
      if (!positions[coin.address]) {
        positions[coin.address] = {
          coinName: coin.name, address: coin.address,
          buyPriceUsd: coin.priceUsd, avgBuyPrice: coin.priceUsd,
          boughtAt: Date.now(), ethSpent: eth, source: basket.id,
          tpHits: new Array(basket.tpOrders.length).fill(false),
          customTpOrders: null, fullyExited: false,
        };
      } else {
        const pos = positions[coin.address];
        const pp = pos.avgBuyPrice || pos.buyPriceUsd;
        if (pp && coin.priceUsd) {
          const tot = (pos.ethSpent || 0) + eth;
          pos.avgBuyPrice = ((pp * (pos.ethSpent || 0)) + (coin.priceUsd * eth)) / tot;
        }
        pos.ethSpent = (pos.ethSpent || 0) + eth;
        if (!pos.source || pos.source !== basket.id) pos.source = basket.id;
      }
      savePositions(positions);
      lines.push('✅ ' + coin.name + ' @' + (coin.priceUsd ? '$' + coin.priceUsd.toFixed(6) : '?'));
      log('[dca] Bought ' + coin.name + ' tx:' + tx);
    } else {
      lines.push('❌ ' + coin.name + ' (failed)');
      log('[dca] Buy failed ' + coin.name + ': ' + r.error);
    }
  }

  basket.runsCompleted = (basket.runsCompleted || 0) + 1;
  basket.lastRunAt = Date.now();
  basket.nextRunAt = Date.now() + basket.intervalMinutes * 60000;
  saveState(state);
  savePositions(positions);

  const nextStr = new Date(basket.nextRunAt).toUTCString().slice(0, 25);
  bot.sendMessage(ADMIN_ID,
    '✅ *' + basket.name + '* cycle complete\n\n' + lines.join('\n') + '\n\nNext: ' + nextStr,
    { parse_mode: 'Markdown' }
  );
}

// Per-minute basket ticker
setInterval(async () => {
  const now = Date.now();
  for (const basket of (state.dca.baskets || [])) {
    if (!basket.enabled) continue;
    if (!basket.nextRunAt || now >= basket.nextRunAt) {
      await runBasket(basket);
    }
  }
}, 60 * 1000);

// ── Price Watcher (5 min) ─────────────────────────────────────────────────────
setInterval(async () => {
  if (!state.watcherPriceCheckEnabled) return;
  const addrs = Object.keys(positions).filter(a => !positions[a].fullyExited);
  if (!addrs.length) return;
  log('[watcher] Checking ' + addrs.length + ' position(s)');

  const ethPrice = await getEthPrice();

  for (const address of addrs) {
    const pos = positions[address];
    const ref = pos.avgBuyPrice || pos.buyPriceUsd;
    if (!ref) continue;
    let coin;
    try { coin = await fetchPrice(address); } catch { continue; }
    if (!coin?.priceUsd) continue;

    const chg = ((coin.priceUsd - ref) / ref) * 100;
    const activeTps = getEffectiveTps(pos);
    ensureTpHits(pos);
    const wallet = posWallet(pos);

    // Get basket SL if applicable
    let slPct = state.stopLossPct;
    if (pos.source && pos.source.startsWith('b_')) {
      const basket = (state.dca.baskets || []).find(b => b.id === pos.source);
      if (basket) slPct = basket.slPct;
    }

    // Trigger TPs
    for (let i = 0; i < activeTps.length; i++) {
      if (pos.tpHits[i]) continue;
      if (chg >= activeTps[i].pct) {
        log('[watcher] TP' + (i+1) + ' hit: ' + pos.coinName + ' +' + chg.toFixed(1) + '%');
        bot.sendMessage(ADMIN_ID,
          '🟢 *TP' + (i+1) + ' hit!* ' + pos.coinName + ' +' + chg.toFixed(1) + '%\nSelling ' + activeTps[i].sellPct + '%...',
          { parse_mode: 'Markdown' });
        const r = executeSell(address, activeTps[i].sellPct, wallet);
        if (r.success) {
          pos.tpHits[i] = true;
          const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
          if (i === activeTps.length - 1) pos.fullyExited = true;
          bot.sendMessage(ADMIN_ID, '✅ TP' + (i+1) + ' sold ' + activeTps[i].sellPct + '% *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
        } else {
          bot.sendMessage(ADMIN_ID, '❌ TP sell failed: *' + pos.coinName + '*\n`' + r.error + '`', { parse_mode: 'Markdown' });
        }
        break;
      }
    }

    // Stop loss
    if (!pos.fullyExited && chg <= -Math.abs(slPct)) {
      log('[watcher] SL hit: ' + pos.coinName + ' ' + chg.toFixed(1) + '%');
      bot.sendMessage(ADMIN_ID, '🔴 *Stop-Loss!* ' + pos.coinName + ' ' + chg.toFixed(1) + '%\nSelling 100%...', { parse_mode: 'Markdown' });
      const r = executeSell(address, 100, wallet);
      if (r.success) {
        pos.fullyExited = true;
        const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
        bot.sendMessage(ADMIN_ID, '✅ SL exit *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(ADMIN_ID, '❌ SL sell failed: *' + pos.coinName + '*\n`' + r.error + '`', { parse_mode: 'Markdown' });
      }
    }
    savePositions(positions);

    // Rate limit: small delay between coins
    await new Promise(r => setTimeout(r, 1200));
  }
}, 5 * 60 * 1000);

// ── Group Watcher ─────────────────────────────────────────────────────────────
async function handleGroupBuy(address, groupName, fromUser) {
  if (!state.watcherEnabled) return;
  // Don't rebuy fully exited positions unless manually
  if (positions[address]?.fullyExited) return;

  const coin = await fetchPrice(address);
  const coinName = coin?.name || address.slice(0, 10) + '...';
  const buyPriceUsd = coin?.priceUsd || null;
  const ethAmt = state.ethAmount;
  const tpSummary = state.tpOrders.map((t, i) => 'TP' + (i+1) + ':+' + t.pct + '%→' + t.sellPct + '%').join(' ');

  log('[watcher] Coin spotted: ' + coinName + ' from ' + fromUser + ' in ' + (groupName || 'group'));

  if (state.autoMode) {
    const result = executeBuy(address, ethAmt, BUYER_WALLET);
    if (result.success) {
      const tx = result.data?.txHash || result.data?.transactionHash || 'pending';
      const k = addrKey(address);
      positions[address] = {
        coinName, address, buyPriceUsd, avgBuyPrice: buyPriceUsd,
        boughtAt: Date.now(), ethSpent: ethAmt, source: 'watcher',
        tpHits: new Array(state.tpOrders.length).fill(false), customTpOrders: null, fullyExited: false,
      };
      savePositions(positions);
      bot.sendMessage(ADMIN_ID,
        '🛒 *Bought ' + coinName + '*\n' + ethAmt + ' ETH | ' + tpSummary + ' | SL:-' + state.stopLossPct + '%\nFrom @' + fromUser + ' in ' + (groupName || 'group') + '\nTx: `' + tx + '`',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
          [{ text: '📊 View Position', callback_data: 'pd_' + k }],
          [{ text: '◀️ Home', callback_data: 'home' }],
        ]}}
      );
    } else {
      bot.sendMessage(ADMIN_ID, '❌ Buy failed: *' + coinName + '*\n`' + result.error + '`', { parse_mode: 'Markdown' });
    }
  } else {
    const k = addrKey(address);
    const pending_key = 'pnd_' + Date.now();
    sessions[pending_key] = { address, coinName, buyPriceUsd, createdAt: Date.now() };
    bot.sendMessage(ADMIN_ID,
      '🔔 *' + coinName + '* spotted in ' + (groupName || 'group') + '\nBy @' + fromUser + '\nBuy for *' + ethAmt + ' ETH*?',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '✅ Buy', callback_data: 'pby_' + pending_key },
        { text: '❌ Skip', callback_data: 'psk_' + pending_key },
      ]]}}
    );
  }
}

// ── Token Scanner ─────────────────────────────────────────────────────────────
async function scanToken(chatId, address) {
  address = address.toLowerCase();
  bot.sendMessage(chatId, '🔍 Scanning `' + address.slice(0, 8) + '...' + address.slice(-4) + '`…', { parse_mode: 'Markdown' });

  let dexData = null; let zoraCoin = null;
  try {
    const res = await dexRL('https://api.dexscreener.com/latest/dex/tokens/' + address);
    const pairs = (res?.pairs || []).filter(p => p.chainId === 'base');
    if (pairs.length > 0) {
      dexData = pairs.reduce((best, p) => (!best || (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0)) ? p : best, null);
    }
  } catch (e) { log('[scan] DexScreener error: ' + e.message); }

  if (sdkGetCoin) {
    try { const r = await sdkGetCoin({ address }); zoraCoin = r?.data?.zora20Token; } catch {}
  }

  if (!dexData && !zoraCoin) {
    bot.sendMessage(chatId, '❌ No data found on Base for this address.');
    return;
  }

  const token   = dexData?.baseToken || {};
  const name    = zoraCoin?.name || token.name || 'Unknown';
  const symbol  = token.symbol || name;
  const mcap    = dexData?.marketCap    ? '$' + num(dexData.marketCap) : (zoraCoin?.marketCap ? '$' + num(zoraCoin.marketCap) : '?');
  const price   = dexData?.priceUsd     ? '$' + parseFloat(dexData.priceUsd).toFixed(8) : '?';
  const liqUsd  = dexData?.liquidity?.usd ? '$' + num(dexData.liquidity.usd) : '?';
  const liqPct  = (dexData?.liquidity?.usd && dexData?.marketCap)
    ? (parseFloat(dexData.liquidity.usd) / parseFloat(dexData.marketCap) * 100).toFixed(1) + '%' : '?';
  const vol24   = dexData?.volume?.h24  ? '$' + num(dexData.volume.h24) : '?';
  const chg1h   = fmtChg(dexData?.priceChange?.h1);
  const chg24   = fmtChg(dexData?.priceChange?.h24);
  const buys24  = dexData?.txns?.h24?.buys ?? '?';
  const sells24 = dexData?.txns?.h24?.sells ?? '?';
  const holders = zoraCoin?.uniqueHolders ? zoraCoin.uniqueHolders.toLocaleString() : '?';
  const created = dexData?.pairCreatedAt ? new Date(dexData.pairCreatedAt).toLocaleDateString() : '?';
  const liqNum  = parseFloat(dexData?.liquidity?.usd || 0);
  const liqWarn = liqNum < 1000 ? '\n🚨 *VERY LOW LIQUIDITY*' : liqNum < 5000 ? '\n⚠️ Low liquidity' : '';

  // Detect factory
  const sites  = (dexData?.info?.websites || []).map(w => w.url || '');
  const labels = dexData?.labels || [];
  let factory = '❓ Unknown';
  if (sites.some(u => u.includes('zora.co'))) factory = '🟣 Zora ✅';
  else if (sites.some(u => u.includes('virtuals.io'))) factory = '🤖 Virtuals';
  else if (sites.some(u => u.includes('clanker'))) factory = '🔧 Clanker';
  else if (labels.includes('v4')) factory = '🦄 Uniswap V4';
  else if (labels.includes('v3')) factory = '🦄 Uniswap V3';
  else if (labels.includes('v2')) factory = '🦄 Uniswap V2';

  const k = addrKey(address);
  const inPos = !!positions[address];
  const ethAmt = state.ethAmount;

  const msg = liqWarn + '\n\n*' + name.toUpperCase() + '* (' + symbol + ')\n`' + address + '`\n\n' +
    '🏭 ' + factory + '\n' +
    '📊 Mcap: *' + mcap + '*  24h: *' + chg24 + '*\n' +
    '💧 Liq: *' + liqUsd + '* (' + liqPct + ')\n' +
    '💹 Price: ' + price + '\n' +
    '📦 Vol 24h: *' + vol24 + '*\n' +
    '🔄 ' + buys24 + '🟢 / ' + sells24 + '🔴  |  1h: ' + chg1h + '\n' +
    '👥 Holders: ' + holders + '\n' +
    '📅 Created: ' + created;

  bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🟢 Buy ' + ethAmt + ' ETH', callback_data: 'scanbuy_x_' + k }],
      [{ text: '📈 DCA This Coin', callback_data: 'scandca_' + k }, { text: '🔄 Refresh', callback_data: 'scan_' + k }],
      inPos ? [{ text: '📋 View Position', callback_data: 'pd_' + k }] : [],
      [{ text: '◀️ Home', callback_data: 'home' }],
    ].filter(r => r.length > 0)}
  });
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function num(n) { return parseFloat(n).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtChg(v) { if (v == null) return '?'; return (v >= 0 ? '+' : '') + v + '%'; }
function fmtEth(n) { return parseFloat(n).toFixed(5); }

// ── Main Menu ─────────────────────────────────────────────────────────────────
async function sendMainMenu(chatId) {
  const openPos = Object.keys(positions).filter(a => !positions[a].fullyExited).length;
  const wIcon = state.watcherEnabled ? '🟢' : '🔴';
  const activeBaskets = (state.dca.baskets || []).filter(b => b.enabled).length;
  const dcaIcon = activeBaskets > 0 ? '🟢' : '🔴';
  const botName = state.botName || 'SelectaBot';

  bot.sendMessage(chatId,
    '*🎵 ' + botName + '*\n\n' +
    '*👂 Listener*\nAdd the bot to a group chat and auto-buy every coin discussed\n\n' +
    '*📈 DCA*\nSet up buys for coins, or groups of coins, on regular intervals\n\n' +
    wIcon + ' Listener  ' + dcaIcon + ' DCA  📊 ' + openPos + ' open positions',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '👂 Listener', callback_data: 'listener' }, { text: '📈 DCA', callback_data: 'dcap' }],
        [{ text: '💰 Wallets', callback_data: 'wallets' }, { text: '📊 Positions', callback_data: 'posp' }],
        [{ text: '📲 Download Zora', url: 'https://zora.co/download' }, { text: '⚙️ Settings', callback_data: 'setp' }],
      ]}
    }
  );
}

// ── Listener Panel ────────────────────────────────────────────────────────────
async function sendListenerPanel(chatId) {
  const amtLine = await buyAmountLine();
  const tpList = state.tpOrders.map((t, i) => 'TP' + (i+1) + ': +' + t.pct + '% → sell ' + t.sellPct + '%').join('\n');

  bot.sendMessage(chatId,
    '*👂 Listener*\n\n' +
    'Status: ' + (state.watcherEnabled ? '🟢 ON' : '🔴 OFF') + '\n' +
    'Mode: ' + (state.autoMode ? '⚡ Auto-buy' : '👋 Manual confirm') + '\n' +
    'Buy: *' + amtLine + '*\n' +
    'Stop-loss: *-' + state.stopLossPct + '%*\n\n' +
    '*Take-Profit Orders:*\n' + tpList,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [
          { text: state.watcherEnabled ? '🔴 Turn OFF' : '🟢 Turn ON', callback_data: 'w_toggle' },
          { text: state.autoMode ? '👋 Switch to Manual' : '⚡ Switch to Auto', callback_data: 'w_mode' },
        ],
        [{ text: '💰 Buy Amount', callback_data: 'w_amount' }, { text: '📉 Stop-Loss', callback_data: 'w_sl' }],
        [{ text: '📈 TP Orders', callback_data: 'tp_global' }],
        [{ text: '◀️ Home', callback_data: 'home' }],
      ]}
    }
  );
}

// ── DCA Panel (basket list) ────────────────────────────────────────────────────
function sendDcaPanel(chatId) {
  const baskets = state.dca.baskets || [];
  const keyboard = [[{ text: '➕ New Basket', callback_data: 'b_new' }]];

  for (const b of baskets) {
    const icon = b.enabled ? '🟢' : '⏸';
    const next = b.nextRunAt ? '  Next: ' + new Date(b.nextRunAt).toUTCString().slice(5, 17) : '';
    keyboard.push([{ text: icon + ' ' + b.name + next, callback_data: 'b_det_' + shortId(b.id) }]);
  }
  keyboard.push([{ text: '◀️ Home', callback_data: 'home' }]);

  bot.sendMessage(chatId,
    '*📈 DCA Engine*\n\n' +
    (baskets.length ? baskets.length + ' basket(s) configured' : 'No baskets yet. Create one to start DCA.'),
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ── Basket Detail ─────────────────────────────────────────────────────────────
function sendBasketDetail(chatId, basket) {
  const sid = shortId(basket.id);
  const nextStr = basket.nextRunAt ? new Date(basket.nextRunAt).toUTCString().slice(0, 25) : 'Not scheduled';
  const modeStr = basket.mode === 'leaderboard'
    ? 'Leaderboard (' + basket.lbSort + ', ' + basket.maxCoins + ' coins)'
    : 'Custom coins (' + (basket.coins || []).length + ')';

  bot.sendMessage(chatId,
    '*' + (basket.enabled ? '🟢' : '⏸') + ' ' + basket.name + '*\n\n' +
    '📅 Every *' + (basket.intervalMinutes >= 1440 ? (basket.intervalMinutes/1440).toFixed(1) + 'd' : basket.intervalMinutes >= 60 ? (basket.intervalMinutes/60).toFixed(1) + 'h' : basket.intervalMinutes + 'min') + '*' +
    '  |  💎 *' + basket.ethPerCoin + ' ETH/coin*\n' +
    '🔄 Runs: ' + basket.runsCompleted + (basket.maxRuns ? '/' + basket.maxRuns : '') + '\n' +
    '💸 Spent: ' + fmtEth(basket.totalSpent) + (basket.totalBudget ? '/' + basket.totalBudget : '') + ' ETH\n' +
    '🎯 Mode: ' + modeStr + '\n' +
    '🛡 SL: -' + basket.slPct + '%\n' +
    '⏰ Next: ' + nextStr,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [
          { text: basket.enabled ? '⏸ Pause' : '▶️ Enable', callback_data: 'b_en_' + sid },
          { text: '⚡ Run Now', callback_data: 'b_run_' + sid },
        ],
        [{ text: '⚙️ Settings', callback_data: 'b_set_' + sid }, { text: '🪙 Coins', callback_data: 'b_coins_' + sid }],
        [{ text: '🔍 Preview', callback_data: 'b_pre_' + sid }, { text: '🗑 Delete', callback_data: 'b_del_' + sid }],
        [{ text: '◀️ DCA', callback_data: 'dcap' }],
      ]}
    }
  );
}

// ── Basket Settings ───────────────────────────────────────────────────────────
async function sendBasketSettings(chatId, basket) {
  const sid = shortId(basket.id);
  const ethPrice = await getEthPrice();
  const usdPerCoin = (basket.ethPerCoin * ethPrice).toFixed(2);

  bot.sendMessage(chatId,
    '*⚙️ ' + basket.name + ' Settings*\n\n' +
    '💎 ETH/coin: *' + basket.ethPerCoin + ' ETH* (~$' + usdPerCoin + ')\n' +
    '⏱ Interval: *' + basket.intervalMinutes + ' min*\n' +
    '🔢 Max runs: *' + (basket.maxRuns || 'unlimited') + '*\n' +
    '💰 Budget: *' + (basket.totalBudget || 'unlimited') + ' ETH*\n' +
    '🛡 SL: *-' + basket.slPct + '%*\n' +
    '📊 Mode: *' + basket.mode + '*\n' +
    '📈 Sort by: *' + basket.lbSort + '*\n' +
    '🏦 Min mcap: *$' + num(basket.minMcap) + '*\n' +
    '👥 Min holders: *' + basket.minHolders + '*\n' +
    '🔢 Max coins: *' + basket.maxCoins + '*',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '💎 ETH/coin', callback_data: 'bs_eth_' + sid }, { text: '⏱ Interval', callback_data: 'bs_int_' + sid }],
        [{ text: '🔢 Max Runs', callback_data: 'bs_maxr_' + sid }, { text: '💰 Budget', callback_data: 'bs_bud_' + sid }],
        [{ text: '🛡 Stop-Loss', callback_data: 'bs_sl_' + sid }, { text: '📈 TP Orders', callback_data: 'bs_tp_' + sid }],
        [{ text: '📊 Mode: ' + basket.mode, callback_data: 'bs_mode_' + sid }],
        [{ text: '📈 Sort: ' + basket.lbSort, callback_data: 'bs_sort_' + sid }, { text: '🏦 Min Mcap', callback_data: 'bs_mcap_' + sid }],
        [{ text: '👥 Min Holders', callback_data: 'bs_hld_' + sid }, { text: '🔢 Max Coins', callback_data: 'bs_mc_' + sid }],
        [{ text: '✏️ Rename', callback_data: 'bs_name_' + sid }, { text: '◀️ Back', callback_data: 'b_det_' + sid }],
      ]}
    }
  );
}

// ── Basket Coins List ─────────────────────────────────────────────────────────
function sendBasketCoins(chatId, basket) {
  const sid = shortId(basket.id);
  const coins = basket.coins || [];
  const keyboard = [[{ text: '➕ Add Coin', callback_data: 'bc_add_' + sid }]];
  coins.forEach((c, i) => {
    keyboard.push([
      { text: '🪙 ' + c.name, callback_data: 'noop' },
      { text: '🗑', callback_data: 'bc_rm_' + sid + '_' + i },
    ]);
  });
  keyboard.push([{ text: '◀️ Back', callback_data: 'b_det_' + sid }]);

  bot.sendMessage(chatId,
    '*🪙 ' + basket.name + ' — Coins*\n' +
    (coins.length ? coins.map(c => '• ' + c.name + '\n  `' + c.address + '`').join('\n') : 'No coins added.') +
    '\n\n_(Used in "coins" mode only)_',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ── Wallets Panel ─────────────────────────────────────────────────────────────
async function sendWalletsPanel(chatId) {
  const ethPrice = await getEthPrice();
  const buyerBal = getBalance(BUYER_WALLET);
  const dcaBal   = getBalance(DCA_WALLET);
  const bEth  = parseFloat(buyerBal?.wallet?.[0]?.balance || '0');
  const dEth  = parseFloat(dcaBal?.wallet?.[0]?.balance   || '0');
  const bUsd  = (bEth * ethPrice).toFixed(2);
  const dUsd  = (dEth * ethPrice).toFixed(2);
  const total = ((bEth + dEth) * ethPrice).toFixed(2);
  const bAddr = getWalletAddress(BUYER_WALLET) || '(unknown)';
  const dAddr = getWalletAddress(DCA_WALLET)   || '(unknown)';

  // Holdings from positions
  const openPos = Object.keys(positions).filter(a => !positions[a].fullyExited);
  const holdStr = openPos.length ? openPos.length + ' active position(s)' : 'No open positions';

  bot.sendMessage(chatId,
    '*💰 Wallets*\n\nTotal: ~*$' + total + '*\n\n' +
    '🔵 *Listening Wallet*\n`' + bAddr.slice(0,8) + '...' + bAddr.slice(-4) + '`\n' + fmtEth(bEth) + ' ETH  (~$' + bUsd + ')\n\n' +
    '🟣 *DCA Wallet*\n`' + dAddr.slice(0,8) + '...' + dAddr.slice(-4) + '`\n' + fmtEth(dEth) + ' ETH  (~$' + dUsd + ')\n\n' +
    '📊 Holdings: ' + holdStr,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🔵 Listening Wallet', callback_data: 'w_det_0' }, { text: '🟣 DCA Wallet', callback_data: 'w_det_1' }],
        [{ text: '◀️ Home', callback_data: 'home' }],
      ]}
    }
  );
}

// ── Wallet Detail ─────────────────────────────────────────────────────────────
async function sendWalletDetail(chatId, walletIdx) {
  const ethPrice = await getEthPrice();
  const walletPath = walletIdx === 0 ? BUYER_WALLET : DCA_WALLET;
  const label = walletIdx === 0 ? '🔵 Listening Wallet' : '🟣 DCA Wallet';
  const otherLabel = walletIdx === 0 ? 'DCA' : 'Listening';
  const bal = getBalance(walletPath);
  const eth = parseFloat(bal?.wallet?.[0]?.balance || '0');
  const usd = (eth * ethPrice).toFixed(2);
  const addr = getWalletAddress(walletPath) || '(unknown)';

  bot.sendMessage(chatId,
    '*' + label + '*\n\n' +
    '`' + addr + '`\n\n' +
    'Balance: *' + fmtEth(eth) + ' ETH*  (~$' + usd + ')',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [
          { text: '↔️ Transfer to ' + otherLabel, callback_data: 'wtr_' + walletIdx },
          { text: '💸 Cash Out', callback_data: 'wco_' + walletIdx },
        ],
        [{ text: '◀️ Wallets', callback_data: 'wallets' }],
      ]}
    }
  );
}

// ── Positions Panel ───────────────────────────────────────────────────────────
async function sendPositionsPanel(chatId) {
  const allAddrs = Object.keys(positions);
  if (!allAddrs.length) {
    bot.sendMessage(chatId, '📊 No positions yet.', {
      reply_markup: { inline_keyboard: [[{ text: '◀️ Home', callback_data: 'home' }]] }
    });
    return;
  }

  const openAddrs = allAddrs.filter(a => !positions[a].fullyExited);
  const exitedAddrs = allAddrs.filter(a => positions[a].fullyExited);

  // Fetch prices for open positions
  const priceMap = {};
  for (const addr of openAddrs) {
    try { priceMap[addr] = await fetchPrice(addr); } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  const ethPrice = await getEthPrice();

  // Group by source
  const groups = {}; // groupKey -> [addr, ...]
  for (const addr of [...openAddrs, ...exitedAddrs]) {
    const src = positions[addr].source || 'watcher';
    const key = (src === 'watcher' || src === 'growth') ? '__watcher__' : src;
    if (!groups[key]) groups[key] = [];
    groups[key].push(addr);
  }

  const keyboard = [];

  // Watcher section
  if (groups['__watcher__']) {
    keyboard.push([{ text: '👂 Watcher buys', callback_data: 'noop' }]);
    for (const addr of groups['__watcher__']) {
      keyboard.push([buildPositionRow(addr, priceMap[addr])]);
    }
  }

  // Basket sections
  for (const bid of Object.keys(groups).filter(k => k !== '__watcher__')) {
    const basket = (state.dca.baskets || []).find(b => b.id === bid);
    const bName = basket ? basket.name : bid;
    const sid = basket ? shortId(basket.id) : bid.slice(0, 8);
    keyboard.push([{ text: '📈 ' + bName, callback_data: 'b_det_' + sid }]);
    for (const addr of groups[bid]) {
      keyboard.push([buildPositionRow(addr, priceMap[addr])]);
    }
  }

  keyboard.push([{ text: '🔄 Refresh', callback_data: 'posp' }, { text: '◀️ Home', callback_data: 'home' }]);

  bot.sendMessage(chatId,
    '*📊 Positions*  (' + openAddrs.length + ' open, ' + exitedAddrs.length + ' closed)',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

function buildPositionRow(addr, coin) {
  const pos = positions[addr];
  const ref = pos.avgBuyPrice || pos.buyPriceUsd;
  const exited = pos.fullyExited;
  let label = (exited ? '⚪' : '❓') + ' ' + (pos.coinName || addr.slice(0, 8));
  if (coin?.priceUsd && ref) {
    const chg = ((coin.priceUsd - ref) / ref * 100);
    label = (exited ? '⚪' : chg >= 0 ? '🟢' : '🔴') + ' ' + pos.coinName + '  ' + (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%';
  }
  return { text: label, callback_data: 'pd_' + addrKey(addr) };
}

// ── Coin Detail ───────────────────────────────────────────────────────────────
async function sendCoinDetail(chatId, address) {
  address = address.toLowerCase();
  const pos = positions[address];
  if (!pos) { bot.sendMessage(chatId, '❌ Position not found.'); return; }
  addrKey(address);
  const k = addrKey(address);

  const [coin, dexRes] = await Promise.all([
    fetchPrice(address).catch(() => null),
    dexRL('https://api.dexscreener.com/latest/dex/tokens/' + address).catch(() => null),
  ]);
  const dex = (dexRes?.pairs || []).filter(p => p.chainId === 'base')
    .reduce((best, p) => (!best || (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0)) ? p : best, null);

  const ref = pos.avgBuyPrice || pos.buyPriceUsd;
  const activeTps = getEffectiveTps(pos);
  ensureTpHits(pos);
  const ethSpent = parseFloat(pos.ethSpent || 0);
  const status = pos.fullyExited ? '⚪ EXITED' : '🟢 OPEN';
  const openOrders = activeTps.filter((_, i) => !pos.tpHits[i]).length;
  const srcBasket = pos.source?.startsWith('b_') ? (state.dca.baskets || []).find(b => b.id === pos.source) : null;
  const slPct = srcBasket ? srcBasket.slPct : state.stopLossPct;

  // ETH price estimate
  let ethPrice = await getEthPrice();
  if (dex?.priceUsd && dex?.priceNative && parseFloat(dex.priceNative) > 0) {
    ethPrice = parseFloat(dex.priceUsd) / parseFloat(dex.priceNative);
  }

  // P&L
  let pnlLine = '';
  if (coin?.priceUsd && ref && ethSpent > 0) {
    const chgPct = ((coin.priceUsd - ref) / ref * 100);
    const curValEth = ethSpent * (coin.priceUsd / ref);
    const pnlEth = curValEth - ethSpent;
    const pnlUsd = pnlEth * ethPrice;
    const sign = chgPct >= 0 ? '+' : '';
    const em = chgPct >= 0 ? '🟢' : '🔴';
    pnlLine = em + ' *' + sign + chgPct.toFixed(2) + '%*  ' + sign + fmtEth(pnlEth) + ' ETH  (~' + sign + '$' + pnlUsd.toFixed(2) + ')\n';
  }

  const mcap   = dex?.marketCap    ? '$' + num(dex.marketCap) + (dex.priceChange?.h24 != null ? '  *' + fmtChg(dex.priceChange.h24) + '*' : '') : '?';
  const liq    = dex?.liquidity?.usd ? '$' + num(dex.liquidity.usd) : '?';
  const vol24  = dex?.volume?.h24   ? '$' + num(dex.volume.h24) : '?';
  const buys   = dex?.txns?.h24?.buys ?? '?';
  const sells  = dex?.txns?.h24?.sells ?? '?';
  const tpDetail = activeTps.map((t, i) => (pos.tpHits[i] ? '✅' : '⬜') + '+' + t.pct + '%').join('  ');
  const srcLabel = srcBasket ? '📈 ' + srcBasket.name : '👂 Watcher';

  const msg =
    '*' + (pos.coinName || address.slice(0,10)).toUpperCase() + '*  ' + status + '  [' + srcLabel + ']\n\n' +
    pnlLine +
    'Cost: *' + fmtEth(ethSpent) + ' ETH*\n\n' +
    'Mcap: ' + mcap + '\n' +
    'Liq: ' + liq + '  Vol: ' + vol24 + '\n' +
    buys + '🟢 ' + sells + '🔴 (24h)\n\n' +
    'TPs: ' + tpDetail + '  SL: -' + slPct + '%';

  bot.sendMessage(chatId, msg, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🟢 +0.001', callback_data: 'pb_001_' + k }, { text: '🟢 +0.005', callback_data: 'pb_005_' + k }, { text: '🟢 +X ETH', callback_data: 'pb_x_' + k }],
      [{ text: '🔴 25%', callback_data: 'ps_25_' + k }, { text: '🔴 50%', callback_data: 'ps_50_' + k }, { text: '🔴 100%', callback_data: 'ps_100_' + k }, { text: '🔴 X%', callback_data: 'ps_x_' + k }],
      [{ text: '💸 Sell to Breakeven', callback_data: 'ps_bkv_' + k }],
      [{ text: '🔔 TPs (' + openOrders + ' active)', callback_data: 'ptpm_' + k }, { text: '🔄 Refresh', callback_data: 'pd_' + k }],
      [{ text: '◀️ Positions', callback_data: 'posp' }],
    ]}
  });
}

// ── Global TP Manager ─────────────────────────────────────────────────────────
function sendGlobalTpManager(chatId) {
  const orders = state.tpOrders;
  const keyboard = [];
  for (let i = 0; i < orders.length; i++) {
    const t = orders[i];
    keyboard.push([
      { text: '🟢 TP' + (i+1), callback_data: 'noop' },
      { text: '🎯 +' + t.pct + '%', callback_data: 'gtp_trg_' + i },
      { text: '💰 ' + t.sellPct + '%', callback_data: 'gtp_sel_' + i },
      { text: '🗑', callback_data: 'gtp_del_' + i },
    ]);
  }
  keyboard.push([{ text: '➕ Add TP', callback_data: 'gtp_add' }, { text: '◀️ Listener', callback_data: 'listener' }]);

  bot.sendMessage(chatId,
    '*📈 Global TP Orders*\n\nApply to all coins unless overridden per-coin.\nTap 🎯 to edit trigger, 💰 to edit sell %.',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ── Per-coin TP Manager ───────────────────────────────────────────────────────
function sendCoinTpManager(chatId, address) {
  const pos = positions[address];
  if (!pos) { bot.sendMessage(chatId, '❌ Position not found.'); return; }
  const k = addrKey(address);
  const orders = pos.customTpOrders || state.tpOrders;
  const isCustom = !!pos.customTpOrders;
  const keyboard = [];

  for (let i = 0; i < orders.length; i++) {
    const t = orders[i];
    keyboard.push([
      { text: (pos.tpHits?.[i] ? '✅' : '⬜') + ' TP' + (i+1), callback_data: 'noop' },
      { text: '🎯 +' + t.pct + '%', callback_data: 'ctp_trg_' + k + '_' + i },
      { text: '💰 ' + t.sellPct + '%', callback_data: 'ctp_sel_' + k + '_' + i },
      { text: '🗑', callback_data: 'ctp_del_' + k + '_' + i },
    ]);
  }
  keyboard.push([
    { text: '➕ Add TP', callback_data: 'ctp_add_' + k },
    isCustom ? { text: '🔄 Reset to Global', callback_data: 'ctp_rst_' + k } : { text: 'ℹ️ Using Global', callback_data: 'noop' },
  ]);
  keyboard.push([{ text: '◀️ Back', callback_data: 'pd_' + k }]);

  bot.sendMessage(chatId,
    '*' + pos.coinName + ' TPs*\n' + (isCustom ? '🟡 Custom override active' : '🔵 Using global TPs') + '\n\nTap 🎯 trigger or 💰 sell % to edit.',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ── TP picker helpers (button-based, no text input) ───────────────────────────
function tpTriggerPicker(callback_prefix) {
  const pcts = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500];
  const rows = [];
  for (let i = 0; i < pcts.length; i += 4) {
    rows.push(pcts.slice(i, i+4).map(p => ({ text: '+' + p + '%', callback_data: callback_prefix + p })));
  }
  return rows;
}
function tpSellPicker(callback_prefix) {
  const pcts = [10, 20, 25, 33, 50, 67, 75, 100];
  const rows = [];
  for (let i = 0; i < pcts.length; i += 4) {
    rows.push(pcts.slice(i, i+4).map(p => ({ text: p + '%', callback_data: callback_prefix + p })));
  }
  return rows;
}

// ── Settings Panel ────────────────────────────────────────────────────────────
async function sendSettingsPanel(chatId) {
  const amtLine = await buyAmountLine();
  bot.sendMessage(chatId,
    '*⚙️ Settings*\n\n' +
    '🤖 Bot name: *' + (state.botName || 'SelectaBot') + '*\n' +
    '💰 Default buy: *' + amtLine + '*\n' +
    '🔄 Amount mode: *' + state.buyAmountMode.toUpperCase() + '*\n' +
    '🛡 Global SL: *-' + state.stopLossPct + '%*\n' +
    '👁 Price watcher: *' + (state.watcherPriceCheckEnabled ? 'ON' : 'OFF') + '*',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✏️ /setname', callback_data: 'set_name' }],
        [{ text: '💰 Buy Amount', callback_data: 'set_amount' }, { text: state.buyAmountMode === 'eth' ? '💵 Switch to USD' : '🔷 Switch to ETH', callback_data: 'set_mode_toggle' }],
        [{ text: '🛡 Global SL', callback_data: 'set_sl' }],
        [{ text: state.watcherPriceCheckEnabled ? '🙈 Pause Price Watcher' : '👁 Resume Price Watcher', callback_data: 'set_watcher_toggle' }],
        [{ text: '◀️ Home', callback_data: 'home' }],
      ]}
    }
  );
}

// ── Message handler ────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const isAdmin = msg.from?.id === ADMIN_ID;
  const text    = msg.text || msg.caption || '';

  // Group message: extract zora addresses and buy
  if (isGroup) {
    if (!state.watcherEnabled) return;
    const addrs = extractAddresses(text);
    for (const addr of addrs) {
      await handleGroupBuy(addr, msg.chat.title, msg.from?.username || msg.from?.first_name || 'unknown');
    }
    return;
  }

  // Private: only admin
  if (msg.chat.type !== 'private') return;
  if (!isAdmin) { bot.sendMessage(chatId, '⛔ Unauthorized.'); return; }

  // Active wizard
  const sess = sessions[chatId];
  if (sess && !text.startsWith('/')) {
    await handleWizardInput(chatId, text, sess);
    return;
  }
  if (sess && text.startsWith('/')) delete sessions[chatId];

  // /setname command
  if (text.startsWith('/setname ')) {
    const name = text.replace('/setname ', '').trim();
    if (name.length > 0 && name.length <= 32) {
      state.botName = name;
      saveState(state);
      bot.sendMessage(chatId, '✅ Bot name set to *' + name + '*', { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, '❌ Name must be 1-32 chars.');
    }
    return;
  }

  // Raw address -> scan
  const rawAddr = text.trim().match(/^(0x[a-fA-F0-9]{40})$/);
  if (rawAddr) { await scanToken(chatId, rawAddr[1]); return; }

  // Commands
  if (text === '/start' || text === '/home' || text === '/menu') { await sendMainMenu(chatId); }
  else if (text === '/positions') { await sendPositionsPanel(chatId); }
  else if (text === '/wallets' || text === '/balance') { await sendWalletsPanel(chatId); }
  else if (text === '/cancel') { delete sessions[chatId]; bot.sendMessage(chatId, '✅ Cancelled.'); await sendMainMenu(chatId); }
  else { await sendMainMenu(chatId); }
});

// ── Wizard input handler ───────────────────────────────────────────────────────
async function handleWizardInput(chatId, text, sess) {
  const val = text.trim();

  // ── New basket wizard ──
  if (sess.type === 'basket_new') {
    if (sess.step === 'name') {
      if (!val || val.length > 32) { bot.sendMessage(chatId, '❌ Name must be 1-32 chars:'); return; }
      sess.data.name = val;
      sess.step = 'mode';
      bot.sendMessage(chatId, '📊 *Select mode for "' + val + '"*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '📈 Leaderboard', callback_data: 'bnw_mode_leaderboard' }],
          [{ text: '🪙 Specific Coins', callback_data: 'bnw_mode_coins' }],
        ]}
      });
    }
    return;
  }

  // ── Basket field edits (text input) ──
  if (sess.type === 'basket_field') {
    const basket = findBasketByShort(sess.basketSid);
    if (!basket) { bot.sendMessage(chatId, '❌ Basket not found.'); delete sessions[chatId]; return; }
    const field = sess.field;
    const v = parseFloat(val);

    if (field === 'name') {
      if (!val || val.length > 32) { bot.sendMessage(chatId, '❌ Name 1-32 chars:'); return; }
      basket.name = val;
    } else if (field === 'eth') {
      if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter valid ETH:'); return; }
      basket.ethPerCoin = v;
    } else if (field === 'budget') {
      if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter valid ETH:'); return; }
      basket.totalBudget = v;
    } else if (field === 'maxruns') {
      const n = parseInt(val);
      if (isNaN(n) || n < 1) { bot.sendMessage(chatId, '❌ Enter valid number:'); return; }
      basket.maxRuns = n;
    } else if (field === 'sl') {
      if (isNaN(v) || v <= 0 || v > 100) { bot.sendMessage(chatId, '❌ Enter 1-100:'); return; }
      basket.slPct = v;
    } else if (field === 'mcap') {
      if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter valid number:'); return; }
      basket.minMcap = v;
    } else if (field === 'holders') {
      const n = parseInt(val);
      if (isNaN(n) || n < 1) { bot.sendMessage(chatId, '❌ Enter valid number:'); return; }
      basket.minHolders = n;
    } else if (field === 'maxcoins') {
      const n = parseInt(val);
      if (isNaN(n) || n < 1 || n > 50) { bot.sendMessage(chatId, '❌ Enter 1-50:'); return; }
      basket.maxCoins = n;
    } else if (field === 'coin_add') {
      const addr = val.match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase();
      if (!addr) { bot.sendMessage(chatId, '❌ Invalid address:'); return; }
      const coin = await fetchPrice(addr);
      const name = coin?.name || addr.slice(0, 10) + '...';
      basket.coins = basket.coins || [];
      basket.coins.push({ address: addr, name });
      addrKey(addr);
      bot.sendMessage(chatId, '✅ Added *' + name + '* to basket.', { parse_mode: 'Markdown' });
      saveState(state);
      delete sessions[chatId];
      sendBasketCoins(chatId, basket);
      return;
    }

    saveState(state);
    delete sessions[chatId];
    bot.sendMessage(chatId, '✅ Updated *' + basket.name + '*', { parse_mode: 'Markdown' });
    await sendBasketSettings(chatId, basket);
    return;
  }

  // ── Listener buy amount (custom ETH) ──
  if (sess.type === 'listener_amount') {
    let v;
    if (state.buyAmountMode === 'usd') {
      const usd = parseFloat(val);
      if (isNaN(usd) || usd <= 0) { bot.sendMessage(chatId, '❌ Enter valid USD amount:'); return; }
      const ep = await getEthPrice();
      v = usd / ep;
    } else {
      v = parseFloat(val);
      if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter valid ETH amount:'); return; }
    }
    state.ethAmount = parseFloat(v.toFixed(6));
    saveState(state);
    delete sessions[chatId];
    bot.sendMessage(chatId, '✅ Buy amount set to ' + state.ethAmount + ' ETH');
    await sendListenerPanel(chatId);
    return;
  }

  // ── Global SL (custom %) ──
  if (sess.type === 'global_sl') {
    const v = parseFloat(val);
    if (isNaN(v) || v <= 0 || v > 100) { bot.sendMessage(chatId, '❌ Enter 1-100:'); return; }
    state.stopLossPct = v;
    saveState(state);
    delete sessions[chatId];
    await sendListenerPanel(chatId);
    return;
  }

  // ── Wallet transfer amount ──
  if (sess.type === 'wallet_transfer') {
    if (sess.step === 'amount') {
      const v = parseFloat(val);
      if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter valid ETH:'); return; }
      sess.data.amount = v;
      sess.step = 'confirm';
      const fromLabel = sess.data.fromIdx === 0 ? 'Listening' : 'DCA';
      const toLabel = sess.data.fromIdx === 0 ? 'DCA' : 'Listening';
      bot.sendMessage(chatId,
        '💸 *Transfer Confirmation*\n\nSend *' + v + ' ETH* from ' + fromLabel + ' → ' + toLabel + '\n\nAre you sure?',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '✅ Confirm', callback_data: 'wtr_confirm_' + sess.data.fromIdx },
          { text: '❌ Cancel', callback_data: 'wallets' },
        ]]}}
      );
      return;
    }
  }

  // ── Wallet cash out ──
  if (sess.type === 'wallet_cashout') {
    if (sess.step === 'address') {
      const addr = val.match(/^(0x[a-fA-F0-9]{40})$/)?.[0];
      if (!addr) { bot.sendMessage(chatId, '❌ Invalid address. Enter a valid 0x address:'); return; }
      sess.data.toAddr = addr;
      sess.step = 'amount';
      bot.sendMessage(chatId, '💸 Enter ETH amount to send:');
      return;
    }
    if (sess.step === 'amount') {
      const v = parseFloat(val);
      if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter valid ETH:'); return; }
      sess.data.amount = v;
      sess.step = 'confirm';
      bot.sendMessage(chatId,
        '💸 *Cash Out Confirmation*\n\nSend *' + v + ' ETH* to:\n`' + sess.data.toAddr + '`\n\nAre you sure?',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '✅ Confirm', callback_data: 'wco_confirm_' + sess.data.walletIdx },
          { text: '❌ Cancel', callback_data: 'wallets' },
        ]]}}
      );
      return;
    }
  }

  // ── Buy more (manual amount) ──
  if (sess.type === 'buy_more') {
    const v = parseFloat(val);
    if (isNaN(v) || v <= 0) { bot.sendMessage(chatId, '❌ Enter valid ETH:'); return; }
    const addr = sess.data.address;
    const pos = positions[addr];
    delete sessions[chatId];
    const wallet = posWallet(pos);
    const r = executeBuy(addr, v, wallet);
    if (r.success) {
      pos.ethSpent = (pos.ethSpent || 0) + v;
      savePositions(positions);
      const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
      bot.sendMessage(chatId, '✅ Bought *' + v + ' ETH* of *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
      await sendCoinDetail(chatId, addr);
    } else {
      bot.sendMessage(chatId, '❌ Buy failed: `' + r.error + '`', { parse_mode: 'Markdown' });
    }
    return;
  }

  // ── Manual sell % ──
  if (sess.type === 'manual_sell') {
    const pct = Math.min(100, Math.max(1, Math.round(parseFloat(val))));
    if (isNaN(pct)) { bot.sendMessage(chatId, '❌ Enter 1-100:'); return; }
    const addr = sess.data.address;
    const pos = positions[addr];
    delete sessions[chatId];
    const wallet = posWallet(pos);
    const r = executeSell(addr, pct, wallet);
    if (r.success) {
      if (pct === 100) pos.fullyExited = true;
      savePositions(positions);
      const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
      bot.sendMessage(chatId, '✅ Sold *' + pct + '%* of *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
      await sendCoinDetail(chatId, addr);
    } else {
      bot.sendMessage(chatId, '❌ Sell failed: `' + r.error + '`', { parse_mode: 'Markdown' });
    }
    return;
  }

  // ── Rename bot ──
  if (sess.type === 'set_name') {
    if (!val || val.length > 32) { bot.sendMessage(chatId, '❌ Name 1-32 chars:'); return; }
    state.botName = val;
    saveState(state);
    delete sessions[chatId];
    bot.sendMessage(chatId, '✅ Bot renamed to *' + val + '*', { parse_mode: 'Markdown' });
    await sendSettingsPanel(chatId);
    return;
  }
}

// ── Callback handler ───────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data   = query.data || '';
  const chatId = query.message.chat.id;

  if (userId !== ADMIN_ID) { bot.answerCallbackQuery(query.id, { text: '⛔ Unauthorized' }); return; }
  bot.answerCallbackQuery(query.id).catch(() => {});

  // ── Navigation ──
  if (data === 'home')     { await sendMainMenu(chatId); return; }
  if (data === 'listener') { await sendListenerPanel(chatId); return; }
  if (data === 'dcap')     { sendDcaPanel(chatId); return; }
  if (data === 'wallets')  { await sendWalletsPanel(chatId); return; }
  if (data === 'posp')     { await sendPositionsPanel(chatId); return; }
  if (data === 'setp')     { await sendSettingsPanel(chatId); return; }
  if (data === 'noop')     { return; }
  if (data === 'tp_global') { sendGlobalTpManager(chatId); return; }

  // ── Listener toggles ──
  if (data === 'w_toggle')        { state.watcherEnabled = !state.watcherEnabled; saveState(state); await sendListenerPanel(chatId); return; }
  if (data === 'w_mode')          { state.autoMode = !state.autoMode; saveState(state); await sendListenerPanel(chatId); return; }
  if (data === 'set_watcher_toggle') { state.watcherPriceCheckEnabled = !state.watcherPriceCheckEnabled; saveState(state); await sendSettingsPanel(chatId); return; }
  if (data === 'set_mode_toggle') { state.buyAmountMode = state.buyAmountMode === 'eth' ? 'usd' : 'eth'; saveState(state); await sendSettingsPanel(chatId); return; }

  if (data === 'w_amount' || data === 'set_amount') {
    const ep = await getEthPrice();
    const mode = state.buyAmountMode;
    let presets;
    if (mode === 'usd') {
      const toEth = (u) => (u / ep).toFixed(5);
      presets = [
        [1, 2, 5, 10].map(u => ({ text: '$' + u, callback_data: 'wa_usd_' + u })),
        [20, 50, 100].map(u => ({ text: '$' + u, callback_data: 'wa_usd_' + u }))
          .concat([{ text: '✏️ Custom', callback_data: 'wa_custom' }]),
      ];
    } else {
      presets = [
        ['0.001','0.002','0.005','0.01'].map(v => ({ text: v + ' ETH (~$' + (parseFloat(v)*ep).toFixed(0) + ')', callback_data: 'wa_eth_' + v })),
        ['0.02','0.05','0.1'].map(v => ({ text: v + ' ETH', callback_data: 'wa_eth_' + v }))
          .concat([{ text: '✏️ Custom', callback_data: 'wa_custom' }]),
      ];
    }
    bot.sendMessage(chatId, '💰 *Set Buy Amount* (mode: ' + mode.toUpperCase() + ')\nCurrent: ' + state.ethAmount + ' ETH', {
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: presets }
    });
    return;
  }
  if (data.startsWith('wa_eth_')) {
    const v = parseFloat(data.replace('wa_eth_', ''));
    if (!isNaN(v)) { state.ethAmount = v; saveState(state); }
    await sendListenerPanel(chatId);
    return;
  }
  if (data.startsWith('wa_usd_')) {
    const usd = parseFloat(data.replace('wa_usd_', ''));
    const ep = await getEthPrice();
    state.ethAmount = parseFloat((usd / ep).toFixed(6));
    saveState(state);
    await sendListenerPanel(chatId);
    return;
  }
  if (data === 'wa_custom') {
    sessions[chatId] = { type: 'listener_amount', createdAt: Date.now() };
    const mode = state.buyAmountMode;
    bot.sendMessage(chatId, '✏️ Enter custom ' + (mode === 'usd' ? 'USD' : 'ETH') + ' amount:');
    return;
  }

  if (data === 'w_sl') {
    bot.sendMessage(chatId, '📉 *Stop-Loss* (current: -' + state.stopLossPct + '%)', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [5,10,15,20].map(v => ({ text: '-' + v + '%', callback_data: 'wsl_' + v })),
        [25,30,40,50].map(v => ({ text: '-' + v + '%', callback_data: 'wsl_' + v })),
      ]}
    });
    return;
  }
  if (data.startsWith('wsl_')) { state.stopLossPct = parseInt(data.slice(4)); saveState(state); await sendListenerPanel(chatId); return; }

  if (data === 'set_sl') {
    bot.sendMessage(chatId, '🛡 *Global Stop-Loss* (current: -' + state.stopLossPct + '%)', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [5,10,15,20].map(v => ({ text: '-' + v + '%', callback_data: 'ssl_' + v })),
        [25,30,40,50].map(v => ({ text: '-' + v + '%', callback_data: 'ssl_' + v })),
        [{ text: '✏️ Custom', callback_data: 'ssl_custom' }],
      ]}
    });
    return;
  }
  if (data.startsWith('ssl_')) {
    const v = data.slice(4);
    if (v === 'custom') { sessions[chatId] = { type: 'global_sl', createdAt: Date.now() }; bot.sendMessage(chatId, 'Enter SL %:'); }
    else { state.stopLossPct = parseInt(v); saveState(state); await sendSettingsPanel(chatId); }
    return;
  }

  if (data === 'set_name') {
    sessions[chatId] = { type: 'set_name', createdAt: Date.now() };
    bot.sendMessage(chatId, '✏️ Enter new bot name (max 32 chars):');
    return;
  }

  // ── DCA / Basket ──
  if (data === 'b_new') {
    sessions[chatId] = { type: 'basket_new', step: 'name', data: {}, createdAt: Date.now() };
    bot.sendMessage(chatId, '🆕 *New Basket*\n\nEnter a name:', { parse_mode: 'Markdown' });
    return;
  }

  // New basket wizard: mode selection
  if (data.startsWith('bnw_mode_')) {
    const sess = sessions[chatId];
    if (!sess || sess.type !== 'basket_new') { bot.sendMessage(chatId, '⚠️ Session expired. Start again.'); return; }
    sess.data.mode = data.replace('bnw_mode_', '');
    sess.step = 'interval';
    bot.sendMessage(chatId, '⏱ *Interval between runs:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '30 min', callback_data: 'bnw_int_30' }, { text: '1 hour', callback_data: 'bnw_int_60' }, { text: '4 hours', callback_data: 'bnw_int_240' }],
        [{ text: '6 hours', callback_data: 'bnw_int_360' }, { text: '12 hours', callback_data: 'bnw_int_720' }],
        [{ text: '24 hours', callback_data: 'bnw_int_1440' }, { text: '1 week', callback_data: 'bnw_int_10080' }],
      ]}
    });
    return;
  }

  if (data.startsWith('bnw_int_')) {
    const sess = sessions[chatId];
    if (!sess || sess.type !== 'basket_new') return;
    sess.data.intervalMinutes = parseInt(data.replace('bnw_int_', ''));
    sess.step = 'eth';
    const ep = await getEthPrice();
    bot.sendMessage(chatId, '💎 *ETH per coin per run:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [0.001, 0.002, 0.005].map(v => ({ text: v + ' ETH (~$' + (v*ep).toFixed(0) + ')', callback_data: 'bnw_eth_' + v })),
        [0.01, 0.02, 0.05].map(v => ({ text: v + ' ETH (~$' + (v*ep).toFixed(0) + ')', callback_data: 'bnw_eth_' + v })),
      ]}
    });
    return;
  }

  if (data.startsWith('bnw_eth_')) {
    const sess = sessions[chatId];
    if (!sess || sess.type !== 'basket_new') return;
    sess.data.ethPerCoin = parseFloat(data.replace('bnw_eth_', ''));
    sess.step = 'budget';
    bot.sendMessage(chatId, '💰 *Total budget (optional):*\nTotal ETH cap for this basket:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [0.01, 0.05, 0.1, 0.5].map(v => ({ text: v + ' ETH', callback_data: 'bnw_bud_' + v })),
        [{ text: '1 ETH', callback_data: 'bnw_bud_1' }, { text: '⏭ No Limit', callback_data: 'bnw_bud_none' }],
      ]}
    });
    return;
  }

  if (data.startsWith('bnw_bud_')) {
    const sess = sessions[chatId];
    if (!sess || sess.type !== 'basket_new') return;
    const v = data.replace('bnw_bud_', '');
    sess.data.totalBudget = v === 'none' ? null : parseFloat(v);
    // Create basket
    const basket = {
      id: genId(),
      name: sess.data.name,
      enabled: false,
      intervalMinutes: sess.data.intervalMinutes,
      ethPerCoin: sess.data.ethPerCoin,
      totalBudget: sess.data.totalBudget,
      totalSpent: 0,
      maxRuns: null,
      runsCompleted: 0,
      nextRunAt: null,
      lastRunAt: null,
      mode: sess.data.mode,
      minMcap: 100000,
      minHolders: 1000,
      maxCoins: 5,
      coinType: 'all',
      lbSort: 'mcap',
      coins: [],
      tpOrders: [...state.tpOrders],
      slPct: 15,
    };
    state.dca.baskets = state.dca.baskets || [];
    state.dca.baskets.push(basket);
    saveState(state);
    delete sessions[chatId];
    bot.sendMessage(chatId, '✅ Basket *' + basket.name + '* created!\n\nConfigure settings and enable when ready.', { parse_mode: 'Markdown' });
    sendBasketDetail(chatId, basket);
    return;
  }

  // Basket detail / settings
  if (data.startsWith('b_det_')) {
    const sid = data.replace('b_det_', '');
    const basket = findBasketByShort(sid);
    if (!basket) { bot.sendMessage(chatId, '❌ Basket not found.'); return; }
    sendBasketDetail(chatId, basket);
    return;
  }
  if (data.startsWith('b_en_')) {
    const basket = findBasketByShort(data.replace('b_en_', ''));
    if (!basket) return;
    basket.enabled = !basket.enabled;
    if (basket.enabled && !basket.nextRunAt) basket.nextRunAt = Date.now() + basket.intervalMinutes * 60000;
    saveState(state);
    sendBasketDetail(chatId, basket);
    return;
  }
  if (data.startsWith('b_run_')) {
    const basket = findBasketByShort(data.replace('b_run_', ''));
    if (!basket) return;
    bot.sendMessage(chatId, '⚡ Running basket *' + basket.name + '*...', { parse_mode: 'Markdown' });
    await runBasket(basket);
    return;
  }
  if (data.startsWith('b_set_')) {
    const basket = findBasketByShort(data.replace('b_set_', ''));
    if (!basket) return;
    await sendBasketSettings(chatId, basket);
    return;
  }
  if (data.startsWith('b_coins_')) {
    const basket = findBasketByShort(data.replace('b_coins_', ''));
    if (!basket) return;
    sendBasketCoins(chatId, basket);
    return;
  }
  if (data.startsWith('b_pre_')) {
    const basket = findBasketByShort(data.replace('b_pre_', ''));
    if (!basket) return;
    bot.sendMessage(chatId, '🔍 Fetching leaderboard preview...');
    const coins = await getLeaderboard(basket);
    if (!coins.length) { bot.sendMessage(chatId, '⚠️ No coins match the filter.'); return; }
    const lines = coins.map((c, i) => (i+1) + '. *' + (c.name||c.address) + '*  $' + num(c.marketCap||0) + '  ' + (c.uniqueHolders||'?') + ' holders');
    bot.sendMessage(chatId, '*' + basket.name + ' Preview*\n\n' + lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }
  if (data.startsWith('b_del_')) {
    const sid = data.replace('b_del_', '');
    const basket = findBasketByShort(sid);
    if (!basket) return;
    bot.sendMessage(chatId, '🗑 *Delete "' + basket.name + '"?*\nThis cannot be undone.', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Delete', callback_data: 'b_del_confirm_' + sid },
        { text: '❌ Cancel', callback_data: 'b_det_' + sid },
      ]]}
    });
    return;
  }
  if (data.startsWith('b_del_confirm_')) {
    const sid = data.replace('b_del_confirm_', '');
    const idx = state.dca.baskets.findIndex(b => b.id.startsWith(sid));
    if (idx >= 0) { const name = state.dca.baskets[idx].name; state.dca.baskets.splice(idx, 1); saveState(state); bot.sendMessage(chatId, '🗑 Deleted *' + name + '*', { parse_mode: 'Markdown' }); }
    sendDcaPanel(chatId);
    return;
  }

  // Basket settings field pickers
  if (data.startsWith('bs_eth_')) {
    const sid = data.replace('bs_eth_', '');
    const basket = findBasketByShort(sid);
    if (!basket) return;
    const ep = await getEthPrice();
    bot.sendMessage(chatId, '💎 *ETH per coin* (current: ' + basket.ethPerCoin + ')', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [0.001, 0.002, 0.005].map(v => ({ text: v + ' ETH (~$' + (v*ep).toFixed(0) + ')', callback_data: 'bsv_eth_' + sid + '_' + v })),
        [0.01, 0.02, 0.05].map(v => ({ text: v + ' ETH', callback_data: 'bsv_eth_' + sid + '_' + v }))
          .concat([{ text: '✏️ Custom', callback_data: 'bsf_eth_' + sid }]),
      ]}
    });
    return;
  }
  if (data.startsWith('bsv_eth_')) {
    const parts = data.replace('bsv_eth_', '').split('_');
    const v = parseFloat(parts.pop()); const sid = parts.join('_');
    const basket = findBasketByShort(sid);
    if (!basket || isNaN(v)) return;
    basket.ethPerCoin = v; saveState(state);
    await sendBasketSettings(chatId, basket);
    return;
  }
  if (data.startsWith('bsf_eth_')) {
    const sid = data.replace('bsf_eth_', '');
    sessions[chatId] = { type: 'basket_field', field: 'eth', basketSid: sid, createdAt: Date.now() };
    bot.sendMessage(chatId, '✏️ Enter ETH per coin:');
    return;
  }
  if (data.startsWith('bs_int_')) {
    const sid = data.replace('bs_int_', '');
    bot.sendMessage(chatId, '⏱ *Select interval:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '30 min', callback_data: 'bsv_int_' + sid + '_30' }, { text: '1h', callback_data: 'bsv_int_' + sid + '_60' }, { text: '4h', callback_data: 'bsv_int_' + sid + '_240' }],
        [{ text: '6h', callback_data: 'bsv_int_' + sid + '_360' }, { text: '12h', callback_data: 'bsv_int_' + sid + '_720' }],
        [{ text: '24h', callback_data: 'bsv_int_' + sid + '_1440' }, { text: '1 week', callback_data: 'bsv_int_' + sid + '_10080' }],
      ]}
    });
    return;
  }
  if (data.startsWith('bsv_int_')) {
    const parts = data.replace('bsv_int_', '').split('_');
    const v = parseInt(parts.pop()); const sid = parts.join('_');
    const basket = findBasketByShort(sid);
    if (!basket || isNaN(v)) return;
    basket.intervalMinutes = v; saveState(state);
    await sendBasketSettings(chatId, basket);
    return;
  }
  if (data.startsWith('bs_maxr_')) {
    const sid = data.replace('bs_maxr_', '');
    sessions[chatId] = { type: 'basket_field', field: 'maxruns', basketSid: sid, createdAt: Date.now() };
    bot.sendMessage(chatId, '🔢 Enter max runs (or type 0 for unlimited):');
    return;
  }
  if (data.startsWith('bs_bud_')) {
    const sid = data.replace('bs_bud_', '');
    sessions[chatId] = { type: 'basket_field', field: 'budget', basketSid: sid, createdAt: Date.now() };
    bot.sendMessage(chatId, '💰 Enter total ETH budget:');
    return;
  }
  if (data.startsWith('bs_sl_')) {
    const sid = data.replace('bs_sl_', '');
    bot.sendMessage(chatId, '🛡 *Basket Stop-Loss:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [5,10,15,20].map(v => ({ text: '-' + v + '%', callback_data: 'bsv_sl_' + sid + '_' + v })),
        [25,30,40,50].map(v => ({ text: '-' + v + '%', callback_data: 'bsv_sl_' + sid + '_' + v })),
        [{ text: '✏️ Custom', callback_data: 'bsf_sl_' + sid }],
      ]}
    });
    return;
  }
  if (data.startsWith('bsv_sl_')) {
    const parts = data.replace('bsv_sl_', '').split('_');
    const v = parseInt(parts.pop()); const sid = parts.join('_');
    const basket = findBasketByShort(sid);
    if (!basket || isNaN(v)) return;
    basket.slPct = v; saveState(state);
    await sendBasketSettings(chatId, basket);
    return;
  }
  if (data.startsWith('bsf_sl_')) {
    const sid = data.replace('bsf_sl_', '');
    sessions[chatId] = { type: 'basket_field', field: 'sl', basketSid: sid, createdAt: Date.now() };
    bot.sendMessage(chatId, '✏️ Enter SL % (e.g. 15):');
    return;
  }
  if (data.startsWith('bs_mode_')) {
    const sid = data.replace('bs_mode_', '');
    const basket = findBasketByShort(sid);
    if (!basket) return;
    basket.mode = basket.mode === 'leaderboard' ? 'coins' : 'leaderboard';
    saveState(state);
    await sendBasketSettings(chatId, basket);
    return;
  }
  if (data.startsWith('bs_sort_')) {
    const sid = data.replace('bs_sort_', '');
    const basket = findBasketByShort(sid);
    if (!basket) return;
    const sorts = ['mcap', 'volume', 'holders'];
    basket.lbSort = sorts[(sorts.indexOf(basket.lbSort) + 1) % sorts.length];
    saveState(state);
    await sendBasketSettings(chatId, basket);
    return;
  }
  if (data.startsWith('bs_mcap_')) {
    const sid = data.replace('bs_mcap_', '');
    bot.sendMessage(chatId, '🏦 *Min Mcap:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [10000, 50000, 100000, 500000].map(v => ({ text: '$' + num(v), callback_data: 'bsv_mcap_' + sid + '_' + v })),
        [{ text: '✏️ Custom', callback_data: 'bsf_mcap_' + sid }],
      ]}
    });
    return;
  }
  if (data.startsWith('bsv_mcap_')) {
    const parts = data.replace('bsv_mcap_', '').split('_');
    const v = parseInt(parts.pop()); const sid = parts.join('_');
    const basket = findBasketByShort(sid);
    if (!basket || isNaN(v)) return;
    basket.minMcap = v; saveState(state);
    await sendBasketSettings(chatId, basket);
    return;
  }
  if (data.startsWith('bsf_mcap_')) {
    const sid = data.replace('bsf_mcap_', '');
    sessions[chatId] = { type: 'basket_field', field: 'mcap', basketSid: sid, createdAt: Date.now() };
    bot.sendMessage(chatId, '✏️ Enter min mcap in USD (e.g. 100000):');
    return;
  }
  if (data.startsWith('bs_hld_')) {
    const sid = data.replace('bs_hld_', '');
    bot.sendMessage(chatId, '👥 *Min Holders:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [100, 500, 1000, 5000].map(v => ({ text: v, callback_data: 'bsv_hld_' + sid + '_' + v })),
      ]}
    });
    return;
  }
  if (data.startsWith('bsv_hld_')) {
    const parts = data.replace('bsv_hld_', '').split('_');
    const v = parseInt(parts.pop()); const sid = parts.join('_');
    const basket = findBasketByShort(sid);
    if (!basket || isNaN(v)) return;
    basket.minHolders = v; saveState(state);
    await sendBasketSettings(chatId, basket);
    return;
  }
  if (data.startsWith('bs_mc_')) {
    const sid = data.replace('bs_mc_', '');
    bot.sendMessage(chatId, '🔢 *Max coins per run:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [1,2,3,5,8,10].map(v => ({ text: v, callback_data: 'bsv_mc_' + sid + '_' + v })),
      ]}
    });
    return;
  }
  if (data.startsWith('bsv_mc_')) {
    const parts = data.replace('bsv_mc_', '').split('_');
    const v = parseInt(parts.pop()); const sid = parts.join('_');
    const basket = findBasketByShort(sid);
    if (!basket || isNaN(v)) return;
    basket.maxCoins = v; saveState(state);
    await sendBasketSettings(chatId, basket);
    return;
  }
  if (data.startsWith('bs_name_')) {
    const sid = data.replace('bs_name_', '');
    sessions[chatId] = { type: 'basket_field', field: 'name', basketSid: sid, createdAt: Date.now() };
    bot.sendMessage(chatId, '✏️ Enter new basket name:');
    return;
  }
  if (data.startsWith('bs_tp_')) {
    const sid = data.replace('bs_tp_', '');
    const basket = findBasketByShort(sid);
    if (!basket) return;
    // Show basket TP manager
    const keyboard = [];
    for (let i = 0; i < basket.tpOrders.length; i++) {
      const t = basket.tpOrders[i];
      keyboard.push([
        { text: 'TP' + (i+1), callback_data: 'noop' },
        { text: '🎯 +' + t.pct + '%', callback_data: 'btp_trg_' + sid + '_' + i },
        { text: '💰 ' + t.sellPct + '%', callback_data: 'btp_sel_' + sid + '_' + i },
        { text: '🗑', callback_data: 'btp_del_' + sid + '_' + i },      ]);
    }
    keyboard.push([
      { text: '➕ Add TP', callback_data: 'btp_add_' + sid },
      { text: '◀️ Back', callback_data: 'b_set_' + sid },
    ]);
    bot.sendMessage(chatId,
      '*' + basket.name + ' — TP Orders*\n\nTap 🎯 trigger or 💰 sell % to edit.',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
    return;
  }

  // Basket TP edits (button-based trigger picker -> sell picker)
  if (data.startsWith('btp_add_')) {
    const sid = data.replace('btp_add_', '');
    sessions[chatId] = { type: 'btp_pick', step: 'trg', basketSid: sid, idx: -1, createdAt: Date.now() };
    const rows = tpTriggerPicker('btp_trg_v_' + sid + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'bs_tp_' + sid }]);
    bot.sendMessage(chatId, '➕ *Add TP — Trigger %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('btp_trg_v_')) {
    // btp_trg_v_{sid}_{pct} — from picker
    const rest = data.replace('btp_trg_v_', '');
    const lastU = rest.lastIndexOf('_');
    const sid = rest.slice(0, lastU); const pct = parseInt(rest.slice(lastU+1));
    const sess = sessions[chatId];
    if (!sess) return;
    sess.data = sess.data || {};
    sess.data.pct = pct;
    sess.step = 'sel';
    const rows = tpSellPicker('btp_sel_v_' + sid + '_' + sess.idx + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'bs_tp_' + sid }]);
    bot.sendMessage(chatId, '➕ *TP +' + pct + '% — Sell %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('btp_sel_v_')) {
    const rest = data.replace('btp_sel_v_', '');
    const parts = rest.split('_');
    const sellPct = parseInt(parts.pop());
    const idx_str = parts.pop(); const idx = parseInt(idx_str);
    const sid = parts.join('_');
    const basket = findBasketByShort(sid);
    if (!basket) return;
    const sess = sessions[chatId];
    const pct = sess?.data?.pct;
    if (!pct) return;
    if (idx === -1) {
      basket.tpOrders.push({ pct, sellPct });
    } else {
      basket.tpOrders[idx] = { pct, sellPct };
    }
    basket.tpOrders.sort((a, b) => a.pct - b.pct);
    saveState(state); delete sessions[chatId];
    bot.sendMessage(chatId, '✅ TP saved: +' + pct + '% → sell ' + sellPct + '%');
    // re-show basket TP panel
    bot.emit('callback_query', { ...query, data: 'bs_tp_' + sid });
    return;
  }
  if (data.startsWith('btp_trg_')) {
    // btp_trg_{sid}_{i} — edit trigger for existing TP
    const rest = data.replace('btp_trg_', '');
    const lastU = rest.lastIndexOf('_');
    const sid = rest.slice(0, lastU); const i = parseInt(rest.slice(lastU+1));
    const basket = findBasketByShort(sid);
    if (!basket) return;
    sessions[chatId] = { type: 'btp_pick', step: 'trg', basketSid: sid, idx: i, data: {}, createdAt: Date.now() };
    const rows = tpTriggerPicker('btp_trg_v_' + sid + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'bs_tp_' + sid }]);
    bot.sendMessage(chatId, '✏️ *TP' + (i+1) + ' — New trigger %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('btp_sel_')) {
    // btp_sel_{sid}_{i} — edit sell % for existing TP
    const rest = data.replace('btp_sel_', '');
    const lastU = rest.lastIndexOf('_');
    const sid = rest.slice(0, lastU); const i = parseInt(rest.slice(lastU+1));
    const basket = findBasketByShort(sid);
    if (!basket) return;
    const pct = basket.tpOrders[i]?.pct;
    sessions[chatId] = { type: 'btp_pick', step: 'sel', basketSid: sid, idx: i, data: { pct }, createdAt: Date.now() };
    const rows = tpSellPicker('btp_sel_v_' + sid + '_' + i + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'bs_tp_' + sid }]);
    bot.sendMessage(chatId, '✏️ *TP' + (i+1) + ' +' + pct + '% — Sell %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('btp_del_')) {
    const rest = data.replace('btp_del_', '');
    const lastU = rest.lastIndexOf('_');
    const sid = rest.slice(0, lastU); const i = parseInt(rest.slice(lastU+1));
    const basket = findBasketByShort(sid);
    if (!basket) return;
    basket.tpOrders.splice(i, 1); saveState(state);
    bot.emit('callback_query', { ...query, data: 'bs_tp_' + sid });
    return;
  }

  // Basket coin management
  if (data.startsWith('bc_add_')) {
    const sid = data.replace('bc_add_', '');
    sessions[chatId] = { type: 'basket_field', field: 'coin_add', basketSid: sid, createdAt: Date.now() };
    bot.sendMessage(chatId, '🪙 Paste coin address to add:');
    return;
  }
  if (data.startsWith('bc_rm_')) {
    const rest = data.replace('bc_rm_', '');
    const lastU = rest.lastIndexOf('_');
    const sid = rest.slice(0, lastU); const i = parseInt(rest.slice(lastU+1));
    const basket = findBasketByShort(sid);
    if (!basket) return;
    basket.coins.splice(i, 1); saveState(state);
    sendBasketCoins(chatId, basket);
    return;
  }

  // ── Global TP edits (button-based) ──
  if (data === 'gtp_add') {
    sessions[chatId] = { type: 'gtp_pick', step: 'trg', idx: -1, createdAt: Date.now() };
    const rows = tpTriggerPicker('gtp_trg_v_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'tp_global' }]);
    bot.sendMessage(chatId, '➕ *Add Global TP — Trigger %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('gtp_trg_v_')) {
    const pct = parseInt(data.replace('gtp_trg_v_', ''));
    const sess = sessions[chatId];
    if (!sess) return;
    sess.data = { pct }; sess.step = 'sel';
    const rows = tpSellPicker('gtp_sel_v_' + sess.idx + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'tp_global' }]);
    bot.sendMessage(chatId, '➕ *+' + pct + '% — Sell %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('gtp_sel_v_')) {
    const rest = data.replace('gtp_sel_v_', '');
    const parts = rest.split('_');
    const sellPct = parseInt(parts.pop()); const idx = parseInt(parts.pop());
    const sess = sessions[chatId]; if (!sess) return;
    const pct = sess.data?.pct; if (!pct) return;
    if (idx === -1) state.tpOrders.push({ pct, sellPct });
    else state.tpOrders[idx] = { pct, sellPct };
    state.tpOrders.sort((a,b) => a.pct - b.pct);
    saveState(state); delete sessions[chatId];
    sendGlobalTpManager(chatId);
    return;
  }
  if (data.startsWith('gtp_trg_')) {
    const i = parseInt(data.replace('gtp_trg_', ''));
    sessions[chatId] = { type: 'gtp_pick', step: 'trg', idx: i, data: {}, createdAt: Date.now() };
    const rows = tpTriggerPicker('gtp_trg_v_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'tp_global' }]);
    bot.sendMessage(chatId, '✏️ *TP' + (i+1) + ' — New trigger %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('gtp_sel_')) {
    const i = parseInt(data.replace('gtp_sel_', ''));
    const pct = state.tpOrders[i]?.pct;
    sessions[chatId] = { type: 'gtp_pick', step: 'sel', idx: i, data: { pct }, createdAt: Date.now() };
    const rows = tpSellPicker('gtp_sel_v_' + i + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'tp_global' }]);
    bot.sendMessage(chatId, '✏️ *TP' + (i+1) + ' +' + pct + '% — Sell %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('gtp_del_')) {
    const i = parseInt(data.replace('gtp_del_', ''));
    state.tpOrders.splice(i, 1); saveState(state); sendGlobalTpManager(chatId);
    return;
  }

  // ── Per-coin TP edits (button-based) ──
  if (data.startsWith('ptpm_')) { const addr = addrFromKey(data.replace('ptpm_', '')); sendCoinTpManager(chatId, addr); return; }

  if (data.startsWith('ctp_add_')) {
    const k = data.replace('ctp_add_', '');
    const addr = addrFromKey(k);
    sessions[chatId] = { type: 'ctp_pick', step: 'trg', addrKey: k, idx: -1, data: {}, createdAt: Date.now() };
    const rows = tpTriggerPicker('ctp_trg_v_' + k + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'ptpm_' + k }]);
    bot.sendMessage(chatId, '➕ *Add TP — Trigger %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('ctp_trg_v_')) {
    const rest = data.replace('ctp_trg_v_', '');
    const lastU = rest.lastIndexOf('_');
    const k = rest.slice(0, lastU); const pct = parseInt(rest.slice(lastU+1));
    const addr = addrFromKey(k);
    const sess = sessions[chatId]; if (!sess) return;
    sess.data.pct = pct; sess.step = 'sel';
    const rows = tpSellPicker('ctp_sel_v_' + k + '_' + sess.idx + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'ptpm_' + k }]);
    bot.sendMessage(chatId, '➕ *+' + pct + '% — Sell %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('ctp_sel_v_')) {
    const rest = data.replace('ctp_sel_v_', '');
    const parts = rest.split('_');
    const sellPct = parseInt(parts.pop()); const idx = parseInt(parts.pop());
    const k = parts.join('_');
    const addr = addrFromKey(k);
    const pos = positions[addr]; if (!pos) return;
    const sess = sessions[chatId]; if (!sess) return;
    const pct = sess.data?.pct; if (!pct) return;
    if (!pos.customTpOrders) pos.customTpOrders = JSON.parse(JSON.stringify(state.tpOrders));
    if (idx === -1) pos.customTpOrders.push({ pct, sellPct });
    else pos.customTpOrders[idx] = { pct, sellPct };
    pos.customTpOrders.sort((a,b) => a.pct - b.pct);
    pos.tpHits = new Array(pos.customTpOrders.length).fill(false);
    savePositions(positions); delete sessions[chatId];
    sendCoinTpManager(chatId, addr);
    return;
  }
  if (data.startsWith('ctp_trg_')) {
    const rest = data.replace('ctp_trg_', '');
    const lastU = rest.lastIndexOf('_');
    const k = rest.slice(0, lastU); const i = parseInt(rest.slice(lastU+1));
    const addr = addrFromKey(k);
    sessions[chatId] = { type: 'ctp_pick', step: 'trg', addrKey: k, idx: i, data: {}, createdAt: Date.now() };
    const rows = tpTriggerPicker('ctp_trg_v_' + k + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'ptpm_' + k }]);
    bot.sendMessage(chatId, '✏️ *TP' + (i+1) + ' — New trigger %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('ctp_sel_')) {
    const rest = data.replace('ctp_sel_', '');
    const lastU = rest.lastIndexOf('_');
    const k = rest.slice(0, lastU); const i = parseInt(rest.slice(lastU+1));
    const addr = addrFromKey(k);
    const pos = positions[addr]; if (!pos) return;
    const orders = pos.customTpOrders || state.tpOrders;
    const pct = orders[i]?.pct;
    sessions[chatId] = { type: 'ctp_pick', step: 'sel', addrKey: k, idx: i, data: { pct }, createdAt: Date.now() };
    const rows = tpSellPicker('ctp_sel_v_' + k + '_' + i + '_');
    rows.push([{ text: '◀️ Cancel', callback_data: 'ptpm_' + k }]);
    bot.sendMessage(chatId, '✏️ *TP' + (i+1) + ' +' + pct + '% — Sell %:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data.startsWith('ctp_del_')) {
    const rest = data.replace('ctp_del_', '');
    const lastU = rest.lastIndexOf('_');
    const k = rest.slice(0, lastU); const i = parseInt(rest.slice(lastU+1));
    const addr = addrFromKey(k);
    const pos = positions[addr]; if (!pos) return;
    if (pos.customTpOrders) { pos.customTpOrders.splice(i, 1); pos.tpHits.splice(i, 1); savePositions(positions); }
    sendCoinTpManager(chatId, addr);
    return;
  }
  if (data.startsWith('ctp_rst_')) {
    const k = data.replace('ctp_rst_', '');
    const addr = addrFromKey(k);
    const pos = positions[addr]; if (!pos) return;
    pos.customTpOrders = null;
    pos.tpHits = new Array(state.tpOrders.length).fill(false);
    savePositions(positions);
    sendCoinTpManager(chatId, addr);
    return;
  }

  // ── Position detail ──
  if (data.startsWith('pd_')) { const addr = addrFromKey(data.replace('pd_', '')); await sendCoinDetail(chatId, addr); return; }

  // ── Buy / Sell on coin detail ──
  if (data.startsWith('pb_')) {
    const parts = data.split('_'); const code = parts[1]; const k = parts.slice(2).join('_');
    const addr = addrFromKey(k); const pos = positions[addr]; if (!pos) return;
    const wallet = posWallet(pos);
    if (code === 'x') {
      sessions[chatId] = { type: 'buy_more', data: { address: addr }, createdAt: Date.now() };
      bot.sendMessage(chatId, '🟢 Enter ETH amount:');
    } else {
      const eth = code === '001' ? 0.001 : code === '005' ? 0.005 : parseFloat('0.' + code);
      const r = executeBuy(addr, eth, wallet);
      if (r.success) {
        pos.ethSpent = (pos.ethSpent || 0) + eth; savePositions(positions);
        const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
        bot.sendMessage(chatId, '✅ Bought *' + eth + ' ETH* of *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
        await sendCoinDetail(chatId, addr);
      } else { bot.sendMessage(chatId, '❌ Buy failed: `' + r.error + '`', { parse_mode: 'Markdown' }); }
    }
    return;
  }

  if (data.startsWith('ps_')) {
    const parts = data.split('_'); const code = parts[1]; const k = parts.slice(2).join('_');
    const addr = addrFromKey(k); const pos = positions[addr]; if (!pos) return;
    const wallet = posWallet(pos);

    if (code === 'x') {
      sessions[chatId] = { type: 'manual_sell', data: { address: addr }, createdAt: Date.now() };
      bot.sendMessage(chatId, '🔴 Enter sell % (1-100):');
    } else if (code === 'bkv') {
      // Sell to breakeven: sell enough to recoup original ETH
      const coin = await fetchPrice(addr);
      const ref = pos.avgBuyPrice || pos.buyPriceUsd;
      const ethSpent = parseFloat(pos.ethSpent || 0);
      if (coin?.priceUsd && ref && ethSpent > 0) {
        const mult = coin.priceUsd / ref;
        const pct = Math.min(100, Math.round(100 / mult));
        const r = executeSell(addr, pct, wallet);
        if (r.success) {
          savePositions(positions);
          const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
          bot.sendMessage(chatId, '✅ Sold *' + pct + '%* (breakeven) of *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
          await sendCoinDetail(chatId, addr);
        } else { bot.sendMessage(chatId, '❌ Sell failed: `' + r.error + '`', { parse_mode: 'Markdown' }); }
      } else { bot.sendMessage(chatId, '❌ Price data unavailable for breakeven calc.'); }
    } else {
      const pct = parseInt(code);
      const r = executeSell(addr, pct, wallet);
      if (r.success) {
        if (pct === 100) pos.fullyExited = true;
        savePositions(positions);
        const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
        bot.sendMessage(chatId, '✅ Sold *' + pct + '%* of *' + pos.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
        await sendCoinDetail(chatId, addr);
      } else { bot.sendMessage(chatId, '❌ Sell failed: `' + r.error + '`', { parse_mode: 'Markdown' }); }
    }
    return;
  }

  // ── Scanner ──
  if (data.startsWith('scan_')) { const addr = addrFromKey(data.replace('scan_', '')); await scanToken(chatId, addr); return; }
  if (data.startsWith('scanbuy_x_')) {
    const k = data.replace('scanbuy_x_', '');
    const addr = addrFromKey(k);
    const r = executeBuy(addr, state.ethAmount, BUYER_WALLET);
    if (r.success) {
      addrKey(addr);
      if (!positions[addr]) {
        positions[addr] = { coinName: addr.slice(0,8)+'...', address: addr, buyPriceUsd: null, avgBuyPrice: null, boughtAt: Date.now(), ethSpent: state.ethAmount, source: 'watcher', tpHits: new Array(state.tpOrders.length).fill(false), customTpOrders: null, fullyExited: false };
      } else { positions[addr].ethSpent = (positions[addr].ethSpent||0) + state.ethAmount; }
      savePositions(positions);
      const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
      bot.sendMessage(chatId, '✅ Bought *' + state.ethAmount + ' ETH*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
    } else { bot.sendMessage(chatId, '❌ Buy failed: `' + r.error + '`', { parse_mode: 'Markdown' }); }
    return;
  }
  if (data.startsWith('scandca_')) {
    const k = data.replace('scandca_', '');
    const addr = addrFromKey(k);
    // Add to first enabled basket, or first basket, or prompt
    const basket = (state.dca.baskets || []).find(b => b.enabled) || state.dca.baskets?.[0];
    if (!basket) { bot.sendMessage(chatId, '⚠️ No baskets yet. Create one in 📈 DCA first.'); return; }
    if (!basket.coins.find(c => c.address === addr)) {
      const coin = await fetchPrice(addr);
      const name = coin?.name || addr.slice(0,10)+'...';
      basket.coins.push({ address: addr, name });
      if (basket.mode !== 'coins') basket.mode = 'coins';
      saveState(state); addrKey(addr);
      bot.sendMessage(chatId, '✅ *' + name + '* added to basket *' + basket.name + '*\nMode set to coins.', { parse_mode: 'Markdown' });
    } else { bot.sendMessage(chatId, 'ℹ️ Already in basket.'); }
    return;
  }

  // ── Wallets ──
  if (data.startsWith('w_det_')) { await sendWalletDetail(chatId, parseInt(data.replace('w_det_', ''))); return; }

  if (data.startsWith('wtr_')) {
    if (data.startsWith('wtr_confirm_')) {
      const fromIdx = parseInt(data.replace('wtr_confirm_', ''));
      const sess = sessions[chatId];
      if (!sess || sess.type !== 'wallet_transfer') { bot.sendMessage(chatId, '⚠️ Session expired.'); return; }
      const { amount } = sess.data;
      const fromWallet = fromIdx === 0 ? BUYER_WALLET : DCA_WALLET;
      const toWalletPath = fromIdx === 0 ? DCA_WALLET : BUYER_WALLET;
      const toAddr = getWalletAddress(toWalletPath);
      if (!toAddr) { bot.sendMessage(chatId, '❌ Cannot get destination address.'); delete sessions[chatId]; return; }
      bot.sendMessage(chatId, '⏳ Sending ' + amount + ' ETH...');
      const r = executeTransfer(fromWallet, toAddr, amount);
      delete sessions[chatId];
      if (r.success) {
        const tx = r.data?.transactionHash || r.data?.txHash || 'pending';
        bot.sendMessage(chatId, '✅ Transferred *' + amount + ' ETH*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
      } else { bot.sendMessage(chatId, '❌ Transfer failed: `' + r.error + '`', { parse_mode: 'Markdown' }); }
      await sendWalletsPanel(chatId);
      return;
    }
    const fromIdx = parseInt(data.replace('wtr_', ''));
    sessions[chatId] = { type: 'wallet_transfer', step: 'amount', data: { fromIdx }, createdAt: Date.now() };
    const fromLabel = fromIdx === 0 ? 'Listening' : 'DCA';
    const toLabel   = fromIdx === 0 ? 'DCA' : 'Listening';
    const fromWalletPath = fromIdx === 0 ? BUYER_WALLET : DCA_WALLET;
    const bal = getBalance(fromWalletPath);
    const avail = parseFloat(bal?.wallet?.[0]?.balance || '0').toFixed(5);
    bot.sendMessage(chatId,
      '↔️ *Transfer* ' + fromLabel + ' → ' + toLabel + '\nAvailable: *' + avail + ' ETH*\n\nEnter amount:',
      { parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [0.001, 0.005, 0.01, 0.05].map(v => ({ text: v + ' ETH', callback_data: 'wtr_amt_' + fromIdx + '_' + v })),
          [0.1, 0.5].map(v => ({ text: v + ' ETH', callback_data: 'wtr_amt_' + fromIdx + '_' + v })),
        ]}
      }
    );
    return;
  }
  if (data.startsWith('wtr_amt_')) {
    const rest = data.replace('wtr_amt_', '');
    const parts = rest.split('_');
    const v = parseFloat(parts.pop()); const fromIdx = parseInt(parts.pop());
    sessions[chatId] = { type: 'wallet_transfer', step: 'confirm', data: { fromIdx, amount: v }, createdAt: Date.now() };
    const fromLabel = fromIdx === 0 ? 'Listening' : 'DCA';
    const toLabel   = fromIdx === 0 ? 'DCA' : 'Listening';
    bot.sendMessage(chatId,
      '💸 *Transfer Confirmation*\n\n*' + v + ' ETH*  ' + fromLabel + ' → ' + toLabel + '\n\nAre you sure?',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '✅ Confirm', callback_data: 'wtr_confirm_' + fromIdx },
        { text: '❌ Cancel', callback_data: 'wallets' },
      ]]}}
    );
    return;
  }

  if (data.startsWith('wco_')) {
    if (data.startsWith('wco_confirm_')) {
      const walletIdx = parseInt(data.replace('wco_confirm_', ''));
      const sess = sessions[chatId];
      if (!sess || sess.type !== 'wallet_cashout') { bot.sendMessage(chatId, '⚠️ Session expired.'); return; }
      const { toAddr, amount } = sess.data;
      const fromWallet = walletIdx === 0 ? BUYER_WALLET : DCA_WALLET;
      bot.sendMessage(chatId, '⏳ Sending...');
      const r = executeTransfer(fromWallet, toAddr, amount);
      delete sessions[chatId];
      if (r.success) {
        const tx = r.data?.transactionHash || r.data?.txHash || 'pending';
        bot.sendMessage(chatId, '✅ Sent *' + amount + ' ETH* to `' + toAddr + '`\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
      } else { bot.sendMessage(chatId, '❌ Send failed: `' + r.error + '`', { parse_mode: 'Markdown' }); }
      await sendWalletsPanel(chatId);
      return;
    }
    const walletIdx = parseInt(data.replace('wco_', ''));
    sessions[chatId] = { type: 'wallet_cashout', step: 'address', data: { walletIdx }, createdAt: Date.now() };
    bot.sendMessage(chatId, '💸 *Cash Out*\n\nPaste destination address:', { parse_mode: 'Markdown' });
    return;
  }

  // ── Manual pending buys ──
  if (data.startsWith('pby_')) {
    const pkey = data.replace('pby_', '');
    const pending = sessions[pkey];
    if (!pending) { bot.sendMessage(chatId, '⏰ Expired.'); return; }
    const r = executeBuy(pending.address, state.ethAmount, BUYER_WALLET);
    if (r.success) {
      addrKey(pending.address);
      positions[pending.address] = {
        coinName: pending.coinName, address: pending.address,
        buyPriceUsd: pending.buyPriceUsd, avgBuyPrice: pending.buyPriceUsd,
        boughtAt: Date.now(), ethSpent: state.ethAmount, source: 'watcher',
        tpHits: new Array(state.tpOrders.length).fill(false), customTpOrders: null, fullyExited: false,
      };
      savePositions(positions);
      const tx = r.data?.txHash || r.data?.transactionHash || 'pending';
      bot.sendMessage(chatId, '✅ Bought *' + pending.coinName + '*\nTx: `' + tx + '`', { parse_mode: 'Markdown' });
    } else { bot.sendMessage(chatId, '❌ Buy failed: `' + r.error + '`', { parse_mode: 'Markdown' }); }
    delete sessions[pkey];
    return;
  }
  if (data.startsWith('psk_')) {
    delete sessions[data.replace('psk_', '')];
    bot.sendMessage(chatId, '⏭ Skipped.');
    return;
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
log('🎵 ' + (state.botName || 'SelectaBot') + ' starting up...');
log('Positions loaded: ' + Object.keys(positions).length);
log('addrLookup: ' + Object.keys(addrLookup).length + ' entries');
log('Baskets: ' + (state.dca.baskets || []).length);

bot.getMe().then(me => {
  log('Bot: @' + me.username + ' (' + me.id + ') | Admin: ' + ADMIN_ID);
  log('Buyer wallet: ' + BUYER_WALLET);
  log('DCA wallet: ' + DCA_WALLET);
}).catch(e => { log('FATAL: ' + e.message); process.exit(1); });
