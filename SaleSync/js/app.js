// ---------- API-backed state ----------
const API_BASE = "api/index.php";
let CATS = [];
let categoryIdByName = {};
let products = [];
let sales = [];
let transactions = [];
let vouchersList = [];
let VOUCHERS = {};
let opex = {};
let totalOpex = 0;
let expenseRows = [];
let currentUser = null;
let appSettings = {
  storeName: 'SaleSync Store', storeAddress: '', storePhone: '', storeEmail: '', receiptFooter: 'Thank you for shopping!',
  currencySymbol: '₱', dateFormat: 'DD MMM YYYY', timezone: 'Asia/Manila', defaultLowStockThreshold: 10, barcodePrefix: 'SS', receiptPrefix: 'POS',
  returnWindowDays: 7, defaultReturnRestock: true, enableCash: true, enableCard: true, enableOnline: true,
  allowStoreCreditRefund: true, allowOriginalMethodRefund: true
};
const today = new Date();
const DATA_DAYS = 90;
let analyticsRangeDays = 14;
function makeDateList(count, end = today) {
  return [...Array(count)].map((_, i) => { const d = new Date(end); d.setHours(0,0,0,0); d.setDate(d.getDate() - (count - 1 - i)); return d; });
}
const days = makeDateList(DATA_DAYS);

function fmtDate(d) { return new Date(d).toISOString().slice(0, 10); }
const money = n => String(appSettings.currencySymbol || '₱') + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function formatDateTime(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value ?? '');
  const timeOptions = { hour: 'numeric', minute: '2-digit', timeZone: appSettings.timezone || 'Asia/Manila', ...options };
  delete timeOptions.year; delete timeOptions.month; delete timeOptions.day; delete timeOptions.dateStyle; delete timeOptions.timeStyle;
  return `${formatDateOnly(date)} ${new Intl.DateTimeFormat(undefined, timeOptions).format(date)}`;
}
function formatDateOnly(value) {
  const isDateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = value instanceof Date ? value : new Date(isDateOnly ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(d.getTime())) return String(value ?? '');
  const parts = new Intl.DateTimeFormat('en-PH', { day: '2-digit', month: 'short', year: 'numeric', timeZone: isDateOnly ? 'UTC' : (appSettings.timezone || 'Asia/Manila') }).formatToParts(d);
  const get = k => parts.find(p => p.type === k)?.value || '';
  if (appSettings.dateFormat === 'YYYY-MM-DD') return `${get('year')}-${get('month')}-${get('day')}`;
  if (appSettings.dateFormat === 'MM/DD/YYYY') return `${get('month')}/${get('day')}/${get('year')}`;
  if (appSettings.dateFormat === 'DD/MM/YYYY') return `${get('day')}/${get('month')}/${get('year')}`;
  return `${get('day')} ${get('month')} ${get('year')}`;
}
function normalizeSettings(s = {}) {
  const validCurrencySymbols = ['₱', '$', '€', '£', '¥'];
  const requestedCurrencySymbol = String(s.currencySymbol ?? '₱');
  const currencySymbol = validCurrencySymbols.includes(requestedCurrencySymbol) ? requestedCurrencySymbol : '₱';
  return {
    storeName: String(s.storeName ?? 'SaleSync Store'), storeAddress: String(s.storeAddress ?? ''), storePhone: String(s.storePhone ?? ''),
    storeEmail: String(s.storeEmail ?? ''), receiptFooter: String(s.receiptFooter ?? 'Thank you for shopping!'),
    currencySymbol, dateFormat: String(s.dateFormat ?? 'DD MMM YYYY'), timezone: String(s.timezone ?? 'Asia/Manila'),
    defaultLowStockThreshold: Number(s.defaultLowStockThreshold ?? 10), barcodePrefix: String(s.barcodePrefix ?? 'SS'),
    receiptPrefix: String(s.receiptPrefix ?? 'POS'), returnWindowDays: Number(s.returnWindowDays ?? 7),
    defaultReturnRestock: Boolean(s.defaultReturnRestock), enableCash: Boolean(s.enableCash), enableCard: Boolean(s.enableCard),
    enableOnline: Boolean(s.enableOnline), allowStoreCreditRefund: Boolean(s.allowStoreCreditRefund),
    allowOriginalMethodRefund: Boolean(s.allowOriginalMethodRefund)
  };
}
const escapeHtml = value => String(value ?? '').replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));

// SaleSync's shared modal feedback system for application messages and confirmations.
let appPopupResolver = null;
function ensureAppPopup() {
  let overlay = document.getElementById('appFeedbackModal');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'appFeedbackModal';
  overlay.className = 'modal-overlay app-feedback-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="modal-card app-feedback-card" role="dialog" aria-modal="true" aria-labelledby="appFeedbackTitle" aria-describedby="appFeedbackMessage">
      <div class="app-feedback-heading">
        <div class="app-feedback-symbol" id="appFeedbackSymbol" aria-hidden="true">i</div>
        <div class="app-feedback-heading-text"><div class="eyebrow" id="appFeedbackEyebrow">SALESYNC</div><h2 id="appFeedbackTitle">Notice</h2></div>
        <button type="button" class="modal-close" id="appFeedbackClose" aria-label="Close">×</button>
      </div>
      <p id="appFeedbackMessage" class="app-feedback-message"></p>
      <div class="modal-actions app-feedback-actions">
        <button class="btn secondary" type="button" id="appFeedbackCancel" hidden>Cancel</button>
        <button class="btn" type="button" id="appFeedbackOkay">Okay</button>
      </div>
    </section>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', event => { if (event.target === overlay) closeAppPopup(false); });
  document.getElementById('appFeedbackOkay').addEventListener('click', () => closeAppPopup(true));
  document.getElementById('appFeedbackCancel').addEventListener('click', () => closeAppPopup(false));
  document.getElementById('appFeedbackClose').addEventListener('click', () => closeAppPopup(false));
  document.addEventListener('keydown', event => {
    const active = document.getElementById('appFeedbackModal');
    if (event.key === 'Escape' && active && !active.hidden) closeAppPopup(false);
  });
  return overlay;
}
function setAppPopupContent(message, options = {}) {
  const tone = ['success', 'warning', 'error', 'info', 'danger'].includes(options.type) ? options.type : 'info';
  document.getElementById('appFeedbackTitle').textContent = options.title || ({success:'Completed', warning:'Please check', error:'Something went wrong', danger:'Please confirm', info:'SaleSync notice'}[tone]);
  document.getElementById('appFeedbackEyebrow').textContent = options.eyebrow || 'SALESYNC';
  document.getElementById('appFeedbackMessage').textContent = String(message ?? '');
  document.getElementById('appFeedbackSymbol').textContent = ({success:'✓', warning:'!', error:'×', danger:'!', info:'i'}[tone]);
  const card = document.querySelector('#appFeedbackModal .app-feedback-card');
  if (card) card.dataset.tone = tone;
  const okay = document.getElementById('appFeedbackOkay');
  okay.textContent = options.okText || 'Okay';
  const cancel = document.getElementById('appFeedbackCancel');
  cancel.textContent = options.cancelText || 'Cancel';
  cancel.hidden = !options.confirm;
  okay.classList.toggle('danger', !!options.danger);
}
function closeAppPopup(result = false) {
  const overlay = document.getElementById('appFeedbackModal');
  if (overlay) overlay.hidden = true;
  const resolver = appPopupResolver;
  appPopupResolver = null;
  const otherModalOpen = [...document.querySelectorAll('.modal-overlay')].some(el => el.id !== 'appFeedbackModal' && !el.hidden);
  const receiptOpen = document.getElementById('posOverlay')?.classList.contains('show');
  if (!otherModalOpen && !receiptOpen) document.body.classList.remove('modal-open');
  if (resolver) resolver(!!result);
}
function showPopup(message, options = {}) {
  const overlay = ensureAppPopup();
  if (appPopupResolver) closeAppPopup(false);
  setAppPopupContent(message, options);
  overlay.hidden = false;
  document.body.classList.add('modal-open');
  document.getElementById('appFeedbackOkay')?.focus({ preventScroll: true });
}
function showConfirmPopup(message, options = {}) {
  const overlay = ensureAppPopup();
  if (appPopupResolver) closeAppPopup(false);
  setAppPopupContent(message, { ...options, confirm: true, type: options.type || 'danger', title: options.title || 'Are you sure?', okText: options.okText || 'Confirm', cancelText: options.cancelText || 'Cancel' });
  overlay.hidden = false;
  document.body.classList.add('modal-open');
  document.getElementById('appFeedbackCancel')?.focus({ preventScroll: true });
  return new Promise(resolve => { appPopupResolver = resolve; });
}

async function api(path, options = {}) {
  const cleanPath = String(path).replace(/^\/+/, '');
  const response = await fetch(`${API_BASE}?route=${encodeURIComponent(cleanPath)}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || data.detail || `Request failed (${response.status})`);
  return data;
}

async function loadData() {
  const data = await api('/bootstrap');
  appSettings = normalizeSettings(data.settings || appSettings);
  CATS = data.categories.map(c => c.name);
  categoryIdByName = Object.fromEntries(data.categories.map(c => [c.name, c.id]));
  products = data.products;
  sales = data.sales;
  transactions = data.transactions.map(t => ({ ...t, time: new Date(t.time) }));
  vouchersList = data.vouchers || [];
  VOUCHERS = Object.fromEntries(vouchersList.map(v => [v.code, {
    id: v.id,
    type: v.type,
    value: v.value,
    pct: v.type === 'PERCENTAGE' ? v.value / 100 : 0,
    label: `${v.code} · ${v.type === 'PERCENTAGE' ? v.value + '%' : money(v.value)} (${v.description || 'Discount'})`,
    minimumPurchase: Number(v.minimumPurchase || 0)
  }]));
  opex = data.expenses || {};
  totalOpex = Object.values(opex).reduce((a, b) => a + Number(b || 0), 0);
  expenseRows = (data.expenseRows || []).map(e => ({ id: Number(e.id || 0), category: e.category, description: e.description || '', amount: Number(e.amount || 0), date: e.date }));
}

// All figures below are recomputed from database-backed data on every render.
function periodRows(rangeDays = analyticsRangeDays, end = today) {
  const endDate = new Date(end); endDate.setHours(0,0,0,0);
  const startDate = new Date(endDate); startDate.setDate(startDate.getDate() - (rangeDays - 1));
  const startKey = fmtDate(startDate);
  const endKey = fmtDate(endDate);
  return sales.filter(s => s.date >= startKey && s.date <= endKey);
}
function computeStats(rangeDays = analyticsRangeDays) {
  const selectedDays = makeDateList(rangeDays);
  const currentRows = periodRows(rangeDays, today);
  const previousEnd = new Date(today); previousEnd.setHours(0,0,0,0); previousEnd.setDate(previousEnd.getDate() - rangeDays);
  const previousRows = periodRows(rangeDays, previousEnd);
  const salesByDay = selectedDays.map(d => {
    const rows = sales.filter(s => s.date === fmtDate(d));
    const uniqueTx = new Set(rows.map(r => r.transactionId));
    return {
      date: fmtDate(d).slice(5),
      rev: +rows.reduce((a, r) => a + r.total, 0).toFixed(2),
      profit: +rows.reduce((a, r) => a + r.profit, 0).toFixed(2),
      tx: uniqueTx.size
    };
  });
  const totalRev = +currentRows.reduce((a, r) => a + r.total, 0).toFixed(2);
  const totalProfit = +currentRows.reduce((a, r) => a + r.profit, 0).toFixed(2);
  const previousRev = +previousRows.reduce((a, r) => a + r.total, 0).toFixed(2);
  const totalCOGS = +(totalRev - totalProfit).toFixed(2);
  const todayRows = sales.filter(s => s.date === fmtDate(today));
  const todayTxCount = new Set(todayRows.map(r => r.transactionId)).size;
  const netProfit = +(totalProfit - totalOpex).toFixed(2);
  const byProduct = {};
  currentRows.forEach(s => {
    const key = s.productId ?? s.name;
    byProduct[key] = byProduct[key] || { name: s.name, qty: 0, rev: 0, profit: 0 };
    byProduct[key].qty += s.qty;
    byProduct[key].rev += s.total;
    byProduct[key].profit += s.profit;
  });
  const topProducts = Object.values(byProduct).sort((a, b) => b.rev - a.rev).slice(0, 6);
  const lowStockCount = products.filter(p => p.stock <= p.reorder).length;
  const periodTxCount = new Set(currentRows.map(r => r.transactionId)).size;
  const periodUnits = currentRows.reduce((a, r) => a + r.qty, 0);
  const trend = previousRev ? ((totalRev - previousRev) / previousRev) * 100 : 0;
  return { salesByDay, totalRev, totalProfit, totalCOGS, todayRows, todayTxCount, netProfit, byProduct, topProducts, lowStockCount, currentRows, periodTxCount, periodUnits, trend, rangeDays };
}
function setAnalyticsRange(value, target = 'analytics') {
  const n = Number(value);
  if (![7, 14, 30, 60].includes(n)) return;
  analyticsRangeDays = n;
  render(target);
}
function rangeLabel(daysCount) { return `Last ${daysCount} days`; }

// ---------- Checkout (Dashboard) state ----------
let cart = [];
let voucher = null;
let payMethod = "cash";
let posQuery = "";
let posCat = "All";
let restockProductId = null;
let categoryManageRows = [];
let returnState = { transactionId: null, data: null };
let barcodeStream = null;
let barcodeAnimation = null;
let barcodeDetector = null;
let barcodeDetectorSupportsQR = false;
let barcodeScanBusy = false;
let barcodeFrameCounter = 0;
let scannerLastCode = '';
let scannerClearFrames = 0;
let scannerClearSinceAt = 0;
let scannerCooldownUntil = 0;
// Prevent a single barcode held in front of the camera from repeatedly
// increasing quantity. A new successful read is accepted no more often than
// once per 900 ms, and the same code is re-armed only after a short clear view.
const SCANNER_SCAN_COOLDOWN_MS = 900;
const SCANNER_REARM_ABSENCE_MS = 900;
const SCANNER_REARM_CLEAR_FRAMES = 10;
let scannerLastMessage = '';
let barcodeCanvas = null;
let barcodePrintProduct = null;
let barcodePrintType = 'CODE39';
let cashierReceiptQuery = '';

// Code 39 encoding is used for SaleSync-generated labels. The renderer and the
// fallback camera decoder share this table, so camera scanning also works in
// browsers that do not implement the native BarcodeDetector API.
const CODE39_BITS = {
  '0':'000110100','1':'100100001','2':'001100001','3':'101100000','4':'000110001',
  '5':'100110000','6':'001110000','7':'000100101','8':'100100100','9':'001100100',
  'A':'100001001','B':'001001001','C':'101001000','D':'000011001','E':'100011000','F':'001011000',
  'G':'000001101','H':'100001100','I':'001001100','J':'000011100','K':'100000011','L':'001000011',
  'M':'101000010','N':'000010011','O':'100010010','P':'001010010','Q':'000000111','R':'100000110',
  'S':'001000110','T':'000010110','U':'110000001','V':'011000001','W':'111000000','X':'010010001',
  'Y':'110010000','Z':'011010000','-':'010000101','.':'110000100',' ':'011000100','$':'010101000',
  '/':'010100010','+':'010001010','%':'000101010','*':'010010100'
};
const CODE39_FROM_BITS = Object.fromEntries(Object.entries(CODE39_BITS).map(([ch, bits]) => [bits, ch]));
function barcodeSupportedValue(value) { return /^[A-Z0-9 .\/$+%-]+$/i.test(String(value || '')); }
function makeBarcodeSvg(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!code || !barcodeSupportedValue(code)) throw new Error('Barcode labels support A–Z, 0–9, spaces, and - . $ / + %. Please update this barcode first.');
  const encoded = '*' + code + '*';
  const module = 2, quiet = 24, gap = 2, barTop = 5, barHeight = 58;
  let x = quiet, bars = '';
  for (let c = 0; c < encoded.length; c++) {
    const bits = CODE39_BITS[encoded[c]];
    if (!bits) throw new Error('This barcode contains a character that cannot be printed as Code 39.');
    for (let i = 0; i < bits.length; i++) {
      const w = bits[i] === '1' ? module * 3 : module;
      if (i % 2 === 0) bars += `<rect x="${x}" y="${barTop}" width="${w}" height="${barHeight}" fill="#000"/>`;
      x += w;
    }
    if (c < encoded.length - 1) x += gap;
  }
  const width = x + quiet;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Barcode ${escapeHtml(code)}" viewBox="0 0 ${width} 84" width="${width}" height="84" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>${bars}<text x="${width/2}" y="79" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#111">${escapeHtml(code)}</text></svg>`;
}
// QR Code Version 2-L (25x25 modules), Byte mode. This is enough for SaleSync product
// identifiers/barcodes up to 32 ASCII bytes and keeps label generation local/offline.
function makeQrSvg(value) {
  const code = String(value ?? '').trim();
  const bytes = Array.from(new TextEncoder().encode(code));
  if (!bytes.length) throw new Error('A QR code needs a non-empty product identifier.');
  if (bytes.length > 32 || bytes.some(b => b < 32 || b > 126)) throw new Error('QR labels support printable ASCII identifiers up to 32 characters. Shorten this product barcode or use a traditional barcode label.');
  const size = 25, dataCount = 34, eccCount = 10;
  const bits = [];
  const appendBits = (n, count) => { for (let i = count - 1; i >= 0; i--) bits.push((n >>> i) & 1); };
  appendBits(0b0100, 4); // byte mode
  appendBits(bytes.length, 8);
  bytes.forEach(b => appendBits(b, 8));
  const capacity = dataCount * 8;
  appendBits(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
    data.push(b);
  }
  for (let pad = 0; data.length < dataCount; pad++) data.push(pad % 2 === 0 ? 0xEC : 0x11);

  const gfMul = (a, b) => {
    let out = 0;
    while (b) { if (b & 1) out ^= a; a <<= 1; if (a & 0x100) a ^= 0x11D; b >>>= 1; }
    return out;
  };
  let generator = [1];
  let root = 1;
  for (let i = 0; i < eccCount; i++) {
    const next = Array(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j];
      next[j + 1] ^= gfMul(generator[j], root);
    }
    generator = next;
    root = gfMul(root, 2);
  }
  const ecc = Array(eccCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ ecc[0];
    ecc.shift(); ecc.push(0);
    for (let j = 0; j < eccCount; j++) ecc[j] ^= gfMul(generator[j + 1], factor);
  }
  const stream = [...data, ...ecc].flatMap(b => Array.from({ length: 8 }, (_, i) => (b >>> (7 - i)) & 1));

  const matrix = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    matrix[y][x] = !!dark; reserved[y][x] = true;
  };
  const finder = (left, top) => {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
      const x = left + dx, y = top + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setFunction(x, y, dark);
    }
  };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  for (let i = 8; i < size - 8; i++) {
    setFunction(i, 6, i % 2 === 0);
    setFunction(6, i, i % 2 === 0);
  }
  // Version 2 has one non-overlapping 5x5 alignment pattern, centered at (18,18).
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const ring = Math.max(Math.abs(dx), Math.abs(dy));
    setFunction(18 + dx, 18 + dy, ring !== 1);
  }
  const formatData = 0b01000; // error correction L, mask 0
  let rem = formatData << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  const format = ((formatData << 10) | (rem & 0x3FF)) ^ 0x5412;
  for (let i = 0; i <= 5; i++) setFunction(8, i, ((format >>> i) & 1) !== 0);
  setFunction(8, 7, ((format >>> 6) & 1) !== 0);
  setFunction(8, 8, ((format >>> 7) & 1) !== 0);
  setFunction(7, 8, ((format >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) setFunction(14 - i, 8, ((format >>> i) & 1) !== 0);
  for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, ((format >>> i) & 1) !== 0);
  for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, ((format >>> i) & 1) !== 0);
  setFunction(8, size - 8, true); // fixed dark module

  let bitIndex = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let offset = 0; offset < 2; offset++) {
        const x = right - offset;
        if (reserved[y][x]) continue;
        matrix[y][x] = bitIndex < stream.length ? stream[bitIndex] === 1 : false;
        bitIndex++;
      }
    }
    upward = !upward;
  }
  // Apply QR mask pattern 0 only to data modules.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!reserved[y][x] && (x + y) % 2 === 0) matrix[y][x] = !matrix[y][x];
  }
  const quiet = 4, scale = 7, view = size + quiet * 2;
  let modules = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (matrix[y][x]) modules += `<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code ${escapeHtml(code)}" viewBox="0 0 ${view} ${view}" width="${view * scale}" height="${view * scale}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${modules}</g></svg>`;
}
function selectedProductCodeSvg(value) {
  return barcodePrintType === 'QR' ? makeQrSvg(value) : makeBarcodeSvg(value);
}
function labelCodeIsPrintable(value) {
  if (barcodePrintType === 'QR') {
    const code = String(value ?? '').trim();
    return code.length > 0 && new TextEncoder().encode(code).length <= 32 && Array.from(code).every(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126);
  }
  return barcodeSupportedValue(value);
}
function decodeCode39FromVideo(video) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
  try {
    if (!barcodeCanvas) barcodeCanvas = document.createElement('canvas');
    const canvas = barcodeCanvas, ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Decode near the camera's native size so thin bars aren't lost by downscaling.
    canvas.width = Math.min(video.videoWidth, 1280);
    canvas.height = Math.max(1, Math.round(canvas.width * video.videoHeight / video.videoWidth));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const ys = [0.30,0.38,0.46,0.54,0.62,0.70].map(f => Math.round(canvas.height*f));
    for (const y of ys) {
      const px = ctx.getImageData(0, y, canvas.width, 1).data;
      const gray = new Uint8Array(canvas.width); let min = 255, max = 0;
      for (let x=0; x<canvas.width; x++) { const i=x*4; const g=Math.round(px[i]*.299+px[i+1]*.587+px[i+2]*.114); gray[x]=g; if(g<min)min=g; if(g>max)max=g; }
      if (max-min < 45) continue;
      const threshold = min + (max-min)*0.52;
      const runs=[]; let black=gray[0] < threshold, length=1;
      for(let x=1;x<gray.length;x++){ const b=gray[x] < threshold; if(b===black) length++; else { runs.push({black,length}); black=b; length=1; } }
      runs.push({black,length});
      while(runs.length && !runs[0].black) runs.shift();
      for(let start=0; start+8<runs.length; start++) {
        if(!runs[start].black) continue;
        let output='', started=false, idx=start, chars=0;
        while(idx+8<runs.length && chars++<72) {
          const group=runs.slice(idx,idx+9);
          if(group.length!==9 || group.some((r,j)=>r.black !== (j%2===0))) break;
          const total=group.reduce((a,r)=>a+r.length,0), t=total/8;
          const bits=group.map(r=>r.length>t?'1':'0').join('');
          const ch=CODE39_FROM_BITS[bits];
          if(!ch) break;
          if(ch==='*') { if(started) { if(output.length>=4) return output; break; } started=true; }
          else if(started) output+=ch; else break;
          idx += 10; // nine Code 39 elements plus the inter-character space
        }
      }
    }
  } catch (_) { /* A frame may not be readable while the camera is focusing. */ }
  return '';
}
// Local QR decoder fallback for SaleSync's generated QR labels (QR Version 2-L,
// 25x25 modules, byte mode). This lets QR scanning work in browsers without
// BarcodeDetector. Native detection still handles other supported QR versions.
function qrPatternRuns(binary, width, height, x, y, horizontal) {
  const limit = horizontal ? width : height;
  const at = (pos) => horizontal ? binary[y * width + pos] : binary[pos * width + x];
  if (x < 0 || y < 0 || x >= width || y >= height || !at(horizontal ? x : y)) return null;
  let start = horizontal ? x : y, end = start + 1;
  while (start > 0 && at(start - 1)) start--;
  while (end < limit && at(end)) end++;
  const center = end - start;
  let whiteBefore = 0, outerBefore = 0, pos = start - 1;
  while (pos >= 0 && !at(pos)) { whiteBefore++; pos--; }
  while (pos >= 0 && at(pos)) { outerBefore++; pos--; }
  let whiteAfter = 0; pos = end;
  while (pos < limit && !at(pos)) { whiteAfter++; pos++; }
  let outerAfter = 0;
  while (pos < limit && at(pos)) { outerAfter++; pos++; }
  if (!outerBefore || !whiteBefore || !whiteAfter || !outerAfter) return null;
  return [outerBefore, whiteBefore, center, whiteAfter, outerAfter];
}
function qrFinderRatio(runs) {
  if (!runs) return null;
  const unit = runs.reduce((a, b) => a + b, 0) / 7;
  if (unit < 1.35) return null;
  const expected = [1, 1, 3, 1, 1];
  for (let i = 0; i < 5; i++) if (Math.abs(runs[i] - expected[i] * unit) > Math.max(2.2, unit * 0.78)) return null;
  return unit;
}
function qrOtsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let total = gray.length, sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}
function qrFindFinderClusters(binary, width, height) {
  const clusters = [];
  const rowStep = Math.max(1, Math.floor(height / 500));
  for (let y = 0; y < height; y += rowStep) {
    // Reconstruct the row's run-length list; QR finder marks have a 1:1:3:1:1 ratio.
    const runs = []; let pos = 0, color = binary[y * width];
    for (let xx = 1; xx <= width; xx++) {
      if (xx === width || binary[y * width + xx] !== color) {
        runs.push({ black: !!color, start: pos, length: xx - pos });
        pos = xx;
        if (xx < width) color = binary[y * width + xx];
      }
    }
    for (let i = 0; i + 4 < runs.length; i++) {
      const group = runs.slice(i, i + 5);
      if (!(group[0].black && !group[1].black && group[2].black && !group[3].black && group[4].black)) continue;
      const lengths = group.map(r => r.length), unit = qrFinderRatio(lengths);
      if (!unit) continue;
      const centerX = group[2].start + group[2].length / 2;
      const xPixel = Math.max(0, Math.min(width - 1, Math.round(centerX)));
      const vertical = qrPatternRuns(binary, width, height, xPixel, y, false);
      const vUnit = qrFinderRatio(vertical);
      if (!vUnit || Math.abs(vUnit - unit) > Math.max(2, unit * 0.9)) continue;
      const pitch = (unit + vUnit) / 2;
      let cluster = clusters.find(c => Math.hypot(c.x - centerX, c.y - y) < Math.max(4, pitch * 2.8));
      if (!cluster) {
        cluster = { x: centerX, y, pitch, hits: 0, weight: 0 };
        clusters.push(cluster);
      }
      const weight = 1;
      cluster.x = (cluster.x * cluster.weight + centerX * weight) / (cluster.weight + weight);
      cluster.y = (cluster.y * cluster.weight + y * weight) / (cluster.weight + weight);
      cluster.pitch = (cluster.pitch * cluster.weight + pitch * weight) / (cluster.weight + weight);
      cluster.weight += weight; cluster.hits++;
    }
  }
  return clusters.filter(c => c.hits >= 2 && c.pitch >= 1.35).sort((a, b) => b.hits - a.hits).slice(0, 12);
}
function qrFunctionMapV2() {
  const size = 25, reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) reserved[y][x] = true; };
  const finder = (left, top) => { for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) set(left + dx, top + dy); };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  for (let i = 8; i < size - 8; i++) { set(i, 6); set(6, i); }
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(18 + dx, 18 + dy);
  for (let i = 0; i <= 5; i++) set(8, i);
  set(8, 7); set(8, 8); set(7, 8);
  for (let i = 9; i < 15; i++) set(14 - i, 8);
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8);
  for (let i = 8; i < 15; i++) set(8, size - 15 + i);
  set(8, size - 8);
  return reserved;
}
function decodeSaleSyncQrMatrix(matrix) {
  const size = 25, reserved = qrFunctionMapV2();
  // Confirm the three fixed finder patterns before interpreting random camera noise as a code.
  const finderErrors = [[0,0],[size-7,0],[0,size-7]].reduce((sum, [ox, oy]) => {
    let errors = 0;
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const expected = x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
      if (matrix[oy + y][ox + x] !== expected) errors++;
    }
    return sum + errors;
  }, 0);
  if (finderErrors > 5) return '';
  const bits = []; let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let offset = 0; offset < 2; offset++) {
        const x = right - offset;
        if (reserved[y][x]) continue;
        const masked = matrix[y][x];
        bits.push(masked !== (((x + y) % 2) === 0)); // Remove mask pattern 0.
      }
    }
    upward = !upward;
  }
  const read = (start, count) => { let n = 0; for (let i = 0; i < count; i++) n = (n << 1) | (bits[start + i] ? 1 : 0); return n; };
  if (bits.length < 12 || read(0, 4) !== 0b0100) return '';
  const length = read(4, 8);
  if (length < 1 || length > 32 || bits.length < 12 + length * 8) return '';
  let value = '';
  for (let i = 0; i < length; i++) {
    const ch = read(12 + i * 8, 8);
    if (ch < 32 || ch > 126) return '';
    value += String.fromCharCode(ch);
  }
  return value;
}
function decodeSaleSyncQrFromVideo(video) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
  try {
    if (!barcodeCanvas) barcodeCanvas = document.createElement('canvas');
    const canvas = barcodeCanvas, ctx = canvas.getContext('2d', { willReadFrequently: true });
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const gray = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) gray[j] = Math.round(rgba[i] * .299 + rgba[i + 1] * .587 + rgba[i + 2] * .114);
    const threshold = qrOtsuThreshold(gray), binary = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) binary[i] = gray[i] <= threshold ? 1 : 0;
    const finders = qrFindFinderClusters(binary, canvas.width, canvas.height);
    if (finders.length < 3) return '';
    // Use candidate triples whose finder centers form the right-angle triangle of a QR symbol.
    for (let a = 0; a < finders.length; a++) for (let b = a + 1; b < finders.length; b++) for (let c = b + 1; c < finders.length; c++) {
      const pts = [finders[a], finders[b], finders[c]];
      const ds = [
        Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        Math.hypot(pts[0].x - pts[2].x, pts[0].y - pts[2].y),
        Math.hypot(pts[1].x - pts[2].x, pts[1].y - pts[2].y)
      ];
      const long = Math.max(...ds), short1 = ds.reduce((best, d) => d < long && d > best ? d : best, 0), short2 = ds.filter(d => d < long).sort((x,y)=>x-y)[0];
      if (!short1 || !short2 || Math.abs(short1 - short2) / Math.max(short1, short2) > .35 || Math.abs(long * long - short1 * short1 - short2 * short2) / (long * long) > .28) continue;
      // The corner is the point incident to the two short sides; the others are top/right and left/bottom.
      const corner = pts.findIndex((_, i) => {
        const other = pts.filter((__, j) => j !== i);
        const d1 = Math.hypot(pts[i].x-other[0].x, pts[i].y-other[0].y), d2 = Math.hypot(pts[i].x-other[1].x, pts[i].y-other[1].y);
        const d3 = Math.hypot(other[0].x-other[1].x, other[0].y-other[1].y);
        return Math.abs(d1*d1+d2*d2-d3*d3)/(d3*d3) < .28;
      });
      if (corner < 0) continue;
      const tl = pts[corner], adjacent = pts.filter((_, i) => i !== corner);
      // Try both orientations. A payload must pass QR fixed-pattern, byte-mode, and length checks.
      for (const [tr, bl] of [[adjacent[0], adjacent[1]], [adjacent[1], adjacent[0]]]) {
        const vx = { x: (tr.x - tl.x) / 18, y: (tr.y - tl.y) / 18 };
        const vy = { x: (bl.x - tl.x) / 18, y: (bl.y - tl.y) / 18 };
        if (Math.hypot(vx.x, vx.y) < 1 || Math.hypot(vy.x, vy.y) < 1) continue;
        const size = 25;
        const matrix = Array.from({ length: size }, () => Array(size).fill(false));
        for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
          const cx = tl.x + (col - 3) * vx.x + (row - 3) * vy.x;
          const cy = tl.y + (col - 3) * vx.y + (row - 3) * vy.y;
          // Majority sampling around the estimated module center tolerates minor blur/aliasing.
          const offsets = [[0,0],[.14,.14],[-.14,.14],[.14,-.14],[-.14,-.14]];
          let black = 0;
          for (const [ox, oy] of offsets) {
            const sx = Math.round(cx + ox * vx.x + oy * vy.x), sy = Math.round(cy + ox * vx.y + oy * vy.y);
            if (sx >= 0 && sy >= 0 && sx < canvas.width && sy < canvas.height && binary[sy * canvas.width + sx]) black++;
          }
          matrix[row][col] = black >= 3;
        }
        const decoded = decodeSaleSyncQrMatrix(matrix);
        if (decoded) return decoded;
      }
    }
  } catch (_) { /* Camera frame is blurry or between exposures; retry the next frame. */ }
  return '';
}

