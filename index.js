require('dotenv').config();

const SITE_URL = (process.env.SITE_URL || 'https://masta.ee').replace(/\/$/, '');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const INTERVAL_SECONDS = Math.max(5, Number(process.env.INTERVAL_SECONDS) || 5);
const NOTIFY_ON_FIRST_RUN = process.env.NOTIFY_ON_FIRST_RUN === '1' || process.env.NOTIFY_ON_FIRST_RUN === 'true';
const NOTIFY_HEADER = process.env.NOTIFY_HEADER || 'masta.ee 通知';
const NOTIFY_FIRST_TITLE = process.env.NOTIFY_FIRST_TITLE || '当前库存';
const NOTIFY_SECOND_TITLE = process.env.NOTIFY_SECOND_TITLE || '';
const NOTIFY_CHANGE_TITLE = process.env.NOTIFY_CHANGE_TITLE || '检测到库存变化';
const NOTIFY_SUBTITLE = process.env.NOTIFY_SUBTITLE || '当前库存为';

const API_PRODUCTS = `${SITE_URL}/api/v1/public/products`;

/** 用于对比「是否有变化」：除可用数外含 stock_status、预占量（避免 售罄↔占用 时数字同为 0 漏报） */
let lastProductStateMap = {};

/** 取商品可用库存（-1 表示无限，由 display 层显示为「无限」） */
function getStock(p) {
  const isManual = p.fulfillment_type === 'manual';
  const n = isManual
    ? (p.manual_stock_available ?? -1)
    : (p.auto_stock_available ?? 0);
  return n;
}

/** 预占数量（待支付），用于 occupied 展示与签名 */
function getLockedCount(p) {
  const isManual = p.fulfillment_type === 'manual';
  if (isManual) {
    return Number(p.manual_stock_locked) || 0;
  }
  return Number(p.auto_stock_locked) || 0;
}

/**
 * 是否「可售为 0 且应标成占用/库存」——用「库存:」前缀，避免像普通「剩余:0」售罄。
 */
function isOnlyLockedNoAvailable(p) {
  const n = getStock(p);
  if (n === -1 || n > 0) return false;
  const locked = getLockedCount(p);
  return locked > 0 || p.stock_status === 'occupied';
}

/** 按钮前缀：全无可售且存在预占时用「库存」，否则「剩余」 */
function getStockLabelForRow(p) {
  return isOnlyLockedNoAvailable(p) ? '库存' : '剩余';
}

/** 单商品状态签名（变化检测） */
function getProductStateSignature(p) {
  const stock = getStock(p);
  const status = typeof p.stock_status === 'string' ? p.stock_status : '';
  const locked = getLockedCount(p);
  return `${stock}|${status}|${locked}`;
}

/**
 * 按钮文案里的库存描述。
 * - 可售>0 但有预占：剩余:1·预占×1（避免只看到数字减 1 不知道有人未付占着）
 * - 可售=0 有预占：占用×n（配合标签「库存:」）
 */
function getStockDisplay(p) {
  const n = getStock(p);
  const locked = getLockedCount(p);

  if (n === -1) {
    if (locked > 0) return `∞·预占×${locked}`;
    return '∞';
  }

  if (n <= 0 && (locked > 0 || p.stock_status === 'occupied')) {
    return locked > 0 ? `占用×${locked}` : '占用';
  }
  if (n > 0 && locked > 0) {
    return `${n}·预占×${locked}`;
  }
  return String(n);
}

function pickTitle(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return obj['zh-CN'] || obj['en'] || obj['zh'] || Object.values(obj)[0] || '';
}

