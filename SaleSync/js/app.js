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
const today = new Date();
const DATA_DAYS = 90;
let analyticsRangeDays = 14;
function makeDateList(count, end = today) {
  return [...Array(count)].map((_, i) => { const d = new Date(end); d.setHours(0,0,0,0); d.setDate(d.getDate() - (count - 1 - i)); return d; });
}
const days = makeDateList(DATA_DAYS);

function fmtDate(d) { return new Date(d).toISOString().slice(0, 10); }
const money = n => "₱" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  expenseRows = (data.expenseRows || []).map(e => ({ category: e.category, amount: Number(e.amount || 0), date: e.date }));
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
  return products.filter(p => (posCat === "All" || p.cat === posCat) && (p.name.toLowerCase().includes(q) || p.cat.toLowerCase().includes(q)));
}
function catButtonsHTML() {
  return ["All", ...CATS].map(c => `<button class="postab ${c === posCat ? 'on' : ''}" onclick="setPosCat('${c}')">${c}</button>`).join('');
}
function posItemsHTML(list) {
  if (!list.length) return `<div class="pos-empty">No products match.</div>`;
  return list.map(p => {
    const status = p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok';
    const inCart = cart.find(l => l.id === p.id);
    const disabled = p.stock === 0 || (inCart && inCart.qty >= p.stock);
    return `<button class="pos-item" ${disabled ? 'disabled' : ''} onclick="addToCart('${p.id}')">
      ${status !== 'ok' ? `<span class="pi-badge ${status}">${status === 'out' ? 'OUT' : p.stock + ' LEFT'}</span>` : ''}
      <div class="pi-name">${p.name}</div>
      <div class="pi-cat">${p.cat}</div>
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
      <div class="pl-name">${l.name}<div class="pl-sub">${money(l.price)} each</div></div>
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
  return `<button class="${payMethod === 'cash' ? 'on' : ''}" onclick="setPay('cash')">Cash</button><button class="${payMethod === 'card' ? 'on' : ''}" onclick="setPay('card')">Card</button><button class="${payMethod === 'paymongo' ? 'on' : ''}" onclick="setPay('paymongo')">Online</button>`;
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
function setPosCat(c) { posCat = c; document.getElementById('posCats').innerHTML = catButtonsHTML(); document.getElementById('posGrid').innerHTML = posItemsHTML(filteredProducts()); }
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
    alert(`${code} requires a minimum purchase of ${money(v.minimumPurchase)}.`);
  } else {
    voucher = null;
    alert('Invalid or inactive voucher code.');
  }
  refreshCartPanel();
}

function removeVoucher() { voucher = null; refreshCartPanel(); }
function setPay(m) { payMethod = m; refreshCartPanel(); }

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
    alert(`Cash received must be at least ${money(total)}.`);
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
    alert(`Could not complete the sale: ${err.message}`);
    checkoutBtnState();
  }
}
function payLabel(m) { return m === 'paymongo' ? 'ONLINE PAYMENT' : m.toUpperCase(); }
function receiptHTML(tx) {
  return `
    <h3>SaleSync</h3>
    <div class="pr-sub">Receipt #${tx.receiptNumber || tx.id} · ${tx.time.toLocaleString()}</div>
    ${tx.lines.map(l => `<div class="pr-line"><span>${l.qty}× ${l.name}</span><span>${money(l.lineTotal)}</span></div>`).join('')}
    <hr>
    <div class="pr-line"><span>Subtotal</span><span>${money(tx.subtotal)}</span></div>
    ${tx.discount > 0 ? `<div class="pr-line"><span>Discount${tx.voucher ? ' (' + tx.voucher + ')' : ''}</span><span>-${money(tx.discount)}</span></div>` : ''}
    <div class="pr-line"><span>VAT (12%)</span><span>${money(tx.tax)}</span></div>
    <div class="pr-line" style="font-weight:700"><span>TOTAL</span><span>${money(tx.total)}</span></div>
    <hr>
    <div class="pr-line"><span>Paid via</span><span>${payLabel(tx.payMethod)}</span></div>
    ${tx.payMethod === 'cash' ? `<div class="pr-line"><span>Tendered</span><span>${money(tx.cashGiven)}</span></div><div class="pr-line"><span>Change</span><span>${money(tx.change)}</span></div>` : ''}`;
}
function receiptText(tx) {
  let l = ["SALESYNC", `Receipt #${tx.receiptNumber || tx.id}`, tx.time.toLocaleString(), '------------------------'];
  tx.lines.forEach(i => l.push(`${i.qty}x ${i.name}  ${money(i.lineTotal)}`));
  l.push('------------------------');
  l.push(`Subtotal  ${money(tx.subtotal)}`);
  if (tx.discount > 0) l.push(`Discount  -${money(tx.discount)}`);
  l.push(`VAT 12%   ${money(tx.tax)}`);
  l.push(`TOTAL     ${money(tx.total)}`);
  l.push('------------------------');
  l.push(`Paid via  ${payLabel(tx.payMethod)}`);
  if (tx.payMethod === 'cash') { l.push(`Tendered  ${money(tx.cashGiven)}`); l.push(`Change    ${money(tx.change)}`); }
  l.push('Thank you!');
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
    alert(err.message);
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
const salesState = { tab: 'history', pay: 'all', range: 7, page: 1, q: '', open: new Set(), opened: false };
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
  const cut = salesCutoff(), q = salesState.q, payOf = {};
  transactions.forEach(t => { payOf[t.id] = t.payMethod; });
  return sales.filter(s => (!cut || s.date >= cut) && (salesState.pay === 'all' || payOf[s.transactionId] === salesState.pay)
    && (!q || ((s.receiptNumber || '') + ' ' + s.name).toLowerCase().includes(q)));
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
        <td>${t.time.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
        <td>${first}${more > 0 ? ` <span class="s-more">+${more} more</span>` : ''}</td>
        <td><span class="s-pay p-${payClass(t.payMethod)}">${payShort(t.payMethod)}</span></td><td>${t.voucher || '—'}</td>
        <td class="num"><strong>${money(t.total)}</strong></td>
        <td class="action-cell"><button class="s-btn" onclick='showReceipt(transactions.find(x=>x.id===${t.id}), true)'>${dIcon('eye')}Receipt</button></td></tr>`; }).join('')}
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
    const label = (isToday ? 'Today · ' : '') + d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    return `<div class="s-day ${salesState.open.has(date) ? 'open' : ''}"><button class="s-dh" onclick="toggleSalesDay('${date}')"><span class="s-ch">${dIcon('chevron')}</span>
      <span class="s-dd"><span class="d-sic">${dIcon('calendar')}</span><span><b>${label}</b><small>${tcount} ${tcount === 1 ? 'transaction' : 'transactions'} · ${n} items</small></span></span>
      <span class="s-prof">+${money(pr)} · ${tot ? Math.round(pr / tot * 100) : 0}%</span><span class="s-tot num">${money(tot)}</span></button>
      <div class="s-db"><div class="tw"><table class="s-table"><thead><tr><th>Receipt</th><th>Product</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total</th><th class="r">Profit</th></tr></thead><tbody>
      ${list.map(r => `<tr><td>${r.receiptNumber || '#' + r.transactionId}</td><td><strong>${r.name}</strong></td><td class="num">${r.qty}</td><td class="num">${money(r.price)}</td><td class="num"><strong>${money(r.total)}</strong></td><td class="num"><span class="s-prof">+${money(r.profit)}</span></td></tr>`).join('')}
      </tbody></table></div></div></div>`;
  }).join('');
}
function refreshSales() {
  const c = salesChipsHTML();
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  set('salesPayChips', c.pay); set('salesRangeChips', c.rng); set('salesKpis', salesKpisHTML()); set('salesBody', salesBodyHTML());
}
function setSalesPay(v) { salesState.pay = v; salesState.page = 1; refreshSales(); }
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
    rows = filteredTx().map(t => [t.receiptNumber || t.id, t.time.toLocaleString(), t.lines.map(l => l.qty + 'x ' + l.name).join('; '), payShort(t.payMethod), t.voucher || '', t.total.toFixed(2)]);
  } else {
    head = ['Date', 'Receipt', 'Product', 'Qty', 'Price', 'Total', 'Profit'];
    rows = filteredEntries().map(r => [r.date, r.receiptNumber || r.transactionId, r.name, r.qty, r.price.toFixed(2), r.total.toFixed(2), r.profit.toFixed(2)]);
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
  return products.filter(p => (!invState.q || p.name.toLowerCase().includes(invState.q)) && (invState.status === 'all' || invStatus(p) === invState.status) && (invState.cat === 'all' || p.cat === invState.cat))
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
  const catBadge = p => `<span class="i-cat k${Math.max(CATS.indexOf(p.cat), 0) % 6}">${p.cat}</span>`;
  let head, trs;
  if (invState.tab === 'inventory') {
    head = `<tr>${invTh('name', 'Product')}${invTh('cat', 'Category')}${invTh('stock', 'Stock')}${invTh('price', 'Price', true)}<th>Status</th><th></th></tr>`;
    trs = rows.map(p => { const st = invStatus(p), w = Math.min(100, p.stock / ((p.reorder || 1) * 3) * 100);
      return `<tr class="${st === 'out' ? 'i-outrow' : ''}"><td><div class="s-rc"><span class="d-sic">${dIcon('box')}</span>${p.name}</div></td><td>${catBadge(p)}</td>
        <td><div class="i-sb"><b class="num">${p.stock}</b><div class="i-trk"><i class="f-${st}" style="width:${st === 'out' ? 0 : Math.max(w, 4)}%"></i></div></div></td>
        <td class="num"><strong>${money(p.price)}</strong></td><td><span class="i-st ${st}">${INV_LABEL[st]}</span></td>
        <td class="action-cell"><button class="s-btn ${st === 'out' ? 'hot' : ''}" onclick="restockProduct('${p.id}')">${st === 'out' ? 'Restock now' : 'Add stock'}</button></td></tr>`; }).join('');
  } else {
    head = `<tr><th>ID</th>${invTh('name', 'Product')}${invTh('cat', 'Category')}<th class="r">Cost</th>${invTh('price', 'Price', true)}${invTh('margin', 'Margin', true)}<th class="r">Warn at</th>${invTh('stock', 'Stock', true)}<th>Status</th><th></th></tr>`;
    trs = rows.map(p => { const st = invStatus(p), id = p.productId, d = invState.drafts[id] || {};
      const cost = d.cost ?? p.cost, price = d.price ?? p.price, reorder = d.reorder ?? p.reorder, catId = d.cat ?? categoryIdByName[p.cat];
      return `<tr><td class="num">${id}</td><td><strong>${p.name}</strong></td>
        <td><select id="product-category-${id}" onchange="invEdit(${id})">${CATS.map(c => `<option value="${categoryIdByName[c]}" ${String(categoryIdByName[c]) === String(catId) ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
        <td class="r"><input id="product-cost-${id}" class="i-in num" type="number" min="0" step="0.01" value="${cost}" oninput="invEdit(${id})" aria-label="Cost"></td>
        <td class="r"><input id="product-price-${id}" class="i-in num" type="number" min="0" step="0.01" value="${price}" oninput="invEdit(${id})" aria-label="Price"></td>
        <td class="r" id="inv-margin-${id}">${invMargin(Number(cost), Number(price))}</td>
        <td class="r"><input id="product-reorder-${id}" class="i-in num" style="width:64px" type="number" min="0" step="1" value="${reorder}" oninput="invEdit(${id})" aria-label="Low-stock warning level"></td>
        <td class="num r">${p.stock}</td><td><span class="i-st ${st}">${INV_LABEL[st]}</span></td>
        <td class="action-cell"><button id="inv-save-${id}" class="s-btn pri" ${invState.drafts[id] ? '' : 'hidden'} onclick="saveProductRow(${id})">Save</button>${invState.savedId === id ? `<span class="i-ok" id="inv-ok-${id}">${dIcon('check')}Saved</span>` : ''}</td></tr>`; }).join('');
  }
  return `<div class="card"><div class="tw"><table class="s-table"><thead>${head}</thead><tbody>${trs}</tbody></table></div>
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
  invState.drafts[id] = { cost: g('cost').value, price: g('price').value, reorder: g('reorder').value, cat: g('category').value };
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
    ${isStock ? '' : `<button class="s-btn pri" onclick="addProduct()">${dIcon('plus')}Add product</button>`}</div></div>
  <div class="sec grid g4" id="invKpis">${invKpisHTML()}</div>
  <div class="s-bar">
    <div class="s-search">${dIcon('magnifying%20glass')}<input type="search" placeholder="Search product" value="${invState.q}" oninput="setInvQ(this.value)"></div>
    <div class="s-chips" id="invChips">${invChipsHTML()}</div>
    <select class="i-select" onchange="setInvCat(this.value)"><option value="all">All categories</option>${CATS.map(c => `<option value="${c}" ${invState.cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
    <div class="s-spacer"></div><button class="s-btn" onclick="exportInvCsv()">${dIcon('download')}Export CSV</button>
  </div>
  <div id="invBody">${invBodyHTML()}</div>`;
}
async function exportInvCsv() {
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['Product ID', 'Product', 'Category', 'Cost', 'Price', 'Margin %', 'Stock', 'Low-stock warning', 'Status'];
  const rows = invList().map(p => [p.productId, p.name, p.cat, p.cost.toFixed(2), p.price.toFixed(2), p.price ? ((p.price - p.cost) / p.price * 100).toFixed(1) : '0', p.stock, p.reorder, INV_LABEL[invStatus(p)]]);
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
function anLabel(dateStr) { return new Date(dateStr + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }); }
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
  return kp + `<div class="r-two"><div class="card"><div class="a-hd"><div><h3>Profit &amp; Loss statement</h3><p>Last ${N} days${cmp ? ' vs the ' + N + ' days before' : ''}</p></div></div>
    <div class="tw"><table class="s-table r-st"><thead><tr><th></th><th class="r">Amount</th><th class="r">% of revenue</th>${cmp ? '<th class="r">Previous</th><th class="r">Change</th>' : ''}</tr></thead><tbody>${stmt}</tbody></table></div>
    <div class="r-note">Expenses are counted on the date they were recorded.</div></div>
    <div class="card"><div class="a-hd"><div><h3>Where the money goes</h3><p>Every ₱100 of revenue</p></div></div>${flow}</div></div>`;
}
function rpDayData() {
  const ds = anDateStr(rpState.day), rows = sales.filter(s => s.date === ds), payOf = {};
  transactions.forEach(t => { payOf[t.id] = payClass(t.payMethod); });
  const items = {}, pay = {};
  rows.forEach(r => { const o = items[r.name] = items[r.name] || { q: 0, t: 0, p: 0 }; o.q += r.qty; o.t += r.total; o.p += r.profit; const m = payOf[r.transactionId]; if (m) pay[m] = (pay[m] || 0) + r.total; });
  return { ds, rows, items, pay, R: rows.reduce((a, r) => a + r.total, 0), G: rows.reduce((a, r) => a + r.profit, 0), tx: new Set(rows.map(r => r.transactionId)).size, units: rows.reduce((a, r) => a + r.qty, 0) };
}
function rpDailyHTML() {
  const d = rpDayData(), day = rpState.day, label = new Date(d.ds + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
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
      ${need.length ? `<table class="s-table"><tbody>${need.map(p => `<tr><td><strong>${p.name}</strong></td><td class="num">${p.stock} left</td><td><span class="i-st ${p.stock === 0 ? 'out' : 'low'}">${p.stock === 0 ? 'Out' : 'Low'}</span></td></tr>`).join('')}</tbody></table>` : '<div class="d-empty"><strong>All stocked up</strong>Nothing needs restocking.</div>'}</div></div>`;
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
    <span class="r-gen">Generated ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>`;
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
    const dateText = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
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
        ${recent.length ? recent.map(t => `<div class="d-sale"><span class="d-sic">${dIcon('receipt')}</span><div class="d-sm"><strong>${t.receiptNumber || '#' + t.id}</strong><span>${dashTime(t)}${payLabel(t.payMethod)}</span></div><strong class="num">${money(t.total)}</strong></div>`).join('') : `<div class="d-empty"><span class="d-bubble">${dIcon('receipt')}</span><strong>No sales yet</strong>Completed sales will show up here.</div>`}
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
        ${low.length ? low.slice(0, 5).map(p => { const w = Math.max(6, Math.min(100, (p.stock / ((p.reorder || 1) * 2)) * 100)); return `<div class="d-att"><div class="d-an"><strong>${p.name}</strong><div class="d-bar"><i style="width:${w}%"></i></div></div><span class="d-ac">${p.stock === 0 ? 'Out of stock' : p.stock + ' left'}</span><button class="d-add" onclick="restockProduct('${p.id}')">Add stock</button></div>`; }).join('') : '<div class="d-empty"><strong>All stocked up</strong>Nothing needs attention right now.</div>'}
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
        <div class="section-head">
          <div><h2>Products</h2><span class="section-meta">${products.length} products available</span></div>
          <div class="search-wrap"><span class="search-icon">⌕</span><input aria-label="Search products" placeholder="Search product" value="${posQuery}" oninput="setPosQuery(this.value)"></div>
        </div>
        <div class="pos-cats" id="posCats">${catButtonsHTML()}</div>
        <div class="pos-grid" id="posGrid">${posItemsHTML(filteredProducts())}</div>
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
      <div class="section-head table-head"><div><h2>Recent transactions</h2><span class="section-meta">${transactions.length} recent transactions loaded from the database</span></div></div>
      <div class="tw"><table><thead><tr><th>Receipt #</th><th>Time</th><th>Items</th><th>Payment</th><th>Voucher</th><th>Total</th><th></th></tr></thead><tbody>
      ${transactions.length ? transactions.map(t => `<tr>
          <td><strong>${t.receiptNumber || "#" + t.id}</strong></td>
          <td>${t.time.toLocaleString()}</td>
          <td>${t.lines.map(l => l.qty + '× ' + l.name).join(', ')}</td>
          <td><span class="tag ${t.payMethod}">${payLabel(t.payMethod)}</span></td>
          <td>${t.voucher || '—'}</td>
          <td class="num"><strong>${money(t.total)}</strong></td>
          <td class="action-cell"><button class="btn" onclick='showReceipt(transactions.find(x=>x.id===${t.id}), true)'>View receipt</button></td>
        </tr>`).join('') : `<tr><td colspan="7" class="empty-state">No transactions yet. Completed charges from Checkout will appear here.</td></tr>`}
      </tbody></table></div>
    </div>`;
  },
  analytics() {
    return analyticsPage();
  },
  inventory() {
    if (currentUser?.role_name === 'ADMIN') return inventoryPage('inventory');
    const rows = products.map(p => {
      const status = p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok';
      return `<tr><td><strong>${p.name}</strong></td><td>${p.cat}</td><td class="num stock-value">${p.stock}</td><td class="num"><strong>${money(p.price)}</strong></td><td><span class="tag ${status}">${status === 'ok' ? 'In stock' : status === 'low' ? 'Low stock' : 'Out of stock'}</span></td>${currentUser?.role_name === 'ADMIN' ? `<td class="action-cell"><button class="btn secondary" onclick="restockProduct('${p.id}')">Add stock</button></td>` : ''}</tr>`;
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
      return `<tr data-product-row="${p.productId}"><td class="num">${p.productId}</td><td><strong>${p.name}</strong></td>
        <td><select id="product-category-${p.productId}">${CATS.map(c => `<option value="${categoryIdByName[c]}" ${c === p.cat ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
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
  reports() {
    return reportsPage();
  }
};

async function saveProductRow(productId) {
  const categoryId = Number(document.getElementById(`product-category-${productId}`)?.value);
  const costPrice = Number(document.getElementById(`product-cost-${productId}`)?.value);
  const sellingPrice = Number(document.getElementById(`product-price-${productId}`)?.value);
  const reorderPoint = Number(document.getElementById(`product-reorder-${productId}`)?.value);
  const product = products.find(p => p.productId === productId);
  if (!product) return;
  try {
    await api(`/products/${productId}`, {
      method: 'PUT',
      body: JSON.stringify({ categoryId, costPrice, sellingPrice, reorderPoint })
    });
    delete invState.drafts[productId];
    invState.savedId = productId;
    await loadData();
    render('products');
    setTimeout(() => { invState.savedId = null; document.getElementById('inv-ok-' + productId)?.remove(); }, 2200);
  } catch (err) {
    alert(`Could not save product: ${err.message}`);
  }
}

function addProduct() {
  if (!CATS.length) return alert('No active product categories are available.');
  const modal = document.getElementById('addProductModal');
  const category = document.getElementById('addProductCategory');
  const error = document.getElementById('addProductError');
  if (!modal || !category) return;
  category.innerHTML = CATS.map(c => `<option value="${categoryIdByName[c]}">${c}</option>`).join('');
  const form = document.getElementById('addProductForm');
  if (form) form.reset();
  category.value = String(categoryIdByName[CATS[0]]);
  if (document.getElementById('addProductWarning')) document.getElementById('addProductWarning').value = 10;
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
      body: JSON.stringify({ productName, categoryId, costPrice, sellingPrice, reorderPoint: warningLevel, openingStock })
    });
    await loadData();
    closeAddProduct();
    render('products');
  } catch (err) {
    showError(`Could not add product: ${err.message}`);
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add product'; }
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
  ["reports", "Reports", "reports", "reports.svg"]
];
const navDefsCashier = [
  ["checkout", "Checkout", "checkout"],
  ["history", "Sales", "sales"]
];
const navGroup = { dashboard: "dashboard", checkout: "checkout", history: "sales", ledger: "sales", inventory: "inventory", products: "inventory", analytics: "analytics", reports: "reports" };

function visibleViewsForRole() {
  return currentUser?.role_name === 'ADMIN'
    ? ['dashboard', 'history', 'inventory', 'products', 'ledger', 'analytics', 'reports']
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
    body.innerHTML = `${out.length ? `<div class="notice-block danger"><strong>${out.length} product${out.length === 1 ? '' : 's'} out of stock</strong><span>These products cannot be sold until stock is added.</span></div>` : ''}${lowOnly.length ? `<div class="notice-block warning"><strong>${lowOnly.length} product${lowOnly.length === 1 ? '' : 's'} running low</strong><span>The warning appears because stock has reached the product's warning level.</span></div>` : ''}<div class="low-stock-list">${low.map(p => `<div class="low-stock-row"><div><strong>${p.name}</strong><span>${p.cat}</span></div><div class="stock-state ${p.stock === 0 ? 'out' : 'low'}">${p.stock === 0 ? 'Out of stock' : `${p.stock} left`}</div></div>`).join('')}</div>`;
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

async function startApp() {
  try {
    const me = await api('/me');
    if (me.authenticated) {
      currentUser = me.user;
      showAppShell(true);
      await loadData();
      const hash = location.hash.slice(1);
      const defaultTab = currentUser.role_name === 'ADMIN' ? 'dashboard' : 'checkout';
      render(visibleViewsForRole().includes(hash) ? hash : defaultTab);
      if (lowStockList().length) setTimeout(openLowStockPopup, 250);
    } else {
      location.replace('login.html');
    }
  } catch (_) {
    location.replace('login.html');
  }
}
startApp();