function lowStockList() { return products.filter(p => p.stock <= p.reorder).sort((a, b) => a.stock - b.stock); }
function restockProduct(id) {
  if (currentUser?.role_name !== 'ADMIN') return;
  const p = products.find(x => x.id === id);
  if (!p) return;
  restockProductId = p.productId;
  const modal = document.getElementById('restockModal');
  const name = document.getElementById('restockProductName');
  const current = document.getElementById('restockCurrentStock');
  const qty = document.getElementById('restockQuantity');
  const reason = document.getElementById('restockReason');
  const error = document.getElementById('restockError');
  const submit = document.getElementById('restockSubmit');
  if (!modal) return;
  if (name) name.textContent = p.name;
  if (current) current.textContent = String(p.stock);
  if (qty) { qty.value = '1'; qty.focus(); qty.select(); }
  if (reason) reason.value = 'Stock replenishment';
  if (error) { error.hidden = true; error.textContent = ''; }
  if (submit) { submit.disabled = false; submit.textContent = 'Add stock'; }
  modal.hidden = false;
  document.body.classList.add('modal-open');
}
function closeRestockModal() {
  const modal = document.getElementById('restockModal');
  if (modal) modal.hidden = true;
  restockProductId = null;
  document.body.classList.remove('modal-open');
}
async function submitRestock() {
  if (currentUser?.role_name !== 'ADMIN' || restockProductId === null) return;
  const quantity = Number(document.getElementById('restockQuantity')?.value);
  const reason = document.getElementById('restockReason')?.value.trim() || 'Stock replenishment';
  const error = document.getElementById('restockError');
  const submit = document.getElementById('restockSubmit');
  if (!Number.isInteger(quantity) || quantity <= 0) {
    if (error) { error.hidden = false; error.textContent = 'Enter a positive whole number.'; }
    return;
  }
  if (submit) { submit.disabled = true; submit.textContent = 'Adding…'; }
  try {
    await api(`/inventory/${restockProductId}/restock`, { method: 'POST', body: JSON.stringify({ quantity, reason }) });
    closeRestockModal();
    await loadData();
    render('inventory');
  } catch (err) {
    if (error) { error.hidden = false; error.textContent = err.message; }
  } finally {
    if (submit && document.getElementById('restockModal')?.hidden === false) { submit.disabled = false; submit.textContent = 'Add stock'; }
  }
}

function filteredProducts() {
  const q = posQuery.trim().toLowerCase();
  return products.filter(p => (posCat === "All" || p.cat === posCat) && (
    p.name.toLowerCase().includes(q) || p.cat.toLowerCase().includes(q) ||
    String(p.productId).includes(q) || String(p.barcode || '').toLowerCase().includes(q)
  ));
}
function findProductByCode(value, allowFallback = true) {
  const code = String(value || '').trim().toLowerCase();
  if (!code) return null;
  const byBarcode = products.find(p => String(p.barcode || '').trim().toLowerCase() === code);
  if (byBarcode || !allowFallback) return byBarcode || null;
  return products.find(p => String(p.productId) === code || String(p.id) === code)
    || products.find(p => p.name.trim().toLowerCase() === code)
    || null;
}
function resolveScannedProductCode(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';

  // QR codes may contain the identifier directly, JSON, or a product lookup URL.
  // The database remains the source of product names, prices, and stock.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const candidate = parsed.barcode ?? parsed.productId ?? parsed.product_id ?? parsed.productID ?? parsed.code ?? parsed.id;
      if (candidate !== undefined && candidate !== null && String(candidate).trim()) return String(candidate).trim();
    }
  } catch (_) {}
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      for (const key of ['barcode', 'productId', 'product_id', 'productID', 'code', 'id']) {
        const value = url.searchParams.get(key);
        if (value && value.trim()) return value.trim();
      }
    }
  } catch (_) {}
  const prefixed = raw.match(/^salesync:(?:product:)?(.+)$/i);
  if (prefixed && prefixed[1].trim()) return prefixed[1].trim();
  return raw;
}
function lookupAndAddProduct(value, fromScanner = false, barcodeOnly = false) {
  const code = resolveScannedProductCode(value);
  if (!code) return false;
  const exactProduct = findProductByCode(code, !barcodeOnly);
  const matchingProducts = (!fromScanner && !barcodeOnly) ? filteredProducts() : [];
  const product = exactProduct || (matchingProducts.length === 1 ? matchingProducts[0] : null);
  if (!product) {
    if (!fromScanner) showPopup(`No product matches barcode or Product ID "${code}". You can still use the product search below.`, { title: 'Product not found', type: 'warning' });
    return false;
  }
  if (product.stock <= 0) {
    if (!fromScanner) showPopup(`${product.name} is out of stock.`, { title: 'Out of stock', type: 'warning' });
    return false;
  }
  const line = cart.find(item => item.id === product.id);
  if (line && line.qty >= product.stock) {
    if (!fromScanner) showPopup(`Only ${product.stock} unit(s) of ${product.name} are available.`, { title: 'Insufficient stock', type: 'warning' });
    return false;
  }
  addToCart(product.id);
  posQuery = '';
  const input = document.getElementById('posSearchInput');
  if (input) { input.value = ''; input.focus(); }
  const grid = document.getElementById('posGrid');
  if (grid) grid.innerHTML = posItemsHTML(filteredProducts());
  return true;
}
function setScannerMessage(text, kind = '') {
  const message = document.getElementById('scannerMessage');
  if (message) { message.textContent = text; message.className = `scanner-message${kind ? ' ' + kind : ''}`; }
}
function focusScannerInput(clear = false) {
  const input = document.getElementById('scannerManualCode');
  if (input) { if (clear) input.value = ''; input.focus({ preventScroll: true }); }
}
function setCheckoutScanMode(active) {
  const browse = document.getElementById('posBrowseMode');
  const scan = document.getElementById('posScanMode');
  if (!browse || !scan) return;
  browse.hidden = !!active;
  scan.hidden = !active;
  document.body.classList.toggle('checkout-scan-mode', !!active);
  if (!active) stopBarcodeCamera();
  else setTimeout(() => focusScannerInput(), 50);
}
function submitScannerManual() {
  const input = document.getElementById('scannerManualCode');
  const value = input?.value || '';
  if (lookupAndAddProduct(value, true, false)) {
    if (input) input.value = '';
    setScannerMessage(`Added product for code “${resolveScannedProductCode(value)}”. Scan or enter the next item.`, 'success');
    refreshCartPanel();
    setTimeout(() => focusScannerInput(), 0);
  } else {
    setScannerMessage('No matching product. Check the code or register the barcode in Product Management.', 'error');
    if (input) { input.select(); input.focus(); }
  }
}
async function openBarcodeScanner() {
  // Scan Mode takes over only the left product panel. The Current Sale cart on
  // the right stays visible and updates as each code is accepted.
  setCheckoutScanMode(true);
  const message = document.getElementById('scannerMessage');
  const video = document.getElementById('barcodeVideo');
  if (message) { message.textContent = 'Requesting camera permission… You can also type a code below.'; message.className = 'scanner-message'; }
  const manual = document.getElementById('scannerManualCode'); if (manual) manual.value = '';
  stopBarcodeCamera();
  if (!window.isSecureContext) {
    setScannerMessage('The browser blocks camera access here. Open SaleSync through http://localhost/SaleSync/login.html or HTTPS. Manual entry still works.', 'error');
    focusScannerInput(); return;
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    setScannerMessage('This browser does not expose camera access on this page. Use localhost or HTTPS, allow camera access, or type the code manually.', 'error');
    focusScannerInput(); return;
  }
  try {
    try {
      barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (firstError) {
      // Desktop webcams and some browsers reject the environment-facing hint.
      barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    }
    if (!document.getElementById('posScanMode') || document.getElementById('posScanMode').hidden) { stopBarcodeCamera(); return; }
    if (video) { video.hidden = false; video.srcObject = barcodeStream; video.setAttribute('playsinline', ''); video.muted = true; await video.play(); }
    const cameraPlaceholder = document.getElementById('scannerPlaceholder'); if (cameraPlaceholder) cameraPlaceholder.hidden = true;
    try {
      if ('BarcodeDetector' in window) {
        const formatsToTry = ['qr_code', 'code_39', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'code_93', 'data_matrix', 'pdf417', 'aztec'];
        let supported = [];
        if (typeof BarcodeDetector.getSupportedFormats === 'function') {
          try {
            const browserFormats = await BarcodeDetector.getSupportedFormats();
            supported = formatsToTry.filter(format => browserFormats.includes(format));
            barcodeDetectorSupportsQR = browserFormats.includes('qr_code');
          } catch (_) { supported = []; barcodeDetectorSupportsQR = false; }
        }
        barcodeDetector = supported.length ? new BarcodeDetector({ formats: supported }) : new BarcodeDetector();
      }
    } catch (_) { barcodeDetector = null; barcodeDetectorSupportsQR = false; }
    setScannerMessage(barcodeDetectorSupportsQR
      ? 'Camera ready. Scan QR codes or supported barcodes. After each scan, leave Scan Mode open for the next item.'
      : barcodeDetector
        ? 'Camera ready. Native QR support is not confirmed. SaleSync QR labels and Code 39 labels also use local fallback decoding.'
        : 'Camera ready. Local fallback supports SaleSync-generated QR labels and Code 39 barcodes. Manual entry is available for other codes.');
    scannerLastCode = ''; scannerClearFrames = 0;
    scanBarcodeFrame();
  } catch (err) {
    stopBarcodeCamera();
    let hint = 'Could not start the camera. Check that no other app is using it and allow camera access in browser site settings.';
    if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') hint = 'Camera permission is blocked. Open Site settings → Camera → Allow, reload SaleSync, and try again.';
    else if (err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError') hint = 'No camera was found. Connect a webcam or enter codes manually.';
    else if (err?.name === 'NotReadableError' || err?.name === 'TrackStartError') hint = 'The camera is busy or unavailable. Close other camera apps and try again.';
    else if (err?.name === 'OverconstrainedError') hint = 'The requested camera mode is unavailable. Try another camera or use manual entry.';
    setScannerMessage(hint, 'error'); focusScannerInput();
  }
}
async function scanBarcodeFrame() {
  const video = document.getElementById('barcodeVideo');
  if (!barcodeStream || barcodeScanBusy || document.getElementById('posScanMode')?.hidden) {
    if (barcodeStream && !document.getElementById('posScanMode')?.hidden) barcodeAnimation = requestAnimationFrame(scanBarcodeFrame);
    return;
  }
  barcodeScanBusy = true;
  let detectionAttempted = false;
  try {
    if (video && video.readyState >= 2) {
      let code = '';
      barcodeFrameCounter++;
      if (barcodeDetector) {
        detectionAttempted = true;
        try {
          const codes = await barcodeDetector.detect(video);
          if (codes?.length) code = String(codes[0].rawValue || '').trim();
        } catch (_) { /* use local fallbacks */ }
      }
      if (!code && barcodeFrameCounter % 3 === 0) { detectionAttempted = true; code = decodeSaleSyncQrFromVideo(video); }
      if (!code && barcodeFrameCounter % 2 === 0) { detectionAttempted = true; code = decodeCode39FromVideo(video); }
      if (code) {
        scannerClearFrames = 0;
        scannerClearSinceAt = 0;
        // If another label enters the camera while cooling down, leave it
        // detectable; the same frame loop will add it after the pause expires.
        const now = Date.now();
        if (code !== scannerLastCode && now >= scannerCooldownUntil) {
          scannerLastCode = code;
          if (lookupAndAddProduct(code, true, false)) {
            scannerCooldownUntil = Date.now() + SCANNER_SCAN_COOLDOWN_MS;
            const product = findProductByCode(resolveScannedProductCode(code), true);
            setScannerMessage(`Added ${product?.name || 'product'} · Ready for the next scan. Move the code away, then present the next label.`, 'success');
            refreshCartPanel();
            focusScannerInput(true);
          } else {
            setScannerMessage(`Read “${code}”, but no active product matches it. Use the exact product barcode/ID or type a code manually.`, 'error');
            const input = document.getElementById('scannerManualCode'); if (input) input.value = code;
          }
        }
      } else if (detectionAttempted && scannerLastCode) {
        scannerClearFrames++;
        if (!scannerClearSinceAt) scannerClearSinceAt = Date.now();
        // Require a sustained clear view (not one or two blurry frames) before
        // allowing the same product label to be scanned again.
        if (scannerClearFrames >= SCANNER_REARM_CLEAR_FRAMES && Date.now() - scannerClearSinceAt >= SCANNER_REARM_ABSENCE_MS) {
          scannerLastCode = '';
          scannerClearFrames = 0;
          scannerClearSinceAt = 0;
        }
      }
    }
  } catch (_) { /* manual entry remains available */ }
  finally { barcodeScanBusy = false; }
  if (barcodeStream && !document.getElementById('posScanMode')?.hidden) barcodeAnimation = requestAnimationFrame(scanBarcodeFrame);
}
function stopBarcodeCamera() {
  if (barcodeAnimation) cancelAnimationFrame(barcodeAnimation);
  barcodeAnimation = null;
  if (barcodeStream) barcodeStream.getTracks().forEach(track => track.stop());
  barcodeStream = null; barcodeDetector = null; barcodeDetectorSupportsQR = false; barcodeScanBusy = false; barcodeFrameCounter = 0;
  scannerLastCode = ''; scannerClearFrames = 0; scannerClearSinceAt = 0; scannerCooldownUntil = 0;
  const video = document.getElementById('barcodeVideo');
  if (video) { try { video.pause(); } catch (_) {} video.srcObject = null; video.hidden = true; }
  const cameraPlaceholder = document.getElementById('scannerPlaceholder'); if (cameraPlaceholder) cameraPlaceholder.hidden = false;
}
function closeBarcodeScanner() {
  stopBarcodeCamera();
  const scan = document.getElementById('posScanMode');
  const browse = document.getElementById('posBrowseMode');
  if (scan) scan.hidden = true;
  if (browse) browse.hidden = false;
  document.body.classList.remove('checkout-scan-mode');
  const search = document.getElementById('posSearchInput');
  if (search) search.focus({ preventScroll: true });
}

// ---------- Barcode label generation and printing (admin only) ----------
async function openBarcodePrint(productId) {
  if (currentUser?.role_name !== 'ADMIN') return;
  const error = document.getElementById('barcodePrintError');
  const modal = document.getElementById('barcodePrintModal');
  if (!modal) return;
  if (error) { error.hidden = true; error.textContent = ''; }
  try {
    let product = products.find(p => Number(p.productId) === Number(productId));
    if (!product) throw new Error('Product not found. Refresh Product Management and try again.');
    if (!String(product.barcode || '').trim()) {
      const result = await api(`/products/${productId}/barcode`, { method: 'POST', body: JSON.stringify({}) });
      await loadData();
      product = products.find(p => Number(p.productId) === Number(productId)) || { ...product, barcode: result.barcode };
      // Refresh the table so the newly generated barcode is visible in its row.
      render('products');
    }
    barcodePrintProduct = { productId: Number(product.productId), name: product.name, barcode: String(product.barcode || '') };
    document.getElementById('barcodePrintProductMeta').textContent = `${barcodePrintProduct.name} · Product ID ${barcodePrintProduct.productId} · ${barcodePrintProduct.barcode}`;
    document.getElementById('barcodeLabelCopies').value = '1';
    barcodePrintType = document.getElementById('barcodeLabelType')?.value || 'CODE39';
    updateBarcodePrintPreview();
    modal.hidden = false; document.body.classList.add('modal-open');
  } catch (err) {
    if (error) { error.hidden = false; error.textContent = err.message; }
    else showPopup(err.message, { title: 'Barcode label error', type: 'error' });
    modal.hidden = false; document.body.classList.add('modal-open');
  }
}
function updateBarcodePrintPreview() {
  const preview = document.getElementById('barcodeLabelPreview');
  const error = document.getElementById('barcodePrintError');
  if (!preview || !barcodePrintProduct) return;
  try {
    preview.innerHTML = `<div class="barcode-label-card ${barcodePrintType === 'QR' ? 'qr-label-card' : ''}"><strong>${escapeHtml(barcodePrintProduct.name)}</strong>${selectedProductCodeSvg(barcodePrintProduct.barcode)}<span>${barcodePrintType === 'QR' ? 'QR code' : 'Barcode'} · ${escapeHtml(barcodePrintProduct.barcode)}</span></div>`;
    if (error) { error.hidden = true; error.textContent = ''; }
  } catch (err) {
    preview.innerHTML = '';
    if (error) { error.hidden = false; error.textContent = err.message; }
  }
  const copies = Number(document.getElementById('barcodeLabelCopies')?.value || 0);
  const button = document.getElementById('barcodePrintButton');
  if (button) button.disabled = !Number.isInteger(copies) || copies < 1 || copies > 200 || !barcodePrintProduct || !labelCodeIsPrintable(barcodePrintProduct.barcode);
}
function setBarcodeLabelType(value) { barcodePrintType = value === 'QR' ? 'QR' : 'CODE39'; updateBarcodePrintPreview(); }
function closeBarcodePrint() {
  const modal = document.getElementById('barcodePrintModal'); if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}
async function downloadBarcodePng() {
  if (!barcodePrintProduct) return;
  try {
    const svg = selectedProductCodeSvg(barcodePrintProduct.barcode);
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = image.width * 3; canvas.height = image.height * 3;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(png => { if (!png) return showPopup('Could not create the PNG image.', { title: 'Download failed', type: 'error' }); const a=document.createElement('a'); a.href=URL.createObjectURL(png); a.download=`salesync-${barcodePrintType === 'QR' ? 'qr' : 'barcode'}-${barcodePrintProduct.productId}.png`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); }, 'image/png');
    };
    image.onerror = () => { URL.revokeObjectURL(url); showPopup('Could not generate this label image. Try the other label type or check the product code.', { title: 'Label generation failed', type: 'error' }); };
    image.src = url;
  } catch (err) { showPopup(err.message, { title: 'Label download failed', type: 'error' }); }
}
function printBarcodeLabels() {
  if (!barcodePrintProduct) return;
  const quantity = Number(document.getElementById('barcodeLabelCopies')?.value || 0);
  const error = document.getElementById('barcodePrintError');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 200) { if (error) { error.hidden = false; error.textContent = 'Enter a whole number from 1 to 200.'; } return; }
  try {
    const svg = selectedProductCodeSvg(barcodePrintProduct.barcode);
    const sheet = document.getElementById('barcodePrintSheet');
    sheet.innerHTML = Array.from({ length: quantity }, () => `<article class="barcode-print-label"><strong>${escapeHtml(barcodePrintProduct.name)}</strong>${svg}<span>${escapeHtml(barcodePrintProduct.barcode)}</span></article>`).join('');
    sheet.hidden = false; sheet.setAttribute('aria-hidden', 'false'); document.body.classList.add('printing-barcodes');
    closeBarcodePrint();
    setTimeout(() => window.print(), 100);
  } catch (err) { if (error) { error.hidden = false; error.textContent = err.message; } }
}
window.addEventListener('afterprint', () => {
  const sheet = document.getElementById('barcodePrintSheet');
  if (sheet) { sheet.hidden = true; sheet.setAttribute('aria-hidden', 'true'); sheet.innerHTML = ''; }
  document.body.classList.remove('printing-barcodes');
});