async function fetchAllProducts() {
  const list = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const url = `${API_PRODUCTS}?page=${page}&page_size=${pageSize}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.status_code !== 0 || !Array.isArray(json.data)) throw new Error(json.msg || 'API 返回异常');
    list.push(...json.data);
    const total = json.pagination?.total ?? list.length;
    if (list.length >= total || json.data.length < pageSize) break;
    page++;
  }
  return list;
}

function buildProductRows(products) {
  return products.map((p) => {
    const title = pickTitle(p.title) || p.slug || `#${p.id}`;
    const price = p.promotion_price_amount ?? p.price_amount ?? '0';
    const priceStr = typeof price === 'string' ? price : String(price);
    const stockStr = getStockDisplay(p);
    const label = getStockLabelForRow(p);
    const text = `${title} - ¥ ${priceStr} - ${label}:${stockStr}`;
    const url = `${SITE_URL}/products/${p.slug || p.id}`;
    return [{ text, url }];
  });
}

async function sendTelegram(message, inlineKeyboard) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
    console.warn('未配置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，跳过发送');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (inlineKeyboard && inlineKeyboard.length) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  const results = await Promise.all(
    TELEGRAM_CHAT_IDS.map((chat_id) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, chat_id }),
      }).then((res) => res.json().catch(() => ({})))
    )
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(failed.map((r) => r.description || 'Unknown').join('; '));
  }
}

function hasProductStateChanged(products) {
  const current = {};
  for (const p of products) current[p.id] = getProductStateSignature(p);
  const last = lastProductStateMap;
  const lastKeys = Object.keys(last);
  const currKeys = Object.keys(current);
  if (lastKeys.length !== currKeys.length) return true;
  for (const id of currKeys) {
    if (last[id] !== current[id]) return true;
  }
  return false;
}

async function run() {
  let products;
  try {
    products = await fetchAllProducts();
  } catch (e) {
    console.error('[stock-notice] 拉取商品失败', e.message);
    return;
  }
  if (products.length === 0) {
    console.log('[stock-notice] 商品列表为空，跳过');
    return;
  }
  const currentMap = {};
  for (const p of products) currentMap[p.id] = getProductStateSignature(p);

  const isFirstRun = Object.keys(lastProductStateMap).length === 0;
  const changed = hasProductStateChanged(products);
  lastProductStateMap = currentMap;

  if (isFirstRun && !NOTIFY_ON_FIRST_RUN) {
    console.log('[stock-notice] 首次运行，已记录当前库存，下次变化时再通知（设 NOTIFY_ON_FIRST_RUN=1 可首次也发一条）');
    return;
  }
  if (!isFirstRun && !changed) {
    console.log('[stock-notice] 库存无变化，跳过发送');
    return;
  }
  try {
    const rows = buildProductRows(products);
    const title = isFirstRun ? NOTIFY_FIRST_TITLE : NOTIFY_CHANGE_TITLE;
    const parts = [
      NOTIFY_HEADER.trim() ? ` ${NOTIFY_HEADER} ` : '',
      title.trim(),
      NOTIFY_SECOND_TITLE.trim(),
      NOTIFY_SUBTITLE.trim(),
    ].filter((s) => String(s).trim() !== '');
    const message = parts.join('\n\n');
    await sendTelegram(message, rows);
    console.log('[stock-notice] 已发送', products.length, '个商品到 TG');
  } catch (e) {
    console.error('[stock-notice] 发送 TG 失败', e.message);
  }
}

async function main() {
  if (process.argv.includes('--once')) {
    await run();
    process.exit(0);
    return;
  }
  const tgOk = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS.length > 0);
  console.log('[stock-notice] 启动，间隔', INTERVAL_SECONDS, '秒，SITE_URL=', SITE_URL, '，TG 配置:', tgOk ? '已配置' : '未配置（不会发消息）');
  if (!tgOk) console.warn('[stock-notice] 请设置 TELEGRAM_BOT_TOKEN 与 TELEGRAM_CHAT_ID（频道需把 Bot 加为管理员）');
  if (tgOk && NOTIFY_ON_FIRST_RUN) console.log('[stock-notice] NOTIFY_ON_FIRST_RUN=1，首次运行会发一条当前库存');
  await run();
  setInterval(run, INTERVAL_SECONDS * 1000);
}

main().catch((e) => {
  console.error('[stock-notice]', e);
  process.exit(1);
});