function catButtonsHTML() {
  return ["All", ...CATS].map((c, index) => `<button class="postab ${c === posCat ? 'on' : ''}" onclick="setPosCatIndex(${index})">${escapeHtml(c)}</button>`).join('');
}
function posItemsHTML(list) {
  if (!list.length) return `<div class="pos-empty">No products match.</div>`;
  return list.map(p => {
    const status = p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok';
    const inCart = cart.find(l => l.id === p.id);
    const disabled = p.stock === 0 || (inCart && inCart.qty >= p.stock);
    return `<button class="pos-item" ${disabled ? 'disabled' : ''} onclick="addToCart('${p.id}')">
      ${status !== 'ok' ? `<span class="pi-badge ${status}">${status === 'out' ? 'OUT' : p.stock + ' LEFT'}</span>` : ''}
      <div class="pi-name">${escapeHtml(p.name)}</div>
      <div class="pi-cat">${escapeHtml(p.cat)}</div>
      <div class="pi-price">${money(p.price)}</div>
    </button>`;
  }).join('');
}
function cartTotals() {
  const subtotal = cart.reduce((sum, l) => sum + l.price * l.qty, 0);
  const v = voucher ? VOUCHERS[voucher] : null;
  let discount = 0;
  if (v && subtotal >= Number(v.minimumPurchase || 0)) {
    discount = v.type === 'PERCENTAGE' ? subtotal * v.pct : Math.min(subtotal, Number(v.value || 0));
  }
  const tax = (subtotal - discount) * 0.12;
  const total = subtotal - discount + tax;
  return { subtotal, discount, tax, total };
}

function cartLinesHTML() {
  if (!cart.length) return `<div class="pos-empty">Tap a product to add it to the sale.</div>`;
  return cart.map(l => `
    <div class="pos-line">
      <div class="pl-name">${escapeHtml(l.name)}<div class="pl-sub">${money(l.price)} each</div></div>
      <div class="pos-qty"><button onclick="changeQty('${l.id}',-1)">−</button><span class="num">${l.qty}</span><button onclick="changeQty('${l.id}',1)">+</button></div>
      <button class="pl-remove" onclick="removeLine('${l.id}')">✕</button>
    </div>`).join('');
}
function totalsHTML() {
  const { subtotal, discount, tax, total } = cartTotals();
  return `
    <div class="plrow"><span>Subtotal</span><span class="num">${money(subtotal)}</span></div>
    ${discount > 0 ? `<div class="plrow"><span>Discount${voucher ? ' (' + voucher + ')' : ''}</span><span class="num down">-${money(discount)}</span></div>` : ''}
    <div class="plrow"><span>VAT (12%)</span><span class="num">${money(tax)}</span></div>
    <div class="plrow total"><span>Total due</span><span class="num">${money(total)}</span></div>`;
}
function voucherChipHTML() {
  if (!voucher) return '';
  return `<div class="pos-voucher-chip"><span>${VOUCHERS[voucher].label}</span><a onclick="removeVoucher()">Remove</a></div>`;
}
function payButtonsHTML() {
  const methods = [['cash','Cash',appSettings.enableCash],['card','Card',appSettings.enableCard],['paymongo','Online',appSettings.enableOnline]].filter(m => m[2]);
  if (!methods.some(m => m[0] === payMethod)) payMethod = methods[0]?.[0] || 'cash';
  return methods.map(([id,label]) => `<button class="${payMethod === id ? 'on' : ''}" onclick="setPay('${id}')">${label}</button>`).join('') || '<span class="form-error">No payment methods are enabled. Ask an admin to update Settings.</span>';
}
function cashRowHTML() {
  if (payMethod === 'cash') return `<div class="pos-cashrow"><span>Cash received</span><input id="cashGiven" placeholder="0.00" inputmode="decimal" oninput="onCashInput()"></div>`;
  if (payMethod === 'paymongo') return `<div class="payment-note"><strong>Online payment</strong><span>PayMongo checkout · GCash, Maya, or card</span></div>`;
  return '';
}
function checkoutBtnState() {
  const { total } = cartTotals();
  const cashGiven = parseFloat(document.getElementById('cashGiven')?.value) || 0;
  const canCheckout = cart.length > 0 && (payMethod !== 'cash' || cashGiven >= total);
  const btn = document.getElementById('checkoutBtn');
  if (!btn) return;
  btn.disabled = !canCheckout;
  btn.classList.toggle('ready', canCheckout);
  btn.textContent = cart.length ? `Charge ${money(total)}` : 'Charge';
}
function refreshCartPanel() {
  document.getElementById('posLines').innerHTML = cartLinesHTML();
  document.getElementById('posTotals').innerHTML = totalsHTML();
  document.getElementById('voucherApplied').innerHTML = voucherChipHTML();
  document.getElementById('posPay').innerHTML = payButtonsHTML();
  document.getElementById('posCashRow').innerHTML = cashRowHTML();
  const count = cart.reduce((a, l) => a + l.qty, 0);
  const cc = document.getElementById('cartCount'); if (cc) cc.textContent = count;
  const label = document.getElementById('cartCountLabel'); if (label) label.textContent = count;
  const clear = document.querySelector('.ghost-btn'); if (clear) clear.disabled = count === 0;
  checkoutBtnState();
}
function onCashInput() { checkoutBtnState(); }

function setPosQuery(v) { posQuery = v; document.getElementById('posGrid').innerHTML = posItemsHTML(filteredProducts()); }
function setPosCatIndex(index) { const choices = ["All", ...CATS]; posCat = choices[index] ?? 'All'; document.getElementById('posCats').innerHTML = catButtonsHTML(); document.getElementById('posGrid').innerHTML = posItemsHTML(filteredProducts()); }
function addToCart(id) {
  const p = products.find(x => x.id === id);
  if (!p || p.stock <= 0) return;
  const line = cart.find(l => l.id === id);
  if (line) { if (line.qty >= p.stock) return; line.qty++; }
  else cart.push({ ...p, qty: 1 });
  refreshCartPanel();
  document.getElementById('posGrid').innerHTML = posItemsHTML(filteredProducts());
}
function changeQty(id, delta) {
  const line = cart.find(l => l.id === id);
  const p = products.find(x => x.id === id);
  if (!line) return;
  if (delta > 0 && line.qty >= p.stock) return;
  line.qty += delta;
  if (line.qty <= 0) cart = cart.filter(l => l.id !== id);
  refreshCartPanel();
  document.getElementById('posGrid').innerHTML = posItemsHTML(filteredProducts());
}
function removeLine(id) { cart = cart.filter(l => l.id !== id); refreshCartPanel(); document.getElementById('posGrid').innerHTML = posItemsHTML(filteredProducts()); }
function clearCart() { cart = []; voucher = null; refreshCartPanel(); document.getElementById('posGrid').innerHTML = posItemsHTML(filteredProducts()); }
function applyVoucher() {
  const input = document.getElementById('voucherInput');
  const code = input.value.trim().toUpperCase();
  const v = VOUCHERS[code];
  const subtotal = cart.reduce((sum, l) => sum + l.price * l.qty, 0);
  if (v && subtotal >= Number(v.minimumPurchase || 0)) {
    voucher = code;
  } else if (v) {
    voucher = null;
    showPopup(`${code} requires a minimum purchase of ${money(v.minimumPurchase)}.`, { title: 'Minimum purchase not met', type: 'warning' });
  } else {
    voucher = null;
    showPopup('Invalid or inactive voucher code.', { title: 'Voucher not accepted', type: 'warning' });
  }
  refreshCartPanel();
}

function removeVoucher() { voucher = null; refreshCartPanel(); }
function setPay(m) { const allowed = { cash: appSettings.enableCash, card: appSettings.enableCard, paymongo: appSettings.enableOnline }; if (!allowed[m]) return; payMethod = m; refreshCartPanel(); }

function refreshDashboardKPIs() {
  const stats = computeStats();
  const todayRev = stats.todayRows.reduce((a, r) => a + r.total, 0);
  const revEl = document.getElementById('kpiTodayRev');
  if (revEl) {
    revEl.textContent = money(todayRev);
    document.getElementById('kpiTodayTx').textContent = stats.todayTxCount + ' transactions';
    document.getElementById('kpiLowStock').textContent = stats.lowStockCount;
  }
}

async function finalizeSale() {
  if (!cart.length) return;
  const { total } = cartTotals();
  const cashGiven = parseFloat(document.getElementById('cashGiven')?.value) || 0;
  if (payMethod === 'cash' && cashGiven < total) {
    showPopup(`Cash received must be at least ${money(total)}.`, { title: 'Insufficient cash', type: 'warning' });
    return;
  }

  const checkoutBtn = document.getElementById('checkoutBtn');
  if (checkoutBtn) {
    checkoutBtn.disabled = true;
    checkoutBtn.textContent = 'Saving…';
  }

  try {
    const response = await api('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        items: cart.map(l => ({ productId: l.productId, quantity: l.qty })),
        voucherCode: voucher,
        paymentMethod: payMethod === 'paymongo' ? 'ONLINE' : payMethod.toUpperCase(),
        cashReceived: payMethod === 'cash' ? cashGiven : null
      })
    });

    await loadData();
    const tx = transactions.find(t => t.id === response.transaction.id) || { ...response.transaction, time: new Date(response.transaction.time) };
    cart = [];
    voucher = null;
    showReceipt(tx);
    refreshCartPanel();
    const cats = document.getElementById('posCats');
    const grid = document.getElementById('posGrid');
    if (cats) cats.innerHTML = catButtonsHTML();
    if (grid) grid.innerHTML = posItemsHTML(filteredProducts());
    refreshDashboardKPIs();
  } catch (err) {
    showPopup(`Could not complete the sale: ${err.message}`, { title: 'Sale could not be completed', type: 'error' });
    checkoutBtnState();
  }
}
function payLabel(m) { return m === 'paymongo' ? 'ONLINE PAYMENT' : m.toUpperCase(); }
function receiptHTML(tx) {
  return `
    <h3>${escapeHtml(appSettings.storeName || 'SaleSync Store')}</h3>
    ${appSettings.storeAddress ? `<div class="pr-sub">${escapeHtml(appSettings.storeAddress)}</div>` : ''}
    ${appSettings.storePhone ? `<div class="pr-sub">${escapeHtml(appSettings.storePhone)}</div>` : ''}
    ${appSettings.storeEmail ? `<div class="pr-sub">${escapeHtml(appSettings.storeEmail)}</div>` : ''}
    <div class="pr-sub">Receipt #${tx.receiptNumber || tx.id} · ${formatDateTime(tx.time)}</div>
    ${tx.lines.map(l => `<div class="pr-line"><span>${l.qty}× ${escapeHtml(l.name)}</span><span>${money(l.lineTotal)}</span></div>`).join('')}
    <hr>
    <div class="pr-line"><span>Subtotal</span><span>${money(tx.subtotal)}</span></div>
    ${tx.discount > 0 ? `<div class="pr-line"><span>Discount${tx.voucher ? ' (' + tx.voucher + ')' : ''}</span><span>-${money(tx.discount)}</span></div>` : ''}
    <div class="pr-line"><span>VAT (12%)</span><span>${money(tx.tax)}</span></div>
    <div class="pr-line" style="font-weight:700"><span>TOTAL</span><span>${money(tx.total)}</span></div>
    <hr>
    <div class="pr-line"><span>Paid via</span><span>${payLabel(tx.payMethod)}</span></div>
    ${tx.payMethod === 'cash' ? `<div class="pr-line"><span>Tendered</span><span>${money(tx.cashGiven)}</span></div><div class="pr-line"><span>Change</span><span>${money(tx.change)}</span></div>` : ''}
    ${appSettings.receiptFooter ? `<div class="pr-sub receipt-footer">${escapeHtml(appSettings.receiptFooter)}</div>` : ''}`;
}
function receiptText(tx) {
  let l = [String(appSettings.storeName || 'SaleSync Store').toUpperCase(), ...(appSettings.storeAddress ? [appSettings.storeAddress] : []), ...(appSettings.storePhone ? [appSettings.storePhone] : []), ...(appSettings.storeEmail ? [appSettings.storeEmail] : []), `Receipt #${tx.receiptNumber || tx.id}`, formatDateTime(tx.time), '------------------------'];
  tx.lines.forEach(i => l.push(`${i.qty}x ${i.name}  ${money(i.lineTotal)}`));
  l.push('------------------------');
  l.push(`Subtotal  ${money(tx.subtotal)}`);
  if (tx.discount > 0) l.push(`Discount  -${money(tx.discount)}`);
  l.push(`VAT 12%   ${money(tx.tax)}`);
  l.push(`TOTAL     ${money(tx.total)}`);
  l.push('------------------------');
  l.push(`Paid via  ${payLabel(tx.payMethod)}`);
  if (tx.payMethod === 'cash') { l.push(`Tendered  ${money(tx.cashGiven)}`); l.push(`Change    ${money(tx.change)}`); }
  l.push(appSettings.receiptFooter || 'Thank you for shopping!');
  return l.join('\n');
}
function showReceipt(tx, readonly) {
  document.getElementById('posReceiptBody').innerHTML = receiptHTML(tx) + `
    <div class="pos-receipt-actions">
      <button class="btn" onclick="downloadReceipt(${tx.id})">Download</button>
      <button class="btn" style="background:var(--accent2)" onclick="toggleEmailRow(${tx.id})">Email</button>
    </div>
    <div class="pos-email-row" id="emailRow-${tx.id}"><input type="email" id="emailInput-${tx.id}" placeholder="name@email.com"><button class="btn" onclick="sendEmailReceipt(${tx.id})">Send</button></div>
    <div class="pos-sent" id="sentMsg-${tx.id}">Digital receipt delivery is not configured yet. Use the field below to record a delivery request.</div>
    <button class="btn primary-full" onclick="closeReceipt()">${readonly ? 'Close' : 'New sale'}</button>`;
  document.getElementById('posOverlay').classList.add('show');
}
function toggleEmailRow(id) { document.getElementById('emailRow-' + id).classList.toggle('show'); }
async function sendEmailReceipt(id) {
  const val = document.getElementById('emailInput-' + id).value.trim();
  if (!val) return;
  try {
    const result = await api(`/transactions/${id}/digital-receipt`, {
      method: 'POST', body: JSON.stringify({ email: val })
    });
    const msg = document.getElementById('sentMsg-' + id);
    msg.textContent = result.message || `Digital receipt request recorded for ${val}.`;
    msg.classList.add('show');
  } catch (err) {
    showPopup(err.message, { title: 'Request failed', type: 'error' });
  }
}
async function downloadReceipt(id) {
  const tx = transactions.find(t => t.id === id);
  if (!tx) return;
  const text = receiptText(tx);
  try {
    const downloads = await claude.use("downloads");
    if (downloads) { await downloads.save({ filename: `receipt-${tx.receiptNumber || id}.txt`, data: text }); return; }
  } catch (e) { /* fall through to blob download */ }
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `receipt-${tx.receiptNumber || id}.txt`; a.click();
  URL.revokeObjectURL(url);
}
function closeReceipt() { document.getElementById('posOverlay').classList.remove('show'); }

// ---------- Sales page helpers (admin) ----------
const salesState = { tab: 'history', pay: 'all', range: 7, category: 'all', page: 1, q: '', open: new Set(), opened: false };
const SALES_PER_PAGE = 10;
function localISO(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function salesCutoff() { if (!salesState.range) return null; const d = new Date(); d.setDate(d.getDate() - (salesState.range - 1)); return localISO(d); }
function payClass(m) { return m === 'paymongo' ? 'online' : m; }
function payShort(m) { return m === 'paymongo' ? 'ONLINE' : String(m).toUpperCase(); }
function filteredTx() {
  const cut = salesCutoff(), q = salesState.q;
  return transactions.filter(t => (!cut || localISO(t.time) >= cut) && (salesState.pay === 'all' || t.payMethod === salesState.pay)
    && (!q || ((t.receiptNumber || '') + ' ' + t.lines.map(l => l.name).join(' ')).toLowerCase().includes(q)));
}
function filteredEntries() {
  const cut = salesCutoff(), q = salesState.q;
  return sales.filter(s => (!cut || s.date >= cut) && (salesState.pay === 'all' || (s.payMethod || 'cash') === salesState.pay)
    && (salesState.category === 'all' || s.cat === salesState.category)
    && (!q || ((s.receiptNumber || '') + ' ' + s.name + ' ' + s.cat).toLowerCase().includes(q)));
}
function salesCategoryHTML() {
  const available = [...new Set([...CATS, ...sales.map(row => row.cat).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  const active = available.includes(salesState.category) ? salesState.category : 'all';
  return `<select class="i-select sales-category-select" aria-label="Filter Daily Sales by category" onchange="setSalesCategory(this.value)"><option value="all" ${active === 'all' ? 'selected' : ''}>All categories</option>${available.map(c => `<option value="${escapeHtml(c)}" ${active === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>`;
}
function salesChipsHTML() {
  const pay = [['all', 'All'], ['cash', 'Cash'], ['card', 'Card'], ['paymongo', 'Online']].map(([v, l]) => `<button class="s-chip ${salesState.pay === v ? 'on' : ''}" onclick="setSalesPay('${v}')">${l}</button>`).join('');
  const rng = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [0, 'All']].map(([v, l]) => `<button class="s-chip ${salesState.range === v ? 'on' : ''}" onclick="setSalesRange(${v})">${l}</button>`).join('');
  return { pay, rng };
}
function salesKpisHTML() {
  let total, count, items;
  if (salesState.tab === 'history') {
    const f = filteredTx();
    total = f.reduce((a, t) => a + t.total, 0); count = f.length; items = f.reduce((a, t) => a + t.lines.reduce((x, l) => x + l.qty, 0), 0);
  } else {
    const f = filteredEntries();
    total = f.reduce((a, r) => a + r.total, 0); count = new Set(f.map(r => r.transactionId)).size; items = f.reduce((a, r) => a + r.qty, 0);
  }
  const cards = [['Total sales', money(total), 'In selected range', 't-navy', 'peso'], ['Transactions', count, 'Completed sales', 't-sky', 'receipt'],
    ['Average sale', money(count ? total / count : 0), 'Per transaction', 't-navy', 'average'], ['Items sold', items, 'Units across all sales', 't-amber', 'bag']];
  return cards.map((c, i) => `<div class="card d-kpi d-anim" style="--i:${i}"><div><div class="l">${c[0]}</div><div class="v num">${c[1]}</div><div class="d">${c[2]}</div></div><div class="d-kic ${c[3]}">${dIcon(c[4])}</div></div>`).join('');
}
function salesEmptyHTML() {
  return `<div class="card"><div class="d-empty"><span class="d-bubble">${dIcon('receipt')}</span><strong>No transactions found</strong>Try a different search or date range.</div></div>`;
}
function salesBodyHTML() {
  if (salesState.tab === 'history') {
    const f = filteredTx();
    if (!f.length) return salesEmptyHTML();
    const pages = Math.ceil(f.length / SALES_PER_PAGE);
    salesState.page = Math.min(Math.max(salesState.page, 1), pages);
    const rows = f.slice((salesState.page - 1) * SALES_PER_PAGE, salesState.page * SALES_PER_PAGE);
    return `<div class="card"><div class="tw"><table class="s-table"><thead><tr><th>Receipt</th><th>Time</th><th>Items</th><th>Payment</th><th>Voucher</th><th class="r">Total</th><th></th></tr></thead><tbody>
      ${rows.map(t => { const more = t.lines.length - 1; const first = t.lines[0] ? t.lines[0].name + ' ×' + t.lines[0].qty : '—';
        return `<tr><td><div class="s-rc"><span class="d-sic">${dIcon('receipt')}</span>${t.receiptNumber || '#' + t.id}</div></td>
        <td>${formatDateTime(t.time, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', year: undefined })}</td>
        <td>${first}${more > 0 ? ` <span class="s-more">+${more} more</span>` : ''}</td>
        <td><span class="s-pay p-${payClass(t.payMethod)}">${payShort(t.payMethod)}</span></td><td>${t.voucher || '—'}</td>
        <td class="num"><strong>${money(t.total)}</strong>${t.returnedAmount > 0 ? `<small class="return-summary">Returns: ${money(t.returnedAmount)}</small>` : ''}</td>
        <td class="action-cell"><div class="sales-row-actions"><button class="s-btn" onclick='showReceipt(transactions.find(x=>x.id===${t.id}), true)'>${dIcon('eye')}Receipt</button><button class="s-btn ${t.canReturn ? '' : 'disabled'}" ${t.canReturn ? '' : 'disabled'} onclick="openReturnModal(${t.id})">${t.canReturn ? 'Return / refund' : 'Returned'}</button></div></td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="s-pager"><span>Showing ${(salesState.page - 1) * SALES_PER_PAGE + 1}–${Math.min(salesState.page * SALES_PER_PAGE, f.length)} of ${f.length}</span>
      <div class="s-pg"><button onclick="setSalesPage(${salesState.page - 1})" ${salesState.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${salesState.page} of ${pages}</span><button onclick="setSalesPage(${salesState.page + 1})" ${salesState.page >= pages ? 'disabled' : ''}>Next</button></div></div></div>`;
  }
  const f = filteredEntries();
  if (!f.length) return salesEmptyHTML();
  const groups = {};
  f.forEach(r => { (groups[r.date] = groups[r.date] || []).push(r); });
  const dates = Object.keys(groups).sort().reverse();
  if (!salesState.opened) { salesState.open.add(dates[0]); salesState.opened = true; }
  return dates.map(date => {
    const list = groups[date], tot = list.reduce((a, r) => a + r.total, 0), pr = list.reduce((a, r) => a + r.profit, 0);
    const n = list.reduce((a, r) => a + r.qty, 0), tcount = new Set(list.map(r => r.transactionId)).size;
    const d = new Date(date + 'T00:00:00'), isToday = date === localISO(new Date());
    const label = (isToday ? 'Today · ' : '') + formatDateOnly(d);
    return `<div class="s-day ${salesState.open.has(date) ? 'open' : ''}"><button class="s-dh" onclick="toggleSalesDay('${date}')"><span class="s-ch">${dIcon('chevron')}</span>
      <span class="s-dd"><span class="d-sic">${dIcon('calendar')}</span><span><b>${label}</b><small>${tcount} ${tcount === 1 ? 'transaction' : 'transactions'} · ${n} items</small></span></span>
      <span class="s-prof">+${money(pr)} · ${tot ? Math.round(pr / tot * 100) : 0}%</span><span class="s-tot num">${money(tot)}</span></button>
      <div class="s-db"><div class="tw"><table class="s-table"><thead><tr><th>Receipt</th><th>Product</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total</th><th class="r">Profit</th></tr></thead><tbody>
      ${list.map(r => `<tr><td>${escapeHtml(r.receiptNumber || '#' + r.transactionId)}</td><td><strong>${escapeHtml(r.name)}</strong></td><td class="num">${r.qty}</td><td class="num">${money(r.price)}</td><td class="num"><strong>${money(r.total)}</strong></td><td class="num"><span class="s-prof">+${money(r.profit)}</span></td></tr>`).join('')}
      </tbody></table></div></div></div>`;
  }).join('');
}
function refreshSales() {
  const c = salesChipsHTML();
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  set('salesPayChips', c.pay); set('salesRangeChips', c.rng); set('salesCategoryFilter', salesState.tab === 'history' ? '' : salesCategoryHTML()); set('salesKpis', salesKpisHTML()); set('salesBody', salesBodyHTML());
}
function setSalesPay(v) { salesState.pay = v; salesState.page = 1; refreshSales(); }
function setSalesCategory(v) { const available = new Set([...CATS, ...sales.map(row => row.cat).filter(Boolean)]); salesState.category = v === 'all' || available.has(v) ? v : 'all'; salesState.page = 1; refreshSales(); }
function setSalesRange(v) { salesState.range = v; salesState.page = 1; refreshSales(); }
function setSalesQ(v) { salesState.q = v.trim().toLowerCase(); salesState.page = 1; refreshSales(); }
function setSalesPage(n) { salesState.page = n; refreshSales(); }
function toggleSalesDay(date) { salesState.open.has(date) ? salesState.open.delete(date) : salesState.open.add(date); refreshSales(); }
function salesPage(active) {
  salesState.tab = active; salesState.page = 1;
  const c = salesChipsHTML();
  const isTx = active === 'history';
  return `
  <div class="page-head"><div><div class="eyebrow">SALES</div><h1>${isTx ? 'Transaction history' : 'Daily sales'}</h1><p>${isTx ? 'Completed checkout transactions and their receipt details.' : 'Sales grouped by day, with profit for each line.'}</p></div>
    <div class="s-seg"><button class="${isTx ? 'on' : ''}" onclick="render('history')">Transactions</button><button class="${isTx ? '' : 'on'}" onclick="render('ledger')">Daily sales</button></div></div>
  <div class="sec grid g4" id="salesKpis">${salesKpisHTML()}</div>
  <div class="s-bar">
    <div class="s-search">${dIcon('magnifying%20glass')}<input id="salesSearch" type="search" placeholder="Search receipt or product" value="${salesState.q}" oninput="setSalesQ(this.value)"></div>
    ${isTx ? '' : `<div id="salesCategoryFilter">${salesCategoryHTML()}</div>`}
    <div class="s-chips" id="salesPayChips">${c.pay}</div><div class="s-spacer"></div>
    <div class="s-chips" id="salesRangeChips">${c.rng}</div>
    <button class="s-btn" onclick="exportSalesCsv()">${dIcon('download')}Export CSV</button>
  </div>
  <div id="salesBody">${salesBodyHTML()}</div>`;
}
async function exportSalesCsv() {
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  let head, rows;
  if (salesState.tab === 'history') {
    head = ['Receipt', 'Date and time', 'Items', 'Payment', 'Voucher', 'Total'];
    rows = filteredTx().map(t => [t.receiptNumber || t.id, formatDateTime(t.time), t.lines.map(l => l.qty + 'x ' + l.name).join('; '), payShort(t.payMethod), t.voucher || '', t.total.toFixed(2)]);
  } else {
    head = ['Date', 'Receipt', 'Product', 'Category', 'Qty', 'Price', 'Net item sales', 'Profit'];
    rows = filteredEntries().map(r => [r.date, r.receiptNumber || r.transactionId, r.name, r.cat, r.qty, r.price.toFixed(2), r.total.toFixed(2), r.profit.toFixed(2)]);
  }
  const text = [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  const filename = `salesync-${salesState.tab === 'history' ? 'transactions' : 'daily-sales'}-${localISO(new Date())}.csv`;
  try {
    const downloads = await claude.use("downloads");
    if (downloads) { await downloads.save({ filename, data: text }); return; }
  } catch (e) { /* fall through to blob download */ }
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---------- Inventory page helpers (admin) ----------
const invState = { tab: 'inventory', q: '', status: 'all', cat: 'all', sort: { k: 'name', d: 1 }, page: 1, drafts: {}, savedId: null };
const INV_PER_PAGE = 10;
function invStatus(p) { return p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok'; }
const INV_LABEL = { ok: 'In stock', low: 'Low stock', out: 'Out of stock' };
function invList() {
  const val = { name: p => p.name.toLowerCase(), cat: p => p.cat, stock: p => p.stock, price: p => p.price, margin: p => p.price ? (p.price - p.cost) / p.price : 0 }[invState.sort.k];
  return products.filter(p => (!invState.q || p.name.toLowerCase().includes(invState.q) || String(p.barcode || '').toLowerCase().includes(invState.q) || String(p.productId).includes(invState.q)) && (invState.status === 'all' || invStatus(p) === invState.status) && (invState.cat === 'all' || p.cat === invState.cat))
    .sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * invState.sort.d; });
}
function invChipsHTML() {
  return [['all', 'All'], ['ok', 'In stock'], ['low', 'Low'], ['out', 'Out']].map(([v, l]) => `<button class="s-chip ${invState.status === v ? 'on' : ''}" onclick="setInvStatus('${v}')">${l}</button>`).join('');
}
function invKpisHTML() {
  const low = products.filter(p => invStatus(p) === 'low').length, out = products.filter(p => invStatus(p) === 'out').length;
  const value = products.reduce((a, p) => a + p.stock * p.cost, 0);
  const cards = [['Total products', products.length, 'Active in catalog', 't-navy', 'box'], ['Stock value', money(value), 'At cost price', 't-sky', 'peso'],
    ['Low stock', low, 'Click to filter', 't-amber', 'alert', 'low'], ['Out of stock', out, 'Click to filter', 't-rose', 'out', 'out']];
  return cards.map((c, i) => `<${c[5] ? 'button type="button"' : 'div'} class="card d-kpi d-anim ${c[5] ? 'i-kpi-btn' : ''}" style="--i:${i}" ${c[5] ? `onclick="setInvStatus('${c[5]}')"` : ''}><div><div class="l">${c[0]}</div><div class="v num">${c[1]}</div><div class="d">${c[2]}</div></div><div class="d-kic ${c[3]}">${dIcon(c[4])}</div></${c[5] ? 'button' : 'div'}>`).join('');
}
function invTh(k, label, right) {
  return `<th class="i-sort ${invState.sort.k === k ? 'on' : ''} ${right ? 'r' : ''}" onclick="setInvSort('${k}')">${label}${dIcon('sort')}</th>`;
}
function invMargin(cost, price) {
  const m = price ? (price - cost) / price * 100 : 0;
  return `<span class="i-mg ${m < 0 ? 'b' : m < 20 ? 'w' : 'g'}">${m.toFixed(0)}%</span>`;
}
function invBodyHTML() {
  const f = invList();
  if (!f.length) return `<div class="card"><div class="d-empty"><span class="d-bubble">${dIcon('box')}</span><strong>No products found</strong>Try a different search or filter.</div></div>`;
  const pages = Math.ceil(f.length / INV_PER_PAGE);
  invState.page = Math.min(Math.max(invState.page, 1), pages);
  const rows = f.slice((invState.page - 1) * INV_PER_PAGE, invState.page * INV_PER_PAGE);
  const catBadge = p => `<span class="i-cat k${Math.max(CATS.indexOf(p.cat), 0) % 6}">${escapeHtml(p.cat)}</span>`;
  let head, trs;
  if (invState.tab === 'inventory') {
    head = `<tr>${invTh('name', 'Product')}${invTh('cat', 'Category')}${invTh('stock', 'Stock')}${invTh('price', 'Price', true)}<th>Status</th><th></th></tr>`;
    trs = rows.map(p => { const st = invStatus(p), w = Math.min(100, p.stock / ((p.reorder || 1) * 3) * 100);
      return `<tr class="${st === 'out' ? 'i-outrow' : ''}"><td><div class="s-rc"><span class="d-sic">${dIcon('box')}</span>${escapeHtml(p.name)}</div></td><td>${catBadge(p)}</td>
        <td><div class="i-sb"><b class="num">${p.stock}</b><div class="i-trk"><i class="f-${st}" style="width:${st === 'out' ? 0 : Math.max(w, 4)}%"></i></div></div></td>
        <td class="num"><strong>${money(p.price)}</strong></td><td><span class="i-st ${st}">${INV_LABEL[st]}</span></td>
        <td class="action-cell"><button class="s-btn ${st === 'out' ? 'hot' : ''}" onclick="restockProduct('${p.id}')">${st === 'out' ? 'Restock now' : 'Add stock'}</button></td></tr>`; }).join('');
  } else {
    head = `<tr><th>ID</th>${invTh('name', 'Product')}<th>Barcode</th>${invTh('cat', 'Category')}<th class="r">Cost</th>${invTh('price', 'Price', true)}${invTh('margin', 'Margin', true)}<th class="r">Warn at</th>${invTh('stock', 'Stock', true)}<th>Status</th><th></th></tr>`;
    trs = rows.map(p => { const st = invStatus(p), id = p.productId, d = invState.drafts[id] || {};
      const cost = d.cost ?? p.cost, price = d.price ?? p.price, reorder = d.reorder ?? p.reorder, barcode = d.barcode ?? (p.barcode || ''), catId = d.cat ?? categoryIdByName[p.cat];
      return `<tr><td class="num">${id}</td><td><strong>${escapeHtml(p.name)}</strong></td>
        <td><input id="product-barcode-${id}" class="i-in barcode-input" type="text" maxlength="64" value="${escapeHtml(barcode)}" placeholder="Auto-generated" oninput="invEdit(${id})" aria-label="Barcode for ${escapeHtml(p.name)}"></td>
        <td><select id="product-category-${id}" onchange="invEdit(${id})">${CATS.map(c => `<option value="${categoryIdByName[c]}" ${String(categoryIdByName[c]) === String(catId) ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select></td>
        <td class="r"><input id="product-cost-${id}" class="i-in num" type="number" min="0" step="0.01" value="${cost}" oninput="invEdit(${id})" aria-label="Cost"></td>
        <td class="r"><input id="product-price-${id}" class="i-in num" type="number" min="0" step="0.01" value="${price}" oninput="invEdit(${id})" aria-label="Price"></td>
        <td class="r" id="inv-margin-${id}">${invMargin(Number(cost), Number(price))}</td>
        <td class="r"><input id="product-reorder-${id}" class="i-in num" style="width:64px" type="number" min="0" step="1" value="${reorder}" oninput="invEdit(${id})" aria-label="Low-stock warning level"></td>
        <td class="num r">${p.stock}</td><td><span class="i-st ${st}">${INV_LABEL[st]}</span></td>
        <td class="action-cell"><div class="inv-row-actions"><button id="inv-save-${id}" class="s-btn pri" ${invState.drafts[id] ? '' : 'hidden'} onclick="saveProductRow(${id})">Save</button><button class="s-btn" onclick="openBarcodePrint(${id})">Labels</button></div>${invState.savedId === id ? `<span class="i-ok" id="inv-ok-${id}">${dIcon('check')}Saved</span>` : ''}</td></tr>`; }).join('');
  }
  // Use percentage-based columns so inventory tables fill the available card width
  // on large screens; minimum widths preserve readability on smaller screens.
  const colgroup = invState.tab === 'products'
    ? `<colgroup><col style="width:5%"><col style="width:15%"><col style="width:12%"><col style="width:12%"><col style="width:7%"><col style="width:7%"><col style="width:6%"><col style="width:7%"><col style="width:5%"><col style="width:8%"><col style="width:16%"></colgroup>`
    : `<colgroup><col style="width:22%"><col style="width:15%"><col style="width:18%"><col style="width:12%"><col style="width:13%"><col style="width:20%"></colgroup>`;
  return `<div class="card"><div class="tw"><table class="s-table ${invState.tab === 'products' ? 'inventory-table inventory-table-products' : 'inventory-table inventory-table-stock'}">${colgroup}<thead>${head}</thead><tbody>${trs}</tbody></table></div>
    <div class="s-pager"><span>Showing ${(invState.page - 1) * INV_PER_PAGE + 1}–${Math.min(invState.page * INV_PER_PAGE, f.length)} of ${f.length}</span>
    <div class="s-pg"><button onclick="setInvPage(${invState.page - 1})" ${invState.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${invState.page} of ${pages}</span><button onclick="setInvPage(${invState.page + 1})" ${invState.page >= pages ? 'disabled' : ''}>Next</button></div></div></div>
    ${invState.tab === 'products' ? '<div class="table-footnote">The low-stock warning appears when current stock reaches the number set for that product. Zero means out of stock.</div>' : ''}`;
}
function refreshInv() {
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  set('invChips', invChipsHTML()); set('invKpis', invKpisHTML()); set('invBody', invBodyHTML());
}
function setInvStatus(v) { invState.status = v; invState.page = 1; refreshInv(); }
function setInvCat(v) { invState.cat = v; invState.page = 1; refreshInv(); }
function setInvQ(v) { invState.q = v.trim().toLowerCase(); invState.page = 1; refreshInv(); }
function setInvPage(n) { invState.page = n; refreshInv(); }
function setInvSort(k) { invState.sort = { k, d: invState.sort.k === k ? -invState.sort.d : 1 }; refreshInv(); }
function invEdit(id) {
  const g = n => document.getElementById(`product-${n}-${id}`);
  if (!g('cost')) return;
  invState.drafts[id] = { cost: g('cost').value, price: g('price').value, reorder: g('reorder').value, cat: g('category').value, barcode: g('barcode')?.value ?? '' };
  const m = document.getElementById('inv-margin-' + id); if (m) m.innerHTML = invMargin(Number(g('cost').value), Number(g('price').value));
  const sv = document.getElementById('inv-save-' + id); if (sv) sv.hidden = false;
  document.getElementById('inv-ok-' + id)?.remove();
}
function inventoryPage(active) {
  if (invState.tab !== active) invState.page = 1;
  invState.tab = active;
  const isStock = active === 'inventory';
  return `
  <div class="page-head"><div><div class="eyebrow">INVENTORY</div><h1>${isStock ? 'Central stock' : 'Product management'}</h1><p>${isStock ? 'One stock view for products sold in-store and through e-commerce.' : 'Update product details and the low-stock warning. Current stock is managed in Central stock.'}</p></div>
    <div class="s-right"><div class="s-seg"><button class="${isStock ? 'on' : ''}" onclick="render('inventory')">Central stock</button><button class="${isStock ? '' : 'on'}" onclick="render('products')">Products</button></div>
    ${isStock ? '' : `<button class="s-btn" onclick="openCategoryManager()">Manage categories</button><button class="s-btn pri" onclick="addProduct()">${dIcon('plus')}Add product</button>`}</div></div>
  <div class="sec grid g4" id="invKpis">${invKpisHTML()}</div>
  <div class="s-bar">
    <div class="s-search">${dIcon('magnifying%20glass')}<input type="search" placeholder="Search product" value="${invState.q}" oninput="setInvQ(this.value)"></div>
    <div class="s-chips" id="invChips">${invChipsHTML()}</div>
    <select class="i-select" onchange="setInvCat(this.value)"><option value="all">All categories</option>${CATS.map(c => `<option value="${escapeHtml(c)}" ${invState.cat === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>
    <div class="s-spacer"></div><button class="s-btn" onclick="exportInvCsv()">${dIcon('download')}Export CSV</button>
  </div>
  <div id="invBody">${invBodyHTML()}</div>`;
}
async function exportInvCsv() {
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['Product ID', 'Product', 'Barcode', 'Category', 'Cost', 'Price', 'Margin %', 'Stock', 'Low-stock warning', 'Status'];
  const rows = invList().map(p => [p.productId, p.name, p.barcode || '', p.cat, p.cost.toFixed(2), p.price.toFixed(2), p.price ? ((p.price - p.cost) / p.price * 100).toFixed(1) : '0', p.stock, p.reorder, INV_LABEL[invStatus(p)]]);
  const text = [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  const filename = `salesync-${invState.tab === 'inventory' ? 'central-stock' : 'products'}-${localISO(new Date())}.csv`;
  try {
    const downloads = await claude.use("downloads");
    if (downloads) { await downloads.save({ filename, data: text }); return; }
  } catch (e) { /* fall through to blob download */ }
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---------- Analytics helpers (admin) ----------
const anState = { met: 'both', cmp: true, tps: 'rev' };
let anCache = null;
const AN_COLORS = ['#265194', '#6AB3CD', '#D9A63A', '#3FA382', '#7B68C8', '#D0687A'];
const AN_PAY = { cash: ['Cash', '#6AB3CD'], card: ['Card', '#265194'], online: ['Online', '#D9A63A'] };
function anColor(cat) { return AN_COLORS[Math.max(CATS.indexOf(cat), 0) % AN_COLORS.length]; }
function anDateStr(daysAgo) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - daysAgo); return localISO(d); }
function anShort(v) { return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(v)); }
function anHour(h) { return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); }
function anLabel(dateStr) { return formatDateOnly(new Date(dateStr + 'T00:00:00')); }
function anTrend(cur, prev) {
  if (!prev) return '';
  const p = (cur - prev) / prev * 100;
  return `<span class="a-tr ${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(1)}%</span>`;
}
function anData() {
  const N = analyticsRangeDays;
  const curDates = [...Array(N)].map((_, i) => anDateStr(N - 1 - i));
  const prevDates = [...Array(N)].map((_, i) => anDateStr(2 * N - 1 - i));
  const idx = {}, pidx = {};
  curDates.forEach((d, i) => { idx[d] = i; }); prevDates.forEach((d, i) => { pidx[d] = i; });
  const txInfo = {}; transactions.forEach(t => { txInfo[t.id] = t; });
  const a = { N, curDates, byD: Array(N).fill(0), pf: Array(N).fill(0), byDP: Array(N).fill(0), pp: {}, cat: {}, hr: {}, pay: {}, rev: 0, profit: 0, units: 0, tx: new Set(), prevRev: 0, prevProfit: 0, prevTx: new Set() };
  sales.forEach(s => {
    if (s.date in idx) {
      const i = idx[s.date];
      a.byD[i] += s.total; a.pf[i] += s.profit; a.rev += s.total; a.profit += s.profit; a.units += s.qty; a.tx.add(s.transactionId);
      const k = s.productId ?? s.name, o = a.pp[k] = a.pp[k] || { name: s.name, rev: 0, u: 0, pf: 0 };
      o.rev += s.total; o.u += s.qty; o.pf += s.profit;
      const c = a.cat[s.cat] = a.cat[s.cat] || { rev: 0, u: 0, pf: 0 };
      c.rev += s.total; c.u += s.qty; c.pf += s.profit;
      const t = txInfo[s.transactionId];
      if (t && t.time instanceof Date) { const h = t.time.getHours(); a.hr[h] = (a.hr[h] || 0) + s.total; const pm = payClass(t.payMethod); a.pay[pm] = (a.pay[pm] || 0) + s.total; }
    } else if (s.date in pidx) {
      a.byDP[pidx[s.date]] += s.total; a.prevRev += s.total; a.prevProfit += s.profit; a.prevTx.add(s.transactionId);
    }
  });
  return a;
}
function anKpisHTML(a) {
  const txN = a.tx.size, avg = txN ? a.rev / txN : 0, prevAvg = a.prevTx.size ? a.prevRev / a.prevTx.size : 0;
  const cards = [['Revenue', money(a.rev), anTrend(a.rev, a.prevRev) + 'vs previous', 't-navy', 'peso'],
    ['Gross profit', money(a.profit), anTrend(a.profit, a.prevProfit) + (a.rev ? (a.profit / a.rev * 100).toFixed(1) + '% margin' : ''), 't-green', 'trend'],
    ['Transactions', txN, anTrend(txN, a.prevTx.size) + a.units + ' items sold', 't-sky', 'receipt'],
    ['Average sale', money(avg), anTrend(avg, prevAvg) + 'per transaction', 't-amber', 'average']];
  return cards.map((c, i) => `<div class="card d-kpi d-anim" style="--i:${i}"><div><div class="l">${c[0]}</div><div class="v num">${c[1]}</div><div class="d">${c[2]}</div></div><div class="d-kic ${c[3]}">${dIcon(c[4])}</div></div>`).join('');
}
function anInsightsHTML(a) {
  const bi = a.byD.indexOf(Math.max(...a.byD)), tp = Object.values(a.pp).sort((x, y) => y.rev - x.rev)[0];
  const ph = Object.entries(a.hr).sort((x, y) => y[1] - x[1])[0];
  const bc = Object.entries(a.cat).map(([k, v]) => [k, v.rev ? v.pf / v.rev : 0]).sort((x, y) => y[1] - x[1])[0];
  const items = [['Best day', a.rev ? anLabel(a.curDates[bi]) + ' · ' + money(a.byD[bi]) : '—', 'calendar', 't-navy'], ['Top product', tp ? tp.name : '—', 'trophy', 't-amber'],
    ['Peak hour', ph ? anHour(+ph[0]) + ' – ' + anHour((+ph[0] + 1) % 24) : '—', 'clock', 't-sky'], ['Best margin', bc ? bc[0] + ' · ' + Math.round(bc[1] * 100) + '%' : '—', 'percent', 't-green']];
  return items.map(x => `<div class="a-in"><div class="a-ib ${x[3]}">${dIcon(x[2])}</div><div><small>${x[0]}</small><b>${x[1]}</b></div></div>`).join('');
}
function anChartHTML(a) {
  const N = a.N, W = 700, H = 270, L = 46, R = 14, T = 14, B = 30, cmp = anState.cmp, met = anState.met;
  const mx = Math.max(...a.byD, ...(met !== 'rev' ? a.pf : [0]), ...(cmp && met !== 'profit' ? a.byDP : [0]), 1);
  const pw = Math.pow(10, Math.floor(Math.log10(mx))), top = Math.ceil(mx / pw) * pw;
  const x = i => L + i * (W - L - R) / Math.max(N - 1, 1), y = v => T + (1 - v / top) * (H - T - B);
  anCache.geom = { W, H, L, R, T, x, y };
  const path = arr => 'M' + arr.map((v, i) => x(i) + ',' + y(v)).join(' L');
  let s = `<defs><linearGradient id="anGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#265194" stop-opacity=".22"/><stop offset="1" stop-color="#265194" stop-opacity="0"/></linearGradient></defs>`;
  [0, .25, .5, .75, 1].forEach(f => { const v = top * f; s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E3EAF0"/><text x="${L - 8}" y="${y(v) + 4}" font-size="11" fill="#7C8A99" text-anchor="end">${anShort(v)}</text>`; });
  if (cmp && met !== 'profit') s += `<path d="${path(a.byDP)}" fill="none" stroke="#9AA8B6" stroke-width="2" stroke-dasharray="5 5"/>`;
  if (met !== 'profit') s += `<path d="${path(a.byD)} L${x(N - 1)},${y(0)} L${x(0)},${y(0)}Z" fill="url(#anGrad)"/>`;
  const sers = []; if (met !== 'profit') sers.push([a.byD, '#265194']); if (met !== 'rev') sers.push([a.pf, '#6AB3CD']);
  sers.forEach(([arr, c]) => { s += `<path d="${path(arr)}" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`; if (N <= 14) arr.forEach((v, i) => { s += `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="#fff" stroke="${c}" stroke-width="2"/>`; }); });
  const step = Math.ceil(N / 7);
  for (let i = 0; i < N; i += step) s += `<text x="${x(i)}" y="${H - 8}" font-size="11" fill="#7C8A99" text-anchor="middle">${anLabel(a.curDates[i])}</text>`;
  s += `<line id="anXh" y1="${T}" y2="${H - B}" stroke="#265194" stroke-opacity=".35" style="display:none"/>`;
  const legend = (met !== 'profit' ? '<span><i style="background:#265194"></i>Revenue</span>' : '') + (met !== 'rev' ? '<span><i style="background:#6AB3CD"></i>Profit</span>' : '') + (cmp && met !== 'profit' ? '<span><i style="background:#9AA8B6"></i>Previous period</span>' : '');
  return `<div class="a-rel"><svg id="anChart" viewBox="0 0 ${W} ${H}" onmousemove="anHover(event)" onmouseleave="anLeave()">${s}</svg><div id="anTip" class="a-tip"></div></div><div class="a-lg">${legend}</div>`;
}
function anHover(e) {
  const g = anCache?.geom, a = anCache?.a; if (!g || !a) return;
  const svg = e.currentTarget, r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * g.W;
  const i = Math.max(0, Math.min(a.N - 1, Math.round((px - g.L) / (g.W - g.L - g.R) * (a.N - 1))));
  const xh = document.getElementById('anXh'), tip = document.getElementById('anTip'); if (!xh || !tip) return;
  xh.setAttribute('x1', g.x(i)); xh.setAttribute('x2', g.x(i)); xh.style.display = 'block';
  tip.innerHTML = `<b>${anLabel(a.curDates[i])}</b>Revenue ${money(a.byD[i])}<br>Profit ${money(a.pf[i])}${anState.cmp ? `<br>Previous ${money(a.byDP[i])}` : ''}`;
  tip.style.display = 'block'; tip.style.left = (g.x(i) / g.W * r.width) + 'px'; tip.style.top = (g.y(a.byD[i]) / g.H * r.height) + 'px';
}
function anLeave() { const xh = document.getElementById('anXh'), tip = document.getElementById('anTip'); if (xh) xh.style.display = 'none'; if (tip) tip.style.display = 'none'; }
function anTopHTML(a) {
  const k = anState.tps, l = Object.values(a.pp).sort((x, y) => y[k] - x[k]).slice(0, 6), m = l[0] ? l[0][k] || 1 : 1;
  if (!l.length) return '<div class="d-empty"><strong>No sales yet</strong>Top products appear once sales are recorded.</div>';
  const f = v => k === 'u' ? v + ' units' : money(v);
  return l.map((p, i) => `<div class="a-rk"><div class="a-n">${i + 1}</div><div class="a-m"><b>${p.name}</b><div class="a-bar"><i style="width:${Math.max(p[k] / m * 100, 3)}%"></i></div></div><div class="a-v">${f(p[k])}<small>${k === 'rev' ? p.u + ' units' : money(p.rev) + ' revenue'}</small></div></div>`).join('');
}
function anDonutHTML(a) {
  const tot = Object.values(a.cat).reduce((s, v) => s + v.rev, 0) || 1, C = 2 * Math.PI * 60, ents = Object.entries(a.cat).sort((x, y) => y[1].rev - x[1].rev);
  let off = 0, s = '<circle cx="85" cy="85" r="60" fill="none" stroke="#E6EDF3" stroke-width="22"/>';
  ents.forEach(([k, v]) => { const f = v.rev / tot; s += `<circle cx="85" cy="85" r="60" fill="none" stroke="${anColor(k)}" stroke-width="22" stroke-dasharray="${f * C} ${C}" stroke-dashoffset="${-off * C}" transform="rotate(-90 85 85)"/>`; off += f; });
  s += `<text x="85" y="82" text-anchor="middle" font-size="11" fill="#7C8A99" font-weight="700">Total</text><text x="85" y="102" text-anchor="middle" font-size="16" font-weight="800" fill="#1E2A38">₱${anShort(a.rev)}</text>`;
  return `<svg viewBox="0 0 170 170">${s}</svg><div class="a-dl">${ents.map(([k, v]) => `<div><i style="background:${anColor(k)}"></i><span>${k}</span><b>${Math.round(v.rev / tot * 100)}%</b></div>`).join('')}</div>`;
}
function anHoursHTML(a) {
  const W = 560, H = 210, L = 40, B = 26, T = 10, hs = [...Array(15)].map((_, i) => 8 + i), mx = Math.max(...hs.map(h => a.hr[h] || 0), 1);
  const pk = hs.reduce((b, h) => (a.hr[h] || 0) > (a.hr[b] || 0) ? h : b, 8), bw = (W - L - 6) / hs.length, f = h => (h % 12 || 12) + (h < 12 ? 'a' : 'p');
  let s = ''; [0, .5, 1].forEach(g => { const yy = T + (1 - g) * (H - T - B); s += `<line x1="${L}" x2="${W - 6}" y1="${yy}" y2="${yy}" stroke="#E3EAF0"/><text x="${L - 6}" y="${yy + 4}" font-size="10" fill="#7C8A99" text-anchor="end">${anShort(mx * g)}</text>`; });
  hs.forEach((h, i) => { const v = a.hr[h] || 0, bh = v / mx * (H - T - B); s += `<rect x="${L + i * bw + 4}" y="${H - B - bh}" width="${bw - 8}" height="${bh}" rx="5" fill="${h === pk && v ? '#265194' : '#B9D6E6'}"><title>${f(h)}: ${money(v)}</title></rect><text x="${L + i * bw + bw / 2}" y="${H - 8}" font-size="10" fill="#7C8A99" text-anchor="middle">${f(h)}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}">${s}</svg>`;
}
function anPayHTML(a) {
  const tot = Object.values(a.pay).reduce((x, y) => x + y, 0), e = Object.entries(a.pay).sort((x, y) => y[1] - x[1]);
  if (!tot) return '<div class="d-empty"><strong>No payment data</strong>Payment methods appear once sales are recorded.</div>';
  return `<div class="a-pm">${e.map(([k, v]) => `<i style="width:${v / tot * 100}%;background:${(AN_PAY[k] || ['', '#9AA8B6'])[1]}"></i>`).join('')}</div><div class="a-pl">${e.map(([k, v]) => `<div><i style="background:${(AN_PAY[k] || ['', '#9AA8B6'])[1]}"></i><span>${(AN_PAY[k] || [k])[0]}</span><small>${Math.round(v / tot * 100)}%</small><b class="num">${money(v)}</b></div>`).join('')}</div>`;
}
function anTableHTML(a) {
  const tot = Object.values(a.cat).reduce((s, v) => s + v.rev, 0) || 1, ents = Object.entries(a.cat).sort((x, y) => y[1].rev - x[1].rev);
  if (!ents.length) return '<div class="d-empty"><strong>No sales yet</strong>Category performance appears once sales are recorded.</div>';
  return `<table class="s-table"><thead><tr><th>Category</th><th class="r">Units</th><th class="r">Revenue</th><th class="r">Profit</th><th class="r">Margin</th><th>Share</th></tr></thead><tbody>${ents.map(([k, v]) => { const m = v.rev ? v.pf / v.rev * 100 : 0;
    return `<tr><td><strong>${k}</strong></td><td class="num">${v.u}</td><td class="num">${money(v.rev)}</td><td class="num">${money(v.pf)}</td><td class="num"><span class="i-mg ${m < 30 ? 'w' : 'g'}">${m.toFixed(0)}%</span></td><td><div class="a-sh"><div class="a-t"><i style="width:${v.rev / tot * 100}%;background:${anColor(k)}"></i></div><b>${Math.round(v.rev / tot * 100)}%</b></div></td></tr>`; }).join('')}</tbody></table>`;
}
function anSegHTML(items, cur, fn) { return items.map(([v, l]) => `<button class="${String(cur) === String(v) ? 'on' : ''}" onclick="${fn}('${v}')">${l}</button>`).join(''); }
function setAnMetric(v) { anState.met = v; const set = (id, h) => { const el = document.getElementById(id); if (el) el.innerHTML = h; };
  set('anMetSeg', anSegHTML([['both', 'Both'], ['rev', 'Revenue'], ['profit', 'Profit']], v, 'setAnMetric')); set('anChartWrap', anChartHTML(anCache.a)); }
function toggleAnCompare(on) { anState.cmp = on; const el = document.getElementById('anChartWrap'); if (el) el.innerHTML = anChartHTML(anCache.a); }
function setAnTop(v) { anState.tps = v; const set = (id, h) => { const el = document.getElementById(id); if (el) el.innerHTML = h; };
  set('anTopSeg', anSegHTML([['rev', 'Revenue'], ['u', 'Units'], ['pf', 'Profit']], v, 'setAnTop')); set('anTop', anTopHTML(anCache.a)); }
function analyticsPage() {
  const a = anData(); anCache = { a };
  const N = a.N;
  return `
  <div class="page-head"><div><div class="eyebrow">INSIGHTS</div><h1>Analytics</h1><p>Understand sales performance, product demand, and category trends.</p></div>
    <div class="s-right"><div class="s-seg">${[7, 14, 30, 60].map(n => `<button class="${n === N ? 'on' : ''}" onclick="setAnalyticsRange(${n})">${n} days</button>`).join('')}</div>
    <button class="s-btn" onclick="exportAnalyticsCsv()">${dIcon('download')}Export CSV</button></div></div>
  <div class="sec grid g4">${anKpisHTML(a)}</div>
  <div class="a-ins">${anInsightsHTML(a)}</div>
  <div class="a-row"><div class="card d-anim" style="--i:4"><div class="a-hd"><div><h3>Revenue &amp; profit</h3><p>${anLabel(a.curDates[0])} – ${anLabel(a.curDates[N - 1])}</p></div>
    <div class="a-tools"><label class="a-tg"><input type="checkbox" ${anState.cmp ? 'checked' : ''} onchange="toggleAnCompare(this.checked)">Compare to previous period</label>
    <div class="s-seg sm" id="anMetSeg">${anSegHTML([['both', 'Both'], ['rev', 'Revenue'], ['profit', 'Profit']], anState.met, 'setAnMetric')}</div></div></div>
    <div id="anChartWrap">${anChartHTML(a)}</div></div></div>
  <div class="a-row a-r2"><div class="card d-anim" style="--i:5"><div class="a-hd"><div><h3>Top products</h3><p>Best sellers in this period</p></div><div class="s-seg sm" id="anTopSeg">${anSegHTML([['rev', 'Revenue'], ['u', 'Units'], ['pf', 'Profit']], anState.tps, 'setAnTop')}</div></div><div id="anTop">${anTopHTML(a)}</div></div>
    <div class="card d-anim" style="--i:6"><div class="a-hd"><div><h3>Sales by category</h3><p>Share of revenue</p></div></div><div class="a-dn">${anDonutHTML(a)}</div></div></div>
  <div class="a-row a-r2"><div class="card d-anim" style="--i:7"><div class="a-hd"><div><h3>Busiest hours</h3><p>Revenue by hour of day</p></div></div>${anHoursHTML(a)}</div>
    <div class="card d-anim" style="--i:8"><div class="a-hd"><div><h3>Payment methods</h3><p>How customers pay</p></div></div>${anPayHTML(a)}</div></div>
  <div class="a-row"><div class="card d-anim" style="--i:9"><div class="a-hd"><div><h3>Category performance</h3><p>Revenue, profit and margin by category</p></div></div><div class="tw">${anTableHTML(a)}</div></div></div>`;
}
async function exportAnalyticsCsv() {
  const a = anData(), esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['Date', 'Revenue', 'Profit', 'Previous period revenue'], ...a.curDates.map((d, i) => [d, a.byD[i].toFixed(2), a.pf[i].toFixed(2), a.byDP[i].toFixed(2)]),
    [], ['Category', 'Units', 'Revenue', 'Profit', 'Margin %'], ...Object.entries(a.cat).map(([k, v]) => [k, v.u, v.rev.toFixed(2), v.pf.toFixed(2), v.rev ? (v.pf / v.rev * 100).toFixed(1) : '0'])];
  const text = rows.map(r => r.map(esc).join(',')).join('\r\n');
  const filename = `salesync-analytics-${a.N}-days-${localISO(new Date())}.csv`;
  try {
    const downloads = await claude.use("downloads");
    if (downloads) { await downloads.save({ filename, data: text }); return; }
  } catch (e) { /* fall through to blob download */ }
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a'); el.href = url; el.download = filename; el.click();
  URL.revokeObjectURL(url);
}

// ---------- Reports page helpers (admin) ----------
const rpState = { tab: 'pl', cmp: true, day: 0 };
const RP_EXP_COLORS = ['#7B68C8', '#D9A63A', '#6AB3CD', '#D0687A', '#8A97A6', '#3FA382'];
const RP_TABS = [['pl', 'Profit & Loss', 'file'], ['daily', 'Daily sales', 'calendar'], ['inv', 'Inventory', 'box'], ['cat', 'Categories', 'percent']];
function rpBounds(from, to) { return [anDateStr(to - 1), anDateStr(from)]; }
function rpPL(from, to) {
  const [lo, hi] = rpBounds(from, to), rows = sales.filter(s => s.date >= lo && s.date <= hi);
  const R = rows.reduce((a, r) => a + r.total, 0), G = rows.reduce((a, r) => a + r.profit, 0), ex = {};
  expenseRows.filter(e => e.date >= lo && e.date <= hi).forEach(e => { ex[e.category] = (ex[e.category] || 0) + e.amount; });
  const E = Object.values(ex).reduce((a, b) => a + b, 0);
  return { R, C: R - G, G, ex, E, NP: G - E };
}
function rpChip(cur, prev, inverse) {
  if (!prev) return '';
  const p = (cur - prev) / Math.abs(prev) * 100, good = inverse ? p <= 0 : p >= 0;
  return `<span class="a-tr ${good ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(1)}%</span>`;
}
function rpKpisHTML(cards) {
  return `<div class="sec grid g4">${cards.map((c, i) => `<div class="card d-kpi d-anim" style="--i:${i}"><div><div class="l">${c[0]}</div><div class="v num">${c[1]}</div><div class="d">${c[2] || ''}</div></div><div class="d-kic ${c[3]}">${dIcon(c[4])}</div></div>`).join('')}</div>`;
}
function rpPLHTML() {
  const N = analyticsRangeDays, cur = rpPL(0, N), prv = rpPL(N, 2 * N), cmp = rpState.cmp;
  const cats = [...new Set([...Object.keys(cur.ex), ...Object.keys(prv.ex)])];
  const pct = v => cur.R ? (v / cur.R * 100).toFixed(1) : '0.0';
  const kp = rpKpisHTML([['Revenue', money(cur.R), rpChip(cur.R, prv.R) + 'vs previous', 't-navy', 'peso'], ['Gross profit', money(cur.G), pct(cur.G) + '% gross margin', 't-green', 'trend'],
    ['Operating expenses', money(cur.E), rpChip(cur.E, prv.E, true) + 'vs previous', 't-amber', 'wallet'], ['Net profit', money(cur.NP), pct(cur.NP) + '% net margin', cur.NP >= 0 ? 't-green' : 't-rose', 'file']]);
  const row = (label, a, b, o = {}) => {
    const ch = b ? (a - b) / Math.abs(b) * 100 : null, good = ch === null ? true : (o.inv ? ch <= 0 : ch >= 0);
    return `<tr class="${o.c || ''}"><td>${label}</td><td class="num ${o.neg ? 'r-neg' : ''}">${o.neg && a ? '-' : ''}${money(Math.abs(a))}</td><td class="num r-pct">${pct(Math.abs(a))}%</td>
      ${cmp ? `<td class="num">${o.neg && b ? '-' : ''}${money(Math.abs(b))}</td><td class="num">${ch === null ? '—' : `<span class="a-tr ${good ? 'up' : 'down'}">${ch >= 0 ? '▲ ' : '▼ '}${Math.abs(ch).toFixed(1)}%</span>`}</td>` : ''}</tr>`;
  };
  const stmt = row('Gross sales revenue', cur.R, prv.R) + row('Cost of goods sold', cur.C, prv.C, { neg: 1, inv: 1, c: 'r-ind' }) + row('Gross profit', cur.G, prv.G, { c: 'r-sub' })
    + (cats.length ? cats.map(k => row(k, cur.ex[k] || 0, prv.ex[k] || 0, { neg: 1, inv: 1, c: 'r-ind' })).join('') : `<tr class="r-ind"><td colspan="${cmp ? 5 : 3}">No expenses recorded in this period</td></tr>`)
    + row('Total operating expenses', cur.E, prv.E, { neg: 1, inv: 1, c: 'r-sub' }) + row('Net profit', cur.NP, prv.NP, { c: 'r-tot' });
  const segs = [['Cost of goods sold', cur.C, '#265194'], ...cats.map((k, i) => [k, cur.ex[k] || 0, RP_EXP_COLORS[i % RP_EXP_COLORS.length]]), ['Net profit', Math.max(cur.NP, 0), '#3FA382']];
  const flow = cur.R ? `<div class="r-flow">${segs.map(s => `<i style="width:${s[1] / cur.R * 100}%;background:${s[2]}" title="${s[0]}"></i>`).join('')}</div><div class="r-fl">${segs.map(s => `<div><i style="background:${s[2]}"></i><span>${s[0]}</span><small>${pct(s[1])}%</small><b class="num">${money(s[1])}</b></div>`).join('')}</div>`
    : '<div class="d-empty"><strong>No sales in this period</strong>The breakdown appears once sales are recorded.</div>';
  return kp + `<div class="r-two"><div class="card"><div class="a-hd"><div><h3>Profit &amp; Loss statement</h3><p>Last ${N} days${cmp ? ' vs the ' + N + ' days before' : ''}</p></div><button class="s-btn pri" type="button" onclick="openExpenseManager()">${dIcon('wallet')} Manage expenses</button></div>
    <div class="tw"><table class="s-table r-st"><thead><tr><th></th><th class="r">Amount</th><th class="r">% of revenue</th>${cmp ? '<th class="r">Previous</th><th class="r">Change</th>' : ''}</tr></thead><tbody>${stmt}</tbody></table></div>
    <div class="r-note">Expenses are counted on the date they were recorded.</div></div>
    <div class="card"><div class="a-hd"><div><h3>Where the money goes</h3><p>Every ₱100 of revenue</p></div></div>${flow}</div></div>`;
}
// ---------- Operating expense management ----------
let editingExpenseId = null;
function openExpenseManager() {
  if (currentUser?.role_name !== 'ADMIN') return;
  const modal = document.getElementById('expenseManagerModal');
  if (!modal) return;
  resetExpenseForm();
  renderExpenseManagerList();
  modal.hidden = false;
  document.body.classList.add('modal-open');
}
function closeExpenseManager() {
  const modal = document.getElementById('expenseManagerModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}
function resetExpenseForm() {
  editingExpenseId = null;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  set('expenseCategoryInput', ''); set('expenseDescriptionInput', ''); set('expenseAmountInput', ''); set('expenseDateInput', localISO(new Date()));
  const heading = document.getElementById('expenseEditorTitle'); if (heading) heading.textContent = 'Add an expense';
  const save = document.getElementById('expenseSaveBtn'); if (save) save.textContent = 'Add expense';
  const cancel = document.getElementById('expenseCancelEditBtn'); if (cancel) cancel.hidden = true;
  const feedback = document.getElementById('expenseFormFeedback'); if (feedback) { feedback.textContent = ''; feedback.className = 'expense-form-feedback'; }
}
function renderExpenseManagerList() {
  const host = document.getElementById('expenseManagerList');
  if (!host) return;
  const ordered = [...expenseRows].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  if (!ordered.length) {
    host.innerHTML = '<div class="d-empty"><strong>No expense records yet</strong>Add rent, electricity, internet, wages, or another operating expense above.</div>';
    return;
  }
  host.innerHTML = `<div class="tw expense-manager-table-wrap"><table class="s-table expense-manager-table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="r">Amount</th><th>Actions</th></tr></thead><tbody>${ordered.map(e => `<tr><td>${escapeHtml(e.date)}</td><td><strong>${escapeHtml(e.category)}</strong></td><td>${escapeHtml(e.description || '—')}</td><td class="num r-neg">${money(e.amount)}</td><td><div class="expense-row-actions"><button class="s-btn" type="button" onclick="editExpenseRecord(${Number(e.id)})">Edit</button><button class="s-btn hot" type="button" onclick="deleteExpenseRecord(${Number(e.id)})">Delete</button></div></td></tr>`).join('')}</tbody></table></div><p class="form-help">${ordered.length} expense record${ordered.length === 1 ? '' : 's'}. Each entry affects the Profit &amp; Loss period containing its date.</p>`;
}
function editExpenseRecord(id) {
  if (currentUser?.role_name !== 'ADMIN') return;
  const expense = expenseRows.find(e => Number(e.id) === Number(id));
  if (!expense) return;
  editingExpenseId = Number(id);
  const set = (field, value) => { const el = document.getElementById(field); if (el) el.value = value ?? ''; };
  set('expenseCategoryInput', expense.category); set('expenseDescriptionInput', expense.description); set('expenseAmountInput', Number(expense.amount).toFixed(2)); set('expenseDateInput', expense.date);
  const heading = document.getElementById('expenseEditorTitle'); if (heading) heading.textContent = `Edit expense #${expense.id}`;
  const save = document.getElementById('expenseSaveBtn'); if (save) save.textContent = 'Save changes';
  const cancel = document.getElementById('expenseCancelEditBtn'); if (cancel) cancel.hidden = false;
  const feedback = document.getElementById('expenseFormFeedback'); if (feedback) { feedback.textContent = 'Editing this record changes the report for its updated date. Add a separate entry for a new month to preserve previous months.'; feedback.className = 'expense-form-feedback'; }
  document.getElementById('expenseManagerModal')?.querySelector('.expense-manager-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function submitExpenseRecord() {
  if (currentUser?.role_name !== 'ADMIN') return;
  const category = document.getElementById('expenseCategoryInput')?.value.trim() || '';
  const description = document.getElementById('expenseDescriptionInput')?.value.trim() || '';
  const amountText = document.getElementById('expenseAmountInput')?.value || '';
  const amount = Number(amountText);
  const date = document.getElementById('expenseDateInput')?.value || '';
  const feedback = document.getElementById('expenseFormFeedback');
  if (!category) { if (feedback) { feedback.textContent = 'Enter an expense category.'; feedback.className = 'expense-form-feedback error'; } return; }
  if (!Number.isFinite(amount) || amount <= 0) { if (feedback) { feedback.textContent = 'Enter an amount greater than zero.'; feedback.className = 'expense-form-feedback error'; } return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date + 'T00:00:00').getTime())) { if (feedback) { feedback.textContent = 'Choose a valid expense date.'; feedback.className = 'expense-form-feedback error'; } return; }
  const payload = { category, description, amount: Math.round(amount * 100) / 100, date };
  const editing = Number.isInteger(editingExpenseId) && editingExpenseId > 0;
  const save = document.getElementById('expenseSaveBtn'); if (save) { save.disabled = true; save.textContent = editing ? 'Saving…' : 'Adding…'; }
  if (feedback) { feedback.textContent = ''; feedback.className = 'expense-form-feedback'; }
  try {
    await api(editing ? `/expenses/${editingExpenseId}` : '/expenses', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    await loadData();
    renderExpenseManagerList();
    render('reports');
    const modal = document.getElementById('expenseManagerModal'); if (modal) modal.hidden = false;
    document.body.classList.add('modal-open');
    resetExpenseForm();
    if (feedback) { feedback.textContent = editing ? 'Expense changes saved.' : 'Expense added. Profit & Loss has been updated.'; feedback.className = 'expense-form-feedback success'; }
    renderExpenseManagerList();
  } catch (err) {
    if (feedback) { feedback.textContent = `Could not save expense: ${err.message}`; feedback.className = 'expense-form-feedback error'; }
  } finally {
    const current = document.getElementById('expenseSaveBtn'); if (current) { current.disabled = false; current.textContent = editing ? 'Save changes' : 'Add expense'; }
  }
}
async function deleteExpenseRecord(id) {
  if (currentUser?.role_name !== 'ADMIN') return;
  const expense = expenseRows.find(e => Number(e.id) === Number(id));
  if (!expense) return;
  const confirmed = await showConfirmPopup(`Delete this expense record?\n\n${expense.date} · ${expense.category} · ${money(expense.amount)}\n\nThe Profit & Loss statement for this period will change. This cannot be undone from SaleSync.`, { title: 'Delete expense record?', okText: 'Delete expense', cancelText: 'Keep record', danger: true });
  if (!confirmed) return;
  try {
    await api(`/expenses/${Number(id)}`, { method: 'DELETE' });
    await loadData();
    render('reports');
    const modal = document.getElementById('expenseManagerModal'); if (modal) modal.hidden = false;
    document.body.classList.add('modal-open');
    renderExpenseManagerList();
    resetExpenseForm();
    const feedback = document.getElementById('expenseFormFeedback'); if (feedback) { feedback.textContent = 'Expense deleted. Profit & Loss has been updated.'; feedback.className = 'expense-form-feedback success'; }
  } catch (err) {
    const feedback = document.getElementById('expenseFormFeedback'); if (feedback) { feedback.textContent = `Could not delete expense: ${err.message}`; feedback.className = 'expense-form-feedback error'; }
  }
}

function rpDayData() {
  const ds = anDateStr(rpState.day), rows = sales.filter(s => s.date === ds), payOf = {};
  transactions.forEach(t => { payOf[t.id] = payClass(t.payMethod); });
  const items = {}, pay = {};
  rows.forEach(r => { const o = items[r.name] = items[r.name] || { q: 0, t: 0, p: 0 }; o.q += r.qty; o.t += r.total; o.p += r.profit; const m = payOf[r.transactionId]; if (m) pay[m] = (pay[m] || 0) + r.total; });
  return { ds, rows, items, pay, R: rows.reduce((a, r) => a + r.total, 0), G: rows.reduce((a, r) => a + r.profit, 0), tx: new Set(rows.map(r => r.transactionId)).size, units: rows.reduce((a, r) => a + r.qty, 0) };
}
function rpDailyHTML() {
  const d = rpDayData(), day = rpState.day, label = formatDateOnly(new Date(d.ds + 'T00:00:00')); 
  const list = Object.entries(d.items).sort((a, b) => b[1].t - a[1].t), pays = Object.entries(d.pay).sort((a, b) => b[1] - a[1]), ptot = pays.reduce((a, [, v]) => a + v, 0);
  return `<div class="r-dn"><div class="r-nav"><button onclick="setRpDay(${day + 1})" title="Previous day"><span class="r-flip">${dIcon('chevron')}</span></button><b>${day === 0 ? 'Today · ' : ''}${label}</b><button onclick="setRpDay(${day - 1})" ${day === 0 ? 'disabled' : ''} title="Next day">${dIcon('chevron')}</button></div>${day ? '<button class="s-btn" onclick="setRpDay(0)">Back to today</button>' : ''}</div>`
    + rpKpisHTML([['Revenue', money(d.R), '', 't-navy', 'peso'], ['Transactions', d.tx, '', 't-sky', 'receipt'], ['Items sold', d.units, '', 't-amber', 'bag'], ['Profit', money(d.G), '', 't-green', 'trend']])
    + `<div class="r-two"><div class="card"><div class="a-hd"><div><h3>Items sold</h3><p>${list.length} ${list.length === 1 ? 'product' : 'products'}</p></div></div>
      ${list.length ? `<div class="tw"><table class="s-table"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Total</th><th class="r">Profit</th></tr></thead><tbody>${list.map(([n, o]) => `<tr><td><strong>${n}</strong></td><td class="num">${o.q}</td><td class="num">${money(o.t)}</td><td class="num"><span class="s-prof">+${money(o.p)}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="d-empty"><span class="d-bubble">' + dIcon('receipt') + '</span><strong>No sales on this day</strong>Pick another day with the arrows.</div>'}</div>
      <div class="card"><div class="a-hd"><div><h3>Payment breakdown</h3><p>Cash drawer and other payments</p></div></div>
      ${ptot ? pays.map(([m, v]) => `<div class="r-pb"><i class="r-dot" style="background:${(AN_PAY[m] || ['', '#9AA8B6'])[1]}"></i><span>${(AN_PAY[m] || [m])[0]}</span><div class="r-t"><i style="width:${v / ptot * 100}%;background:${(AN_PAY[m] || ['', '#9AA8B6'])[1]}"></i></div><b class="num">${money(v)}</b></div>`).join('') : '<div class="d-empty"><strong>No payments</strong>Nothing to show for this day.</div>'}</div></div>`;
}
function rpInvHTML() {
  const g = {}; products.forEach(p => { const o = g[p.cat] = g[p.cat] || { n: 0, u: 0, c: 0, r: 0 }; o.n++; o.u += p.stock; o.c += p.stock * p.cost; o.r += p.stock * p.price; });
  const tc = products.reduce((a, p) => a + p.stock * p.cost, 0), tr = products.reduce((a, p) => a + p.stock * p.price, 0), need = lowStockList();
  return rpKpisHTML([['Stock value (cost)', money(tc), 'What you paid', 't-navy', 'box'], ['Stock value (retail)', money(tr), 'If all sold at price', 't-sky', 'peso'],
    ['Potential profit', money(tr - tc), (tr ? ((tr - tc) / tr * 100).toFixed(1) : '0.0') + '% margin', 't-green', 'trend'], ['Needs restocking', need.length, 'Low or out of stock', 't-amber', 'alert']])
    + `<div class="r-two"><div class="card"><div class="a-hd"><div><h3>Valuation by category</h3><p>Stock on hand today</p></div></div><div class="tw"><table class="s-table"><thead><tr><th>Category</th><th class="r">Products</th><th class="r">Units</th><th class="r">Value (cost)</th><th class="r">Value (retail)</th></tr></thead><tbody>
      ${Object.entries(g).map(([c, o]) => `<tr><td><strong>${c}</strong></td><td class="num">${o.n}</td><td class="num">${o.u}</td><td class="num">${money(o.c)}</td><td class="num">${money(o.r)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><div class="a-hd"><div><h3>Restock list</h3><p>Lowest stock first</p></div></div>
      ${need.length ? `<table class="s-table"><tbody>${need.map(p => `<tr><td><strong>${escapeHtml(p.name)}</strong></td><td class="num">${p.stock} left</td><td><span class="i-st ${p.stock === 0 ? 'out' : 'low'}">${p.stock === 0 ? 'Out' : 'Low'}</span></td></tr>`).join('')}</tbody></table>` : '<div class="d-empty"><strong>All stocked up</strong>Nothing needs restocking.</div>'}</div></div>`;
}
function rpCatData() {
  const N = analyticsRangeDays, [lo, hi] = rpBounds(0, N), [plo, phi] = rpBounds(N, 2 * N), g = {}, pg = {};
  sales.forEach(s => {
    if (s.date >= lo && s.date <= hi) { const o = g[s.cat] = g[s.cat] || { u: 0, r: 0, p: 0 }; o.u += s.qty; o.r += s.total; o.p += s.profit; }
    else if (s.date >= plo && s.date <= phi) pg[s.cat] = (pg[s.cat] || 0) + s.total;
  });
  return { g, pg, N };
}
function rpCatHTML() {
  const { g, pg, N } = rpCatData(), ents = Object.entries(g).sort((a, b) => b[1].r - a[1].r), tot = ents.reduce((a, [, o]) => a + o.r, 0) || 1;
  if (!ents.length) return `<div class="card"><div class="d-empty"><span class="d-bubble">${dIcon('percent')}</span><strong>No sales in this period</strong>Try a longer date range.</div></div>`;
  return `<div class="card"><div class="a-hd"><div><h3>Category performance</h3><p>Last ${N} days</p></div></div><div class="tw"><table class="s-table"><thead><tr><th>Category</th><th class="r">Units</th><th class="r">Revenue</th><th class="r">vs previous</th><th class="r">Profit</th><th class="r">Margin</th><th>Share</th></tr></thead><tbody>
    ${ents.map(([c, o]) => { const m = o.r ? o.p / o.r * 100 : 0; return `<tr><td><strong>${c}</strong></td><td class="num">${o.u}</td><td class="num">${money(o.r)}</td><td class="num">${rpChip(o.r, pg[c]) || '—'}</td><td class="num">${money(o.p)}</td><td class="num"><span class="i-mg ${m < 30 ? 'w' : 'g'}">${m.toFixed(0)}%</span></td>
      <td><div class="a-sh"><div class="a-t"><i style="width:${o.r / tot * 100}%;background:${anColor(c)}"></i></div><b>${Math.round(o.r / tot * 100)}%</b></div></td></tr>`; }).join('')}</tbody></table></div></div>`;
}
function rpBodyHTML() { return { pl: rpPLHTML, daily: rpDailyHTML, inv: rpInvHTML, cat: rpCatHTML }[rpState.tab](); }
function rpControlsHTML() {
  const usesRange = rpState.tab === 'pl' || rpState.tab === 'cat';
  return `<div class="s-seg r-tabs">${RP_TABS.map(([v, l, i]) => `<button class="${rpState.tab === v ? 'on' : ''}" onclick="setRpTab('${v}')">${dIcon(i)}${l}</button>`).join('')}</div>
    ${usesRange ? `<div class="s-seg">${[7, 14, 30, 60].map(n => `<button class="${n === analyticsRangeDays ? 'on' : ''}" onclick="setAnalyticsRange(${n}, 'reports')">${n} days</button>`).join('')}</div>` : ''}
    ${rpState.tab === 'pl' ? `<label class="a-tg"><input type="checkbox" ${rpState.cmp ? 'checked' : ''} onchange="toggleRpCompare(this.checked)">Compare to previous period</label>` : ''}
    <span class="r-gen">Generated ${formatDateTime(new Date())}</span>`;
}
function rpRefresh() { const c = document.getElementById('rpControls'), b = document.getElementById('rpBody'); if (c) c.innerHTML = rpControlsHTML(); if (b) b.innerHTML = rpBodyHTML(); }
function setRpTab(v) { rpState.tab = v; rpRefresh(); }
function toggleRpCompare(on) { rpState.cmp = on; rpRefresh(); }
function setRpDay(n) { rpState.day = Math.max(0, n); rpRefresh(); }
function reportsPage() {
  return `<div class="page-head"><div><div class="eyebrow">REPORTING</div><h1>Reports</h1><p>Financial and operational summaries for your store.</p></div>
    <div class="s-right"><button class="s-btn" onclick="exportReportCsv()">${dIcon('download')}Export CSV</button><button class="s-btn" onclick="window.print()">${dIcon('print')}Print</button></div></div>
  <div class="r-bar" id="rpControls">${rpControlsHTML()}</div><div id="rpBody">${rpBodyHTML()}</div>`;
}
async function exportReportCsv() {
  const N = analyticsRangeDays, t = rpState.tab; let name, rows;
  if (t === 'pl') {
    const cur = rpPL(0, N), prv = rpPL(N, 2 * N), cats = [...new Set([...Object.keys(cur.ex), ...Object.keys(prv.ex)])];
    name = `profit-and-loss-${N}-days`; rows = [['Line', 'Amount', 'Previous period'], ['Gross sales revenue', cur.R, prv.R], ['Cost of goods sold', cur.C, prv.C], ['Gross profit', cur.G, prv.G], ...cats.map(k => [k, cur.ex[k] || 0, prv.ex[k] || 0]), ['Total operating expenses', cur.E, prv.E], ['Net profit', cur.NP, prv.NP]].map((r, i) => i ? [r[0], Number(r[1]).toFixed(2), Number(r[2]).toFixed(2)] : r);
  } else if (t === 'daily') {
    const d = rpDayData(); name = `daily-sales-${d.ds}`; rows = [['Item', 'Qty', 'Total', 'Profit'], ...Object.entries(d.items).map(([n, o]) => [n, o.q, o.t.toFixed(2), o.p.toFixed(2)])];
  } else if (t === 'inv') {
    name = 'inventory-valuation'; rows = [['Product', 'Category', 'Stock', 'Cost', 'Price', 'Value (cost)', 'Value (retail)'], ...products.map(p => [p.name, p.cat, p.stock, p.cost.toFixed(2), p.price.toFixed(2), (p.stock * p.cost).toFixed(2), (p.stock * p.price).toFixed(2)])];
  } else {
    const { g } = rpCatData(); name = `category-performance-${N}-days`; rows = [['Category', 'Units', 'Revenue', 'Profit', 'Margin %'], ...Object.entries(g).map(([c, o]) => [c, o.u, o.r.toFixed(2), o.p.toFixed(2), o.r ? (o.p / o.r * 100).toFixed(1) : '0'])];
  }
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"', text = rows.map(r => r.map(esc).join(',')).join('\r\n'), filename = `salesync-${name}-${localISO(new Date())}.csv`;
  try {
    const downloads = await claude.use("downloads");
    if (downloads) { await downloads.save({ filename, data: text }); return; }
  } catch (e) { /* fall through to blob download */ }
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---------- Dashboard helpers ----------
function dIcon(name) {
  const u = `url('assets/icons/${name}.svg')`;
  return `<span class="d-icon" style="-webkit-mask-image:${u};mask-image:${u}"></span>`;
}
function dashGreeting() {
  const h = new Date().getHours();
  return (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', ' + (currentUser?.full_name || 'Admin');
}
function shortMoney(v) {
  return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(v));
}
function dashTrendChart() {
  const days = makeDateList(7);
  const vals = computeStats(7).salesByDay.map(d => d.rev);
  const W = 620, H = 230, L = 48, R = 14, T = 14, B = 30;
  const maxV = Math.max(...vals, 0);
  const pow = Math.pow(10, Math.floor(Math.log10(maxV || 1)));
  const top = maxV ? Math.ceil(maxV / pow) * pow : 100;
  const x = i => L + i * (W - L - R) / Math.max(vals.length - 1, 1);
  const y = v => T + (1 - v / top) * (H - T - B);
  const pts = vals.map((v, i) => [x(i), y(v)]);
  const line = pts.map(p => p.join(',')).join(' L');
  let svg = `<defs><linearGradient id="dashGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#265194" stop-opacity=".25"/><stop offset="1" stop-color="#265194" stop-opacity="0"/></linearGradient></defs>`;
  [0, top / 2, top].forEach(g => {
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" stroke="#E3EAF0"/><text x="${L - 8}" y="${y(g) + 4}" font-size="11" fill="#7C8A99" text-anchor="end">${shortMoney(g)}</text>`;
  });
  svg += `<path d="M${line} L${x(vals.length - 1)},${y(0)} L${x(0)},${y(0)}Z" fill="url(#dashGrad)"/><path d="M${line}" fill="none" stroke="#265194" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
  pts.forEach((p, i) => {
    const last = i === pts.length - 1;
    svg += `<circle cx="${p[0]}" cy="${p[1]}" r="${last ? 5 : 3.5}" fill="${last ? '#265194' : '#fff'}" stroke="#265194" stroke-width="2"><title>${days[i].toLocaleDateString([], { weekday: 'long' })}: ${money(vals[i])}</title></circle><text x="${p[0]}" y="${H - 8}" font-size="11" fill="#7C8A99" text-anchor="middle">${days[i].toLocaleDateString([], { weekday: 'short' })}</text>`;
  });
  if (!maxV) svg += `<text x="${W / 2}" y="${H / 2 - 10}" font-size="13" fill="#7C8A99" text-anchor="middle">No sales in the last 7 days</text>`;
  return `<svg class="d-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales for the last 7 days">${svg}</svg>`;
}
function dashTime(t) {
  const d = t.time instanceof Date ? t.time : new Date(t.time);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' · ';
}

function cashierTransactionRowsHTML() {
  const q = cashierReceiptQuery.trim().toLowerCase();
  const list = transactions.filter(t => !q || `${t.receiptNumber || ''} ${t.id} ${t.customerName || ''} ${t.customerEmail || ''} ${(t.lines || []).map(l => l.name).join(' ')}`.toLowerCase().includes(q));
  if (!list.length) return `<tr><td colspan="7" class="empty-state">No receipt matched “${escapeHtml(cashierReceiptQuery)}”. Check the receipt number or product name.</td></tr>`;
  return list.map(t => `<tr>
    <td><strong>${escapeHtml(t.receiptNumber || '#' + t.id)}</strong></td><td>${formatDateTime(t.time)}</td>
    <td>${(t.lines || []).map(l => l.qty + '× ' + escapeHtml(l.name)).join(', ')}</td>
    <td><span class="tag ${escapeHtml(t.payMethod)}">${payLabel(t.payMethod)}</span></td><td>${escapeHtml(t.voucher || '—')}</td>
    <td class="num"><strong>${money(t.total)}</strong>${t.returnedAmount > 0 ? `<small class="return-summary">Returns: ${money(t.returnedAmount)}</small>` : ''}</td>
    <td class="action-cell"><div class="sales-row-actions cashier-row-actions"><button class="btn secondary" onclick='showReceipt(transactions.find(x=>x.id===${t.id}), true)'>View receipt</button><button class="btn" ${t.canReturn ? '' : 'disabled'} onclick="openReturnModal(${t.id})">${t.canReturn ? 'Return / refund' : 'Returned'}</button></div></td>
  </tr>`).join('');
}
function setCashierReceiptQuery(value) {
  cashierReceiptQuery = String(value || '');
  const body = document.getElementById('cashierTransactionRows');
  if (body) body.innerHTML = cashierTransactionRowsHTML();
  const count = document.getElementById('cashierReceiptResultCount');
  if (count) {
    const q = cashierReceiptQuery.trim().toLowerCase();
    const n = transactions.filter(t => !q || `${t.receiptNumber || ''} ${t.id} ${t.customerName || ''} ${t.customerEmail || ''} ${(t.lines || []).map(l => l.name).join(' ')}`.toLowerCase().includes(q)).length;
    count.textContent = `${n} matching receipt${n === 1 ? '' : 's'} · ${transactions.length} available`;
  }
  const input = document.getElementById('cashierReceiptSearch');
  if (input && input.value !== cashierReceiptQuery) input.value = cashierReceiptQuery;
}

// ---------- Views ----------
const views = {
  adminDashboard() {
    const stats = computeStats();
    const week = computeStats(7).salesByDay;
    const todayTotal = stats.todayRows.reduce((a, r) => a + r.total, 0);
    const yesterday = week.length > 1 ? week[week.length - 2].rev : 0;
    const pct = yesterday ? ((todayTotal - yesterday) / yesterday) * 100 : null;
    const chip = pct === null ? '' : `<span class="d-trend ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span>vs yesterday`;
    const low = lowStockList();
    const dateText = formatDateOnly(new Date());
    const recent = transactions.slice(0, 5);
    const quick = (view, tint, icon, title, sub) => `<button class="d-quick" onclick="render('${view}')"><span class="d-qi ${tint}">${dIcon(icon)}</span><span class="d-qt"><strong>${title}</strong><span>${sub}</span></span><span class="d-go">${dIcon('arrow')}</span></button>`;
    return `
    <div class="page-head"><div><div class="eyebrow">ADMIN</div><h1>${dashGreeting()}</h1><p>${dateText}</p></div><span class="period-pill">Today</span></div>
    <div class="sec grid g4">
      <div class="card d-kpi d-anim" style="--i:0"><div><div class="l">Today's sales</div><div class="v num">${money(todayTotal)}</div><div class="d">${chip || stats.todayTxCount + ' transactions'}</div></div><div class="d-kic t-navy">${dIcon('peso')}</div></div>
      <div class="card d-kpi d-anim" style="--i:1"><div><div class="l">Items sold today</div><div class="v num">${stats.todayRows.reduce((a, r) => a + r.qty, 0)}</div><div class="d">Across ${stats.todayTxCount} ${stats.todayTxCount === 1 ? 'transaction' : 'transactions'}</div></div><div class="d-kic t-sky">${dIcon('bag')}</div></div>
      <div class="card d-kpi d-anim" style="--i:2"><div><div class="l">Low-stock products</div><div class="v num">${stats.lowStockCount}</div><div class="d">${stats.lowStockCount ? 'Need attention' : 'Stock levels look good'}</div></div><div class="d-kic ${stats.lowStockCount ? 't-amber' : 't-sky'}">${dIcon('alert')}</div></div>
      <div class="card d-kpi d-anim" style="--i:3"><div><div class="l">Products</div><div class="v num">${products.length}</div><div class="d">Active products</div></div><div class="d-kic t-navy">${dIcon('box')}</div></div>
    </div>
    <div class="sec d-row d-r1">
      <div class="card d-anim" style="--i:4"><div class="section-head"><div><h2>Sales trend</h2><span class="section-meta">Last 7 days</span></div><button class="link-btn" onclick="render('analytics')">View analytics</button></div>${dashTrendChart()}</div>
      <div class="card d-anim" style="--i:5"><div class="section-head"><div><h2>Recent sales</h2><span class="section-meta">Latest completed transactions</span></div><button class="link-btn" onclick="render('history')">View all</button></div>
        ${recent.length ? recent.map(t => `<div class="d-sale"><span class="d-sic">${dIcon('receipt')}</span><div class="d-sm"><strong>${escapeHtml(t.receiptNumber || '#' + t.id)}</strong><span>${dashTime(t)}${payLabel(t.payMethod)}</span></div><strong class="num">${money(t.total)}</strong></div>`).join('') : `<div class="d-empty"><span class="d-bubble">${dIcon('receipt')}</span><strong>No sales yet</strong>Completed sales will show up here.</div>`}
      </div>
    </div>
    <div class="sec d-row d-r2">
      <div class="card d-anim" style="--i:6"><div class="section-head"><div><h2>Quick access</h2><span class="section-meta">Common admin tasks</span></div></div><div class="d-qgrid">
        ${quick('inventory', 't-navy', 'stocks', 'Central stock', 'Check product quantities')}
        ${quick('products', 't-sky', 'tag', 'Products', 'Update details and prices')}
        ${quick('history', 't-sky', 'receipt', 'Transactions', 'Sales and receipts')}
        ${quick('reports', 't-navy', 'chart', 'Reports', 'Financial summaries')}
      </div></div>
      <div class="card d-anim" style="--i:7"><div class="section-head"><div><h2>Need attention</h2><span class="section-meta">Low-stock products</span></div><button class="link-btn" onclick="render('inventory')">View stock</button></div>
        ${low.length ? low.slice(0, 5).map(p => { const w = Math.max(6, Math.min(100, (p.stock / ((p.reorder || 1) * 2)) * 100)); return `<div class="d-att"><div class="d-an"><strong>${escapeHtml(p.name)}</strong><div class="d-bar"><i style="width:${w}%"></i></div></div><span class="d-ac">${p.stock === 0 ? 'Out of stock' : p.stock + ' left'}</span><button class="d-add" onclick="restockProduct('${p.id}')">Add stock</button></div>`; }).join('') : '<div class="d-empty"><strong>All stocked up</strong>Nothing needs attention right now.</div>'}
      </div>
    </div>`;
  },
  checkout() {
    const cartCount = cart.reduce((a, l) => a + l.qty, 0);
    return `
    <div class="page-head checkout-head">
      <div>
        <div class="eyebrow">PHYSICAL STORE</div>
        <h1>Checkout</h1>
        <p>Ring up customer purchases at the front counter.</p>
      </div>
      <div class="register-status"><span class="status-dot"></span><span>Register open</span><strong>Front counter</strong></div>
    </div>

    <div class="sec grid pos-layout">
      <section class="card pos-products">
        <div id="posBrowseMode">
          <div class="section-head">
            <div><h2>Products</h2><span class="section-meta">${products.length} products available</span></div>
            <div class="search-wrap checkout-search"><span class="search-icon">⌕</span><input id="posSearchInput" aria-label="Search products by name, ID, or barcode" placeholder="Search name, ID, or barcode" value="${escapeHtml(posQuery)}" oninput="setPosQuery(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();lookupAndAddProduct(this.value)}"><button type="button" class="scan-btn" onclick="openBarcodeScanner()" title="Scan QR code or barcode" aria-label="Scan QR code or barcode"><svg class="scan-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6 9v6m3-6v6m3-6v6m3-6v6m3-6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Scan</span></button></div>
          </div>
          <div class="pos-cats" id="posCats">${catButtonsHTML()}</div>
          <div class="pos-grid" id="posGrid">${posItemsHTML(filteredProducts())}</div>
        </div>
        <div id="posScanMode" class="pos-scan-mode" hidden>
          <div class="section-head scan-mode-head"><div><h2>Scan Mode</h2><span class="section-meta">Scan multiple items; Current Sale stays visible on the right.</span></div><button class="s-btn" type="button" onclick="closeBarcodeScanner()">Back to products</button></div>
          <div class="scanner-live-wrap"><video id="barcodeVideo" class="barcode-video" autoplay playsinline muted hidden></video><div class="scanner-placeholder" id="scannerPlaceholder"><span class="scanner-placeholder-icon">▥</span><strong>Camera preview</strong><span>Allow access when your browser asks.</span></div></div>
          <div id="scannerMessage" class="scanner-message">Scan Mode is ready. Camera will start when this mode opens; manual entry also works.</div>
          <form class="scan-manual-form" onsubmit="event.preventDefault(); submitScannerManual()"><label>Enter QR content, barcode, or Product ID<input id="scannerManualCode" maxlength="500" autocomplete="off" placeholder="Scan or type code here"><span class="form-help">Press Enter to add the product. After a scan, SaleSync remains ready for the next product.</span></label><button class="btn" type="submit">Add item</button></form>
          <div class="scan-mode-tip">Tip: when using a printed label, scan it from another screen or print it. A camera cannot scan the image displayed on the same screen it is using.</div>
        </div>
      </section>

      <section class="card pos-cart">
        <div class="section-head cart-head">
          <div><h2>Current sale</h2><span class="section-meta"><span id="cartCountLabel">${cartCount}</span> ${cartCount === 1 ? 'item' : 'items'}</span></div>
          <button class="ghost-btn" onclick="clearCart()" ${cart.length ? '' : 'disabled'}>Clear</button>
        </div>
        <div class="pos-lines" id="posLines">${cartLinesHTML()}</div>
        <div id="posTotals">${totalsHTML()}</div>
        <div class="pos-voucher">
          <label for="voucherInput" class="field-label">Discount code</label>
          <div class="inline-field">
            <input id="voucherInput" placeholder="Enter code">
            <button class="btn secondary" onclick="applyVoucher()">Apply</button>
          </div>
          <div id="voucherApplied">${voucherChipHTML()}</div>
        </div>
        <div class="payment-section">
          <div class="field-label">Payment method</div>
          <div class="pos-pay" id="posPay">${payButtonsHTML()}</div>
          <div id="posCashRow">${cashRowHTML()}</div>
        </div>
        <button class="btn checkout-btn" id="checkoutBtn" onclick="finalizeSale()">Charge ${cart.length ? money(cartTotals().total) : ''}</button>
        <div class="checkout-hint">Complete the sale to update inventory and sales records.</div>
      </section>
    </div>`;
  },
  history() {
    if (currentUser?.role_name === 'ADMIN') return salesPage('history');
    return `
    ${salesSubnav('history')}
    <div class="page-head"><div><div class="eyebrow">SALES</div><h1>Transaction history</h1><p>Completed checkout transactions and their receipt details.</p></div></div>
    <div class="card">
      <div class="section-head table-head"><div><h2>Find a customer's receipt</h2><span class="section-meta">Search by receipt number or product to start a return/refund.</span></div></div>
      <div class="cashier-receipt-search"><div class="search-wrap compact-search"><span class="search-icon">⌕</span><input id="cashierReceiptSearch" type="search" placeholder="Enter receipt number or product name" aria-label="Search customer's receipt" value="${escapeHtml(cashierReceiptQuery)}" oninput="setCashierReceiptQuery(this.value)"></div><button class="s-btn" type="button" onclick="setCashierReceiptQuery('')">Clear search</button></div>
      <div class="section-head table-head"><div><h2>Transactions</h2><span class="section-meta" id="cashierReceiptResultCount">${transactions.length} receipts loaded</span></div></div>
      <div class="tw"><table class="cashier-transactions-table"><thead><tr><th>Receipt #</th><th>Time</th><th>Items</th><th>Payment</th><th>Voucher</th><th class="num r">Total</th><th>Actions</th></tr></thead><tbody id="cashierTransactionRows">${cashierTransactionRowsHTML()}</tbody></table></div>
    </div>`;
  },
  analytics() {
    return analyticsPage();
  },
  inventory() {
    if (currentUser?.role_name === 'ADMIN') return inventoryPage('inventory');
    const rows = products.map(p => {
      const status = p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok';
      return `<tr><td><strong>${escapeHtml(p.name)}</strong></td><td>${escapeHtml(p.cat)}</td><td class="num stock-value">${p.stock}</td><td class="num"><strong>${money(p.price)}</strong></td><td><span class="tag ${status}">${status === 'ok' ? 'In stock' : status === 'low' ? 'Low stock' : 'Out of stock'}</span></td>${currentUser?.role_name === 'ADMIN' ? `<td class="action-cell"><button class="btn secondary" onclick="restockProduct('${p.id}')">Add stock</button></td>` : ''}</tr>`;
    }).join('');
    return `
    ${inventorySubnav('inventory')}
    <div class="page-head"><div><div class="eyebrow">INVENTORY</div><h1>Central stock</h1><p>One stock view for products sold in-store and through e-commerce.</p></div></div>
    <div class="card">
      <div class="toolbar table-toolbar"><div><h2>Stock inventory</h2><span class="section-meta">${products.length} products</span></div><div class="search-wrap compact-search"><span class="search-icon">⌕</span><input placeholder="Search product" aria-label="Search inventory" oninput="filterInv(this.value)"></div></div>
      <div class="tw"><table id="invTable"><thead><tr><th>Product</th><th>Category</th><th>Current stock</th><th>Price</th><th>Status</th>${currentUser?.role_name === 'ADMIN' ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  },
  ledger() {
    return salesPage('ledger');
  },
  products() {
    return inventoryPage('products');
    const rows = products.map(p => {
      const status = p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok';
      return `<tr data-product-row="${p.productId}"><td class="num">${p.productId}</td><td><strong>${escapeHtml(p.name)}</strong></td>
        <td><select id="product-category-${p.productId}">${CATS.map(c => `<option value="${categoryIdByName[c]}" ${c === p.cat ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select></td>
        <td><input id="product-cost-${p.productId}" class="num compact-input" type="number" min="0" step="0.01" value="${p.cost}" aria-label="Cost"></td>
        <td><input id="product-price-${p.productId}" class="num compact-input" type="number" min="0" step="0.01" value="${p.price}" aria-label="Price"></td>
        <td><input id="product-reorder-${p.productId}" class="num compact-input" type="number" min="0" step="1" value="${p.reorder}" aria-label="Low-stock warning level"></td>
        <td class="num">${p.stock}</td><td><span class="tag ${status}">${status === 'ok' ? 'In stock' : status === 'low' ? 'Low stock' : 'Out of stock'}</span></td>
        <td class="action-cell"><button class="btn secondary" onclick="saveProductRow(${p.productId})">Save</button></td></tr>`;
    }).join('');
    return `
    ${inventorySubnav('products')}
    <div class="page-head"><div><div class="eyebrow">INVENTORY</div><h1>Product management</h1><p>Update product details and the low-stock warning. Current stock is managed in Central stock.</p></div><button class="btn" onclick="addProduct()">+ Add product</button></div>
    <div class="card">
      <div class="toolbar table-toolbar"><div><h2>Products</h2><span class="section-meta">Cost is your buying cost; price is what the customer pays.</span></div><div class="search-wrap compact-search"><span class="search-icon">⌕</span><input placeholder="Search product" aria-label="Search products" oninput="filterProducts(this.value)"></div></div>
      <div class="tw"><table id="productTable"><thead><tr><th>Product ID</th><th>Product</th><th>Category</th><th>Cost</th><th>Price</th><th>Low-stock warning at</th><th>Current stock</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="table-footnote">The low-stock warning appears when current stock reaches the number set for that product. Zero means out of stock.</div>
    </div>`;
  },
  settings() {
    const s = appSettings;
    const check = (id, label, checked, help = '') => `<label class="settings-check"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}><span><strong>${label}</strong>${help ? `<small>${help}</small>` : ''}</span></label>`;
    return `<div class="page-head"><div><div class="eyebrow">ADMINISTRATION</div><h1>Settings</h1><p>Adjust SaleSync to match your store as it grows. Saved changes are applied to the connected features.</p></div><div class="s-right"><button class="s-btn" type="button" onclick="exportSettingsJson()">Export settings</button></div></div>
      <div class="settings-page">
        <section class="card settings-card"><div class="a-hd"><div><h3>Store information</h3><p>Shown on receipts and selected system areas.</p></div></div><div class="settings-grid">
          <label>Store name<input id="setStoreName" maxlength="100" value="${escapeHtml(s.storeName)}" required></label>
          <label>Contact number<input id="setStorePhone" maxlength="40" value="${escapeHtml(s.storePhone)}" placeholder="Optional"></label>
          <label>Email address<input id="setStoreEmail" type="email" maxlength="150" value="${escapeHtml(s.storeEmail)}" placeholder="Optional"></label>
          <label>Store address<input id="setStoreAddress" maxlength="255" value="${escapeHtml(s.storeAddress)}" placeholder="Optional"></label>
          <label class="settings-full">Receipt footer<input id="setReceiptFooter" maxlength="255" value="${escapeHtml(s.receiptFooter)}" placeholder="Thank you for shopping!"></label>
        </div></section>
        <section class="card settings-card"><div class="a-hd"><div><h3>General preferences</h3><p>Control how prices and dates appear on screen and receipts.</p></div></div><div class="settings-grid">
          <label>Currency symbol<select id="setCurrencySymbol">${[['₱','Philippine peso (₱)'],['$','Dollar ($)'],['€','Euro (€)'],['£','Pound (£)'],['¥','Yen/Yuan (¥)']].map(([v,l])=>`<option value="${v}" ${s.currencySymbol===v?'selected':''}>${l}</option>`).join('')}</select></label>
          <label>Date format<select id="setDateFormat">${[['DD MMM YYYY','09 Oct 2026'],['DD/MM/YYYY','09/10/2026'],['MM/DD/YYYY','10/09/2026'],['YYYY-MM-DD','2026-10-09']].map(([v,l])=>`<option value="${v}" ${s.dateFormat===v?'selected':''}>${l}</option>`).join('')}</select></label>
          <label>Timezone<select id="setTimezone">${[['Asia/Manila','Philippines (Asia/Manila)'],['Asia/Singapore','Singapore (Asia/Singapore)'],['UTC','UTC'],['America/Los_Angeles','US Pacific (America/Los_Angeles)'],['America/New_York','US Eastern (America/New_York)'],['Europe/London','United Kingdom (Europe/London)']].map(([v,l])=>`<option value="${v}" ${s.timezone===v?'selected':''}>${l}</option>`).join('')}</select><small>Used when displaying transaction timestamps.</small></label>
        </div></section>
        <section class="card settings-card"><div class="a-hd"><div><h3>Inventory, barcode & receipts</h3><p>Defaults apply to newly generated values; existing product barcodes and receipts are not rewritten.</p></div></div><div class="settings-grid">
          <label>Default low-stock warning<input id="setDefaultLowStock" type="number" min="0" max="100000" step="1" value="${s.defaultLowStockThreshold}" required><small>Used as the starting warning level for new products.</small></label>
          <label>New barcode prefix<input id="setBarcodePrefix" maxlength="10" pattern="[A-Za-z0-9-]{1,10}" value="${escapeHtml(s.barcodePrefix)}" required><small>Letters, numbers and hyphens only. Existing labels remain unchanged.</small></label>
          <label>Receipt numbering prefix<input id="setReceiptPrefix" maxlength="12" pattern="[A-Za-z0-9-]{1,12}" value="${escapeHtml(s.receiptPrefix)}" required><small>Applies to future transactions only.</small></label>
        </div></section>
        <section class="card settings-card"><div class="a-hd"><div><h3>Checkout & returns</h3><p>Control which payment options are offered and how long a sale remains eligible for return.</p></div></div><div class="settings-grid">
          <label>Return period (days)<input id="setReturnWindow" type="number" min="0" max="3650" step="1" value="${s.returnWindowDays}" required><small>Use 0 to allow returns without a time limit.</small></label>
          <div class="settings-checks"><strong>Payment methods available to cashiers</strong>${check('setEnableCash','Cash',s.enableCash)}${check('setEnableCard','Card',s.enableCard)}${check('setEnableOnline','Online / PayMongo',s.enableOnline,'Online remains subject to the current provider/demo configuration.')}</div>
          <div class="settings-checks"><strong>Refund options</strong>${check('setDefaultReturnRestock','Default returned items to sellable stock',s.defaultReturnRestock,'Cashiers can still untick this for damaged or opened products.')}${check('setAllowStoreCredit','Allow store-credit refunds',s.allowStoreCreditRefund)}${check('setAllowOriginalRefund','Allow original-method refund records',s.allowOriginalMethodRefund,'Provider refunds may still require manual processing.')}</div>
        </div></section>
        <section class="card settings-card"><div class="a-hd"><div><h3>Account security</h3><p>Change the password for the currently signed-in administrator.</p></div></div><div class="settings-grid settings-password-grid">
          <label>Current password<input id="setCurrentPassword" type="password" autocomplete="current-password" maxlength="128" required></label>
          <label>New password<input id="setNewPassword" type="password" autocomplete="new-password" maxlength="128" minlength="8" required><small>Use at least 8 characters.</small></label>
          <label>Confirm new password<input id="setConfirmPassword" type="password" autocomplete="new-password" maxlength="128" minlength="8" required></label>
          <div class="settings-password-action"><span id="passwordFeedback" role="status" aria-live="polite"></span><button type="button" class="s-btn" id="changePasswordBtn" onclick="changeAdminPassword()">Change password</button></div>
        </div></section>
        <div class="settings-savebar"><span id="settingsFeedback" role="status" aria-live="polite"></span><button type="button" class="s-btn" onclick="render('settings')">Discard changes</button><button type="button" class="btn" id="settingsSaveBtn" onclick="saveSettings()">Save settings</button></div>
      </div>`;
  },
  reports() {
    return reportsPage();
  }
};

async function saveSettings() {
  if (currentUser?.role_name !== 'ADMIN') return;
  const val = id => document.getElementById(id)?.value ?? '';
  const checked = id => !!document.getElementById(id)?.checked;
  const payload = {
    storeName: val('setStoreName').trim(), storeAddress: val('setStoreAddress').trim(), storePhone: val('setStorePhone').trim(),
    storeEmail: val('setStoreEmail').trim(), receiptFooter: val('setReceiptFooter').trim(), currencySymbol: val('setCurrencySymbol'),
    dateFormat: val('setDateFormat'), timezone: val('setTimezone'), defaultLowStockThreshold: Number(val('setDefaultLowStock')),
    barcodePrefix: val('setBarcodePrefix').trim().toUpperCase(), receiptPrefix: val('setReceiptPrefix').trim().toUpperCase(),
    returnWindowDays: Number(val('setReturnWindow')), defaultReturnRestock: checked('setDefaultReturnRestock'),
    enableCash: checked('setEnableCash'), enableCard: checked('setEnableCard'), enableOnline: checked('setEnableOnline'),
    allowStoreCreditRefund: checked('setAllowStoreCredit'), allowOriginalMethodRefund: checked('setAllowOriginalRefund')
  };
  const feedback = document.getElementById('settingsFeedback'), btn = document.getElementById('settingsSaveBtn');
  if (!payload.storeName) { if (feedback) feedback.textContent = 'Store name is required.'; return; }
  if (!payload.enableCash && !payload.enableCard && !payload.enableOnline) { if (feedback) feedback.textContent = 'Enable at least one payment method.'; return; }
  if (!/^[A-Z0-9-]{1,10}$/.test(payload.barcodePrefix)) { if (feedback) feedback.textContent = 'Barcode prefix must contain only letters, numbers, or hyphens (max 10).'; return; }
  if (!/^[A-Z0-9-]{1,12}$/.test(payload.receiptPrefix)) { if (feedback) feedback.textContent = 'Receipt prefix must contain only letters, numbers, or hyphens (max 12).'; return; }
  if (!Number.isInteger(payload.defaultLowStockThreshold) || payload.defaultLowStockThreshold < 0 || payload.defaultLowStockThreshold > 100000 || !Number.isInteger(payload.returnWindowDays) || payload.returnWindowDays < 0 || payload.returnWindowDays > 3650) { if (feedback) feedback.textContent = 'Check the threshold and return-period values.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  if (feedback) feedback.textContent = '';
  try {
    const result = await api('/settings', { method: 'PUT', body: JSON.stringify(payload) });
    appSettings = normalizeSettings(result.settings || payload);
    if (!({ cash: appSettings.enableCash, card: appSettings.enableCard, paymongo: appSettings.enableOnline })[payMethod]) payMethod = appSettings.enableCash ? 'cash' : appSettings.enableCard ? 'card' : 'paymongo';
    await loadData();
    render('settings');
    const msg = document.getElementById('settingsFeedback'); if (msg) msg.textContent = 'Settings saved.';
  } catch (err) {
    if (feedback) feedback.textContent = `Could not save settings: ${err.message}`;
  } finally {
    const save = document.getElementById('settingsSaveBtn'); if (save) { save.disabled = false; save.textContent = 'Save settings'; }
  }
}
async function changeAdminPassword() {
  if (currentUser?.role_name !== 'ADMIN') return;
  const currentPassword = document.getElementById('setCurrentPassword')?.value || '';
  const newPassword = document.getElementById('setNewPassword')?.value || '';
  const confirmPassword = document.getElementById('setConfirmPassword')?.value || '';
  const feedback = document.getElementById('passwordFeedback');
  const button = document.getElementById('changePasswordBtn');
  if (!currentPassword) { if (feedback) feedback.textContent = 'Enter your current password.'; return; }
  if (newPassword.length < 8) { if (feedback) feedback.textContent = 'New password must be at least 8 characters.'; return; }
  if (newPassword !== confirmPassword) { if (feedback) feedback.textContent = 'The new passwords do not match.'; return; }
  if (button) { button.disabled = true; button.textContent = 'Updating…'; }
  if (feedback) feedback.textContent = '';
  try {
    await api('/account/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
    ['setCurrentPassword','setNewPassword','setConfirmPassword'].forEach(id => { const field = document.getElementById(id); if (field) field.value = ''; });
    if (feedback) feedback.textContent = 'Password updated successfully.';
  } catch (err) {
    if (feedback) feedback.textContent = `Could not change password: ${err.message}`;
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Change password'; }
  }
}

function exportSettingsJson() {
  if (currentUser?.role_name !== 'ADMIN') return;
  const payload = { exportedAt: new Date().toISOString(), application: 'SaleSync', settings: appSettings };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `salesync-settings-${localISO(new Date())}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveProductRow(productId) {
  const categoryId = Number(document.getElementById(`product-category-${productId}`)?.value);
  const costPrice = Number(document.getElementById(`product-cost-${productId}`)?.value);
  const sellingPrice = Number(document.getElementById(`product-price-${productId}`)?.value);
  const reorderPoint = Number(document.getElementById(`product-reorder-${productId}`)?.value);
  const barcode = document.getElementById(`product-barcode-${productId}`)?.value.trim() || null;
  const product = products.find(p => p.productId === productId);
  if (!product) return;
  try {
    await api(`/products/${productId}`, {
      method: 'PUT',
      body: JSON.stringify({ categoryId, costPrice, sellingPrice, reorderPoint, barcode })
    });
    delete invState.drafts[productId];
    invState.savedId = productId;
    await loadData();
    render('products');
    setTimeout(() => { invState.savedId = null; document.getElementById('inv-ok-' + productId)?.remove(); }, 2200);
  } catch (err) {
    showPopup(`Could not save product: ${err.message}`, { title: 'Could not save product', type: 'error' });
  }
}

function addProduct() {
  if (!CATS.length) return showPopup('No active product categories are available.', { title: 'No categories available', type: 'warning' });
  const modal = document.getElementById('addProductModal');
  const category = document.getElementById('addProductCategory');
  const error = document.getElementById('addProductError');
  if (!modal || !category) return;
  category.innerHTML = CATS.map(c => `<option value="${categoryIdByName[c]}">${escapeHtml(c)}</option>`).join('');
  const form = document.getElementById('addProductForm');
  if (form) form.reset();
  category.value = String(categoryIdByName[CATS[0]]);
  if (document.getElementById('addProductWarning')) document.getElementById('addProductWarning').value = String(appSettings.defaultLowStockThreshold ?? 10);
  if (document.getElementById('addProductStock')) document.getElementById('addProductStock').value = 0;
  if (error) { error.hidden = true; error.textContent = ''; }
  const submitBtn = document.getElementById('addProductSubmit');
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add product'; }
  modal.hidden = false;
  document.body.classList.add('modal-open');
  setTimeout(() => document.getElementById('addProductName')?.focus(), 0);
}
function closeAddProduct() {
  const modal = document.getElementById('addProductModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}
async function submitAddProduct() {
  const productName = document.getElementById('addProductName')?.value.trim() || '';
  const categoryId = Number(document.getElementById('addProductCategory')?.value || 0);
  const costPrice = Number(document.getElementById('addProductCost')?.value);
  const sellingPrice = Number(document.getElementById('addProductPrice')?.value);
  const warningLevel = Number(document.getElementById('addProductWarning')?.value);
  const openingStock = Number(document.getElementById('addProductStock')?.value);
  const barcode = document.getElementById('addProductBarcode')?.value.trim() || null;
  const error = document.getElementById('addProductError');
  const submitBtn = document.getElementById('addProductSubmit');
  const showError = (msg) => { if (error) { error.textContent = msg; error.hidden = false; } };
  if (!productName) return showError('Please enter a product name.');
  if (!categoryId) return showError('Please choose a category.');
  if ([costPrice, sellingPrice, warningLevel, openingStock].some(n => !Number.isFinite(n) || n < 0)) {
    return showError('Please enter valid non-negative numbers.');
  }
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding…'; }
  if (error) error.hidden = true;
  try {
    await api('/products', {
      method: 'POST',
      body: JSON.stringify({ productName, categoryId, costPrice, sellingPrice, reorderPoint: warningLevel, openingStock, barcode })
    });
    await loadData();
    closeAddProduct();
    render('products');
  } catch (err) {
    showError(`Could not add product: ${err.message}`);
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add product'; }
  }
}

// ---------- Category management (admin) ----------
function openCategoryManager() {
  if (currentUser?.role_name !== 'ADMIN') return;
  const modal = document.getElementById('categoryManagerModal');
  const input = document.getElementById('newCategoryName');
  const error = document.getElementById('categoryManagerError');
  if (input) input.value = '';
  if (error) { error.hidden = true; error.textContent = ''; }
  if (modal) { modal.hidden = false; document.body.classList.add('modal-open'); }
  loadCategoryManagement();
  setTimeout(() => input?.focus(), 0);
}
function closeCategoryManager() {
  const modal = document.getElementById('categoryManagerModal'); if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}
async function loadCategoryManagement() {
  const list = document.getElementById('categoryManagerList');
  if (!list) return;
  list.innerHTML = '<div class="d-empty">Loading categories…</div>';
  try {
    const data = await api('/categories'); categoryManageRows = data.categories || [];
    list.innerHTML = categoryManageRows.map(c => `<div class="category-manage-row"><div class="category-manage-name"><strong>${escapeHtml(c.name)}</strong><span>${c.activeProducts} active product${c.activeProducts === 1 ? '' : 's'}</span></div><span class="tag ${c.active ? 'ok' : 'out'}">${c.active ? 'Active' : 'Inactive'}</span><button class="s-btn ${c.active ? '' : 'pri'}" ${!c.active && c.activeProducts ? 'disabled' : ''} onclick="toggleCategory(${c.id}, ${!c.active})">${c.active ? 'Deactivate' : 'Reactivate'}</button></div>`).join('') || '<div class="d-empty">No categories yet.</div>';
  } catch (err) { list.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`; }
}
async function submitNewCategory() {
  if (currentUser?.role_name !== 'ADMIN') return;
  const input = document.getElementById('newCategoryName');
  const error = document.getElementById('categoryManagerError');
  const button = document.getElementById('addCategorySubmit');
  const name = input?.value.trim() || '';
  if (!name) { if (error) { error.textContent = 'Enter a category name.'; error.hidden = false; } return; }
  if (button) { button.disabled = true; button.textContent = 'Adding…'; }
  if (error) error.hidden = true;
  try {
    await api('/categories', { method: 'POST', body: JSON.stringify({ name }) });
    await loadData();
    if (salesState.category !== 'all' && !new Set([...CATS, ...sales.map(row => row.cat).filter(Boolean)]).has(salesState.category)) salesState.category = 'all';
    await loadCategoryManagement();
    if (input) input.value = '';
    render('products');
    const modal = document.getElementById('categoryManagerModal'); if (modal) modal.hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => document.getElementById('newCategoryName')?.focus(), 0);
  } catch (err) { if (error) { error.textContent = err.message; error.hidden = false; } }
  finally { if (button) { button.disabled = false; button.textContent = 'Add category'; } }
}
async function toggleCategory(id, active) {
  try {
    await api(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
    await loadData(); await loadCategoryManagement();
    if (document.getElementById('salesCategoryFilter')) document.getElementById('salesCategoryFilter').innerHTML = salesCategoryHTML();
    render('products');
    const modal = document.getElementById('categoryManagerModal'); if (modal) modal.hidden = false;
    document.body.classList.add('modal-open');
  } catch (err) { showPopup(err.message, { title: 'Category update failed', type: 'error' }); }
}

// ---------- Return / refund workflow (cashier and admin) ----------
function closeReturnModal() {
  const modal = document.getElementById('returnModal'); if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
  returnState = { transactionId: null, data: null };
}
async function openReturnModal(transactionId) {
  if (!['ADMIN','CASHIER'].includes(currentUser?.role_name)) return;
  returnState = { transactionId: Number(transactionId), data: null };
  const modal = document.getElementById('returnModal');
  const items = document.getElementById('returnItems');
  const reason = document.getElementById('returnReason');
  const error = document.getElementById('returnError');
  const submit = document.getElementById('returnSubmit');
  if (!modal || !items) return;
  modal.hidden = false; document.body.classList.add('modal-open');
  items.innerHTML = '<div class="d-empty">Loading receipt items…</div>';
  if (reason) reason.value = '';
  if (error) { error.hidden = true; error.textContent = ''; }
  if (submit) { submit.disabled = false; submit.textContent = 'Record return / refund'; }
  try {
    const data = await api(`/transactions/${transactionId}/returnable`);
    returnState.data = data;
    const receipt = document.getElementById('returnReceiptNumber');
    if (receipt) receipt.textContent = `${data.transaction.receiptNumber} · Original total ${money(data.transaction.total)}`;
    const methodSelect = document.getElementById('returnRefundMethod');
    if (methodSelect) { methodSelect.innerHTML = `<option value="CASH">Cash</option>${appSettings.allowStoreCreditRefund ? '<option value="STORE_CREDIT">Store credit</option>' : ''}${appSettings.allowOriginalMethodRefund ? '<option value="ORIGINAL_METHOD">Original payment method (manual/provider processing)</option>' : ''}`; }
    items.innerHTML = data.items.map(item => `<div class="return-item-row">
      <div class="return-item-title"><strong>${escapeHtml(item.name)}</strong><span>Sold ${item.soldQuantity} · Already returned ${item.returnedQuantity} · Available to return ${item.returnableQuantity}</span><small>Original line amount: ${money(item.lineTotal)}</small></div>
      <label class="return-qty-field">Qty<input class="return-qty" data-return-qty="${item.saleItemId}" type="number" min="0" max="${item.returnableQuantity}" step="1" value="0" ${item.returnableQuantity === 0 ? 'disabled' : ''} oninput="updateReturnEstimate()"></label>
      <label class="return-restock-field"><input type="checkbox" data-return-restock="${item.saleItemId}" ${appSettings.defaultReturnRestock ? 'checked' : ''} ${item.returnableQuantity === 0 ? 'disabled' : ''}> Back to sellable stock</label>
    </div>`).join('') || '<div class="d-empty">No items on this receipt.</div>';
    updateReturnEstimate();
  } catch (err) {
    items.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
}
function getSelectedReturnItems() {
  if (!returnState.data) return [];
  return returnState.data.items.map(item => {
    const input = document.querySelector(`[data-return-qty="${item.saleItemId}"]`);
    const qty = Number(input?.value || 0);
    const restock = !!document.querySelector(`[data-return-restock="${item.saleItemId}"]`)?.checked;
    return { saleItemId: item.saleItemId, quantity: qty, restock };
  }).filter(item => item.quantity > 0);
}
function updateReturnEstimate() {
  const data = returnState.data;
  if (!data) return;
  const chosen = getSelectedReturnItems();
  const allLineTotal = data.items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0) || 1;
  let estimated = 0;
  chosen.forEach(chosenItem => {
    const item = data.items.find(row => row.saleItemId === chosenItem.saleItemId);
    if (!item) return;
    const qty = Math.min(Math.max(0, Math.floor(chosenItem.quantity)), item.returnableQuantity);
    const net = Number(item.lineTotal || 0) * qty / Math.max(1, item.soldQuantity);
    const tax = Number(data.transaction.tax || 0) * (Number(item.lineTotal || 0) / allLineTotal) * qty / Math.max(1, item.soldQuantity);
    estimated += Math.round((net + tax) * 100) / 100;
  });
  const total = document.getElementById('returnEstimatedTotal'); if (total) total.textContent = money(estimated);
}
async function submitReturn() {
  const error = document.getElementById('returnError');
  const button = document.getElementById('returnSubmit');
  const reason = document.getElementById('returnReason')?.value.trim() || '';
  const refundMethod = document.getElementById('returnRefundMethod')?.value || 'CASH';
  const items = getSelectedReturnItems();
  const showError = message => { if (error) { error.textContent = message; error.hidden = false; } };
  if (!returnState.transactionId || !returnState.data) return showError('The receipt data has not loaded. Close this window and try again.');
  if (!items.length) return showError('Choose at least one item and enter a return quantity.');
  if (!reason) return showError('Enter a reason for the return.');
  for (const selected of items) {
    const item = returnState.data.items.find(row => row.saleItemId === selected.saleItemId);
    if (!item || !Number.isInteger(selected.quantity) || selected.quantity < 1 || selected.quantity > item.returnableQuantity) return showError('Check each return quantity. It cannot exceed the remaining quantity on the original receipt.');
  }
  if (button) { button.disabled = true; button.textContent = 'Saving return…'; }
  if (error) error.hidden = true;
  try {
    const response = await api(`/transactions/${returnState.transactionId}/returns`, {
      method: 'POST', body: JSON.stringify({ items, reason, refundMethod })
    });
    const result = response.return;
    closeReturnModal();
    await loadData();
    render('history');
    const statusNote = result.refundStatus === 'PENDING_PROVIDER' ? '\n\nThe refund is recorded as pending. It has not been sent to the card/online provider automatically.' : '';
    showPopup(`Return number: ${result.returnNumber}\nRefund amount: ${money(result.refundAmount)}${statusNote}`, { title: 'Return / refund recorded', type: 'success', okText: 'Done' });
  } catch (err) {
    showError(err.message);
    if (button) { button.disabled = false; button.textContent = 'Record return / refund'; }
  }
}

function filterInv(q) {
  q = q.toLowerCase();
  document.querySelectorAll('#invTable tbody tr').forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
function filterProducts(q) {
  q = q.toLowerCase();
  document.querySelectorAll('#productTable tbody tr').forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

let charts = [];
function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }
function drawDashboardCharts() {
  const stats = computeStats(analyticsRangeDays);
  const axis = { ticks: { color: getComputedStyle(document.body).getPropertyValue('--sub') }, grid: { color: getComputedStyle(document.body).getPropertyValue('--line') } };
  const periodSales = stats.currentRows;
  charts.push(new Chart(document.getElementById('trendChart'), {
    type: 'line', data: {
      labels: stats.salesByDay.map(d => d.date), datasets: [
        { label: 'Revenue', data: stats.salesByDay.map(d => d.rev), borderColor: '#265194', backgroundColor: '#26519422', tension: .3, fill: true },
        { label: 'Profit', data: stats.salesByDay.map(d => d.profit), borderColor: '#6AB3CD', backgroundColor: '#6AB3CD22', tension: .3, fill: true }
      ]
    }, options: { plugins: { legend: { labels: { color: axis.ticks.color } } }, scales: { x: axis, y: axis } }
  }));
  charts.push(new Chart(document.getElementById('topChart'), { type: 'bar', data: { labels: stats.topProducts.map(p => p.name.split(' ').slice(0, 2).join(' ')), datasets: [{ label: 'Revenue', data: stats.topProducts.map(p => +p.rev.toFixed(2)), backgroundColor: '#265194' }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: axis, y: axis } } }));
  charts.push(new Chart(document.getElementById('catChart'), { type: 'bar', data: { labels: CATS, datasets: [{ label: 'Revenue', data: CATS.map(c => +periodSales.filter(s => s.cat === c).reduce((a, r) => a + r.total, 0).toFixed(2)), backgroundColor: '#6AB3CD' }] }, options: { plugins: { legend: { display: false } }, scales: { x: axis, y: axis } } }));
}

const navDefsAdmin = [
  ["dashboard", "Dashboard", "dashboard", "dashboard.svg"],
  ["history", "Sales", "sales", "sales.svg"],
  ["inventory", "Inventory", "inventory", "inventory.svg"],
  ["analytics", "Analytics", "analytics", "analytics.svg"],
  ["reports", "Reports", "reports", "reports.svg"],
  ["settings", "Settings", "settings", "settings.svg"]
];
const navDefsCashier = [
  ["checkout", "Checkout", "checkout"],
  ["history", "Sales", "sales"]
];
const navGroup = { dashboard: "dashboard", checkout: "checkout", history: "sales", ledger: "sales", inventory: "inventory", products: "inventory", analytics: "analytics", reports: "reports", settings: "settings" };

function visibleViewsForRole() {
  return currentUser?.role_name === 'ADMIN'
    ? ['dashboard', 'history', 'inventory', 'products', 'ledger', 'analytics', 'reports', 'settings']
    : ['checkout', 'history'];
}

function inventorySubnav(active) {
  return `<div class="subnav"><span class="subnav-label">Inventory</span><button class="${active === 'inventory' ? 'on' : ''}" onclick="render('inventory')">Central stock</button><button class="${active === 'products' ? 'on' : ''}" onclick="render('products')">Products</button></div>`;
}

function salesSubnav(active) {
  const ledger = currentUser?.role_name === 'ADMIN' ? `<button class="${active === 'ledger' ? 'on' : ''}" onclick="render('ledger')">Daily sales</button>` : '';
  return `<div class="subnav"><span class="subnav-label">Sales</span><button class="${active === 'history' ? 'on' : ''}" onclick="render('history')">Transactions</button>${ledger}</div>`;
}

function updateUserHeader() {
  const chip = document.getElementById('userChip');
  if (!chip || !currentUser) return;
  chip.innerHTML = `<div class="user-name">${currentUser.full_name}</div><span class="role-pill">${currentUser.role_name === 'ADMIN' ? 'Admin' : 'Cashier'}</span>`;
  const badge = document.getElementById('stockAlertBadge');
  const count = lowStockList().length;
  if (badge) { badge.textContent = count; badge.hidden = count === 0; }
  const inventoryBtn = document.getElementById('viewInventoryBtn');
  if (inventoryBtn) inventoryBtn.hidden = currentUser?.role_name !== 'ADMIN';
}

function showAppShell(show) {
  const shell = document.getElementById('appShell');
  const login = document.getElementById('loginScreen');
  if (shell) shell.hidden = !show;
  if (login) login.hidden = show;
}

function loginView(error = '') {
  return `<div class="login-shell"><div class="login-card">
    <div class="login-brand"><img src="assets/img/logo-mark.png" class="brand-mark" alt="">Sale<span>Sync</span></div>
    <div class="eyebrow">STORE POINT OF SALE</div>
    <h1>Sign in</h1>
    <p class="login-copy">Use your account to open the tools available to your role.</p>
    ${error ? `<div class="login-error">${error}</div>` : ''}
    <form onsubmit="event.preventDefault(); submitLogin()">
      <label>Username<input id="loginUsername" autocomplete="username" placeholder="Enter username" required></label>
      <label>Password<input id="loginPassword" type="password" autocomplete="current-password" placeholder="Enter password" required></label>
      <button class="btn login-btn" type="submit">Sign in</button>
    </form>
    <div class="demo-login"><strong>Demo accounts</strong><span>Admin: <code>admin</code> / <code>admin123</code></span><span>Cashier: <code>cashier</code> / <code>cashier123</code></span></div>
  </div></div>`;
}

async function submitLogin() {
  const username = document.getElementById('loginUsername')?.value.trim() || '';
  const password = document.getElementById('loginPassword')?.value || '';
  const btn = document.querySelector('.login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  try {
    const result = await api('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    currentUser = result.user;
    showAppShell(true);
    await loadData();
    render(currentUser.role_name === 'ADMIN' ? 'dashboard' : 'checkout');
    if (lowStockList().length) setTimeout(openLowStockPopup, 250);
  } catch (err) {
    document.getElementById('loginScreen').innerHTML = loginView(err.message);
  } finally {
    const loginBtn = document.querySelector('.login-btn');
    if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign in'; }
  }
}

function openLogoutConfirm() {
  const modal = document.getElementById('logoutModal');
  if (!modal) return;
  modal.hidden = false;
  document.body.classList.add('modal-open');
}
function closeLogoutConfirm() {
  const modal = document.getElementById('logoutModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}
async function confirmLogout() {
  closeLogoutConfirm();
  try { await api('/logout', { method: 'POST' }); } catch (_) {}
  currentUser = null;
  cart = []; voucher = null;
  closeLowStockPopup();
  closeRestockModal();
  destroyCharts();
  document.body.classList.remove('checkout-mode', 'role-admin');
  showAppShell(false);
  location.replace('login.html');
}

async function logout() {
  openLogoutConfirm();
}

function openLowStockPopup() {
  const low = lowStockList();
  const body = document.getElementById('lowStockModalBody');
  const modal = document.getElementById('lowStockModal');
  if (!body || !modal) return;
  if (!low.length) {
    body.innerHTML = `<div class="empty-state modal-empty">All product stock levels are okay right now.</div>`;
  } else {
    const out = low.filter(p => p.stock === 0);
    const lowOnly = low.filter(p => p.stock > 0);
    body.innerHTML = `${out.length ? `<div class="notice-block danger"><strong>${out.length} product${out.length === 1 ? '' : 's'} out of stock</strong><span>These products cannot be sold until stock is added.</span></div>` : ''}${lowOnly.length ? `<div class="notice-block warning"><strong>${lowOnly.length} product${lowOnly.length === 1 ? '' : 's'} running low</strong><span>The warning appears because stock has reached the product's warning level.</span></div>` : ''}<div class="low-stock-list">${low.map(p => `<div class="low-stock-row"><div><strong>${escapeHtml(p.name)}</strong><span>${p.cat}</span></div><div class="stock-state ${p.stock === 0 ? 'out' : 'low'}">${p.stock === 0 ? 'Out of stock' : `${p.stock} left`}</div></div>`).join('')}</div>`;
  }
  modal.hidden = false;
  document.body.classList.add('modal-open');
}
function closeLowStockPopup() {
  const modal = document.getElementById('lowStockModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function syncSidebarToggle() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebarToggle');
  if (btn && sidebar) btn.classList.toggle('active', !sidebar.classList.contains('collapsed'));
}
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed');
  syncSidebarToggle();
}

function render(tab) {
  const allowed = visibleViewsForRole();
  if (!(tab in views) || !allowed.includes(tab)) tab = currentUser?.role_name === 'ADMIN' ? 'dashboard' : 'checkout';
  const activeGroup = navGroup[tab] || 'checkout';
  const defs = currentUser?.role_name === 'ADMIN' ? navDefsAdmin : navDefsCashier;
  const isAdmin = currentUser?.role_name === 'ADMIN';
  document.body.classList.toggle('role-admin', isAdmin);
  const navHtml = defs.map(([id, label, group, icon]) => `<button class="${group === activeGroup ? 'on' : ''}" title="${label}" onclick="render('${id}')">${icon ? `<span class="nav-icon" style="-webkit-mask-image:url('assets/icons/${icon}');mask-image:url('assets/icons/${icon}')"></span>` : ''}<span class="nav-label">${label}</span></button>`).join('');
  const nav = document.getElementById('nav');
  if (nav) nav.innerHTML = isAdmin ? '' : navHtml;
  const sidebarNav = document.getElementById('sidebarNav');
  if (sidebarNav) sidebarNav.innerHTML = isAdmin ? navHtml : '';
  updateUserHeader();
  syncSidebarToggle();
  destroyCharts();
  document.body.classList.toggle('checkout-mode', tab === 'checkout');
  document.getElementById('main').innerHTML = views[tab === 'dashboard' ? 'adminDashboard' : tab]();
  history.replaceState(null, '', '#' + tab);
}

function showStartupProblem(title, message) {
  // Do not redirect to the login page on data-loading errors. If the session is
  // still valid, login.html will redirect straight back here and cause a loop.
  showAppShell(false);
  const screen = document.getElementById('loginScreen');
  if (!screen) return;
  screen.hidden = false;
  screen.classList.add('startup-problem');
  screen.innerHTML = `
    <section class="startup-problem-card" role="alert" aria-live="polite">
      <div class="startup-problem-mark" aria-hidden="true">!</div>
      <p class="eyebrow">SALESYNC</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message || 'Please check that Apache, MySQL, and the SaleSync database are available.')}</p>
      <div class="startup-problem-actions">
        <button class="btn" type="button" onclick="startApp()">Retry</button>
        <button class="btn secondary" type="button" onclick="location.href='login.html'">Return to sign in</button>
      </div>
      <p class="startup-problem-help">If this keeps happening, open <code>http://localhost/SaleSync/api/index.php?route=health</code> and check the error reported by the API.</p>
    </section>`;
}

async function startApp() {
  const screen = document.getElementById('loginScreen');
  if (screen) { screen.classList.remove('startup-problem'); screen.innerHTML = ''; }

  let me;
  try {
    me = await api('/me');
  } catch (_) {
    showStartupProblem('Cannot connect to SaleSync', 'The server did not respond. Start Apache and MySQL in XAMPP, then retry.');
    return;
  }

  // Only a confirmed unauthenticated response should send the user to login.
  if (!me || me.authenticated !== true || !me.user) {
    location.replace('login.html');
    return;
  }

  currentUser = me.user;
  showAppShell(true);
  try {
    await loadData();
    const hash = location.hash.slice(1);
    const defaultTab = currentUser.role_name === 'ADMIN' ? 'dashboard' : 'checkout';
    render(visibleViewsForRole().includes(hash) ? hash : defaultTab);
    if (lowStockList().length) setTimeout(openLowStockPopup, 250);
  } catch (err) {
    destroyCharts();
    showStartupProblem('SaleSync could not load its data', 'Your sign-in session is still active, but the database data could not be loaded. Check the combined salesync_database.sql import and API errors, then click Retry.');
  }
}
startApp();
