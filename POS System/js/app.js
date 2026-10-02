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
function lowStockList() { return products.filter(p => p.stock <= p.reorder).sort((a, b) => a.stock - b.stock); }
async function restockProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const defaultQty = Math.max(p.reorder, 1);
  const input = prompt(`How many units of ${p.name} would you like to add?`, String(defaultQty));
  if (input === null) return;
  const quantity = Number(input);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    alert('Please enter a positive whole number.');
    return;
  }
  try {
    await api(`/inventory/${p.productId}/restock`, { method: 'POST', body: JSON.stringify({ quantity }) });
    await loadData();
    render('inventory');
  } catch (err) {
    alert(err.message);
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
    <h3>Til · POS Console</h3>
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
  let l = ["TIL · POS CONSOLE", `Receipt #${tx.receiptNumber || tx.id}`, tx.time.toLocaleString(), '------------------------'];
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

// ---------- Views ----------
const views = {
  adminDashboard() {
    const stats = computeStats();
    return `
    <div class="page-head"><div><div class="eyebrow">ADMIN</div><h1>Dashboard</h1><p>Overview of today’s sales, stock, and store activity.</p></div><span class="period-pill">Today</span></div>
    <div class="sec grid g4">
      <div class="card kpi compact"><div class="l">Today's sales</div><div class="v num">${money(stats.todayRows.reduce((a, r) => a + r.total, 0))}</div><div class="d">${stats.todayTxCount} transactions</div></div>
      <div class="card kpi compact"><div class="l">Items sold today</div><div class="v num">${stats.todayRows.reduce((a, r) => a + r.qty, 0)}</div><div class="d">Across all completed sales</div></div>
      <div class="card kpi compact"><div class="l">Low-stock products</div><div class="v num ${stats.lowStockCount ? 'down' : 'up'}">${stats.lowStockCount}</div><div class="d">${stats.lowStockCount ? 'Need attention' : 'Stock levels look good'}</div></div>
      <div class="card kpi compact"><div class="l">Products</div><div class="v num">${products.length}</div><div class="d">Active products</div></div>
    </div>
    <div class="sec grid g2">
      <div class="card"><div class="section-head"><div><h2>Quick access</h2><span class="section-meta">Common admin tasks</span></div></div><div class="quick-actions">
        <button class="quick-action" onclick="render('inventory')"><strong>Central stock</strong><span>Check current product quantities</span></button>
        <button class="quick-action" onclick="render('products')"><strong>Products</strong><span>Update product details and prices</span></button>
        <button class="quick-action" onclick="render('history')"><strong>Transactions</strong><span>Review completed sales and receipts</span></button>
        <button class="quick-action" onclick="render('reports')"><strong>Reports</strong><span>View financial and daily summaries</span></button>
      </div></div>
      <div class="card"><div class="section-head"><div><h2>Recent sales</h2><span class="section-meta">Latest completed transactions</span></div><button class="link-btn" onclick="render('history')">View all</button></div>
        <div class="dashboard-list">${transactions.slice(0,5).map(t => `<div class="dashboard-list-row"><div><strong>${t.receiptNumber || '#' + t.id}</strong><span>${t.lines.length} ${t.lines.length === 1 ? 'item' : 'items'} · ${payLabel(t.payMethod)}</span></div><strong class="num">${money(t.total)}</strong></div>`).join('') || '<div class="empty-state">No sales yet.</div>'}</div>
      </div>
    </div>
    <div class="card"><div class="section-head"><div><h2>Need attention?</h2><span class="section-meta">Low-stock products are shown here when available.</span></div></div>
      ${lowStockList().length ? `<div class="low-stock-mini">${lowStockList().slice(0,5).map(p => `<div><strong>${p.name}</strong><span>${p.stock === 0 ? 'Out of stock' : p.stock + ' left'}</span></div>`).join('')}</div>` : '<div class="empty-state">Nothing needs attention right now.</div>'}
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
    const stats = computeStats(analyticsRangeDays);
    const label = rangeLabel(analyticsRangeDays);
    const trend = Number(stats.trend || 0).toFixed(1);
    return `
    <div class="page-head"><div><div class="eyebrow">INSIGHTS</div><h1>Analytics</h1><p>Understand sales performance, product demand, and category trends.</p></div><div class="period-control"><label for="analyticsRange">Showing</label><select id="analyticsRange" onchange="setAnalyticsRange(this.value)">${[7,14,30,60].map(n => `<option value="${n}" ${n === analyticsRangeDays ? 'selected' : ''}>Last ${n} days</option>`).join('')}</select></div></div>
    <div class="sec grid g4">
      <div class="card kpi compact"><div class="l">Revenue</div><div class="v num">${money(stats.totalRev)}</div><div class="d ${trend >= 0 ? 'up' : 'down'}">${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend)}% vs previous period</div></div>
      <div class="card kpi compact"><div class="l">Gross profit</div><div class="v num">${money(stats.totalProfit)}</div><div class="d">${stats.totalRev ? ((stats.totalProfit / stats.totalRev) * 100).toFixed(1) : '0.0'}% margin</div></div>
      <div class="card kpi compact"><div class="l">Sales</div><div class="v num">${stats.periodTxCount}</div><div class="d">${stats.periodUnits} items sold</div></div>
      <div class="card kpi compact"><div class="l">Low stock</div><div class="v num ${stats.lowStockCount ? 'down' : 'up'}">${stats.lowStockCount}</div><div class="d">${stats.lowStockCount ? 'need attention' : 'No alerts'}</div></div>
    </div>
    <div class="sec grid g2">
      <div class="card chart-card"><div class="chart-title"><h2>Revenue &amp; profit</h2><span class="section-meta">${label}</span></div><canvas id="trendChart"></canvas></div>
      <div class="card chart-card"><div class="chart-title"><h2>Top products</h2><span class="section-meta">By revenue · ${label.toLowerCase()}</span></div><canvas id="topChart"></canvas></div>
    </div>
    <div class="sec card chart-card"><div class="chart-title"><h2>Sales by category</h2><span class="section-meta">Revenue distribution · ${label.toLowerCase()}</span></div><canvas id="catChart" style="max-height:240px"></canvas></div>`;
  },
  inventory() {
    const rows = products.map(p => {
      const status = p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok';
      return `<tr><td><strong>${p.name}</strong></td><td>${p.cat}</td><td class="num stock-value">${p.stock}</td><td class="num"><strong>${money(p.price)}</strong></td><td><span class="tag ${status}">${status === 'ok' ? 'In stock' : status === 'low' ? 'Low stock' : 'Out of stock'}</span></td></tr>`;
    }).join('');
    return `
    ${inventorySubnav('inventory')}
    <div class="page-head"><div><div class="eyebrow">INVENTORY</div><h1>Central stock</h1><p>One stock view for products sold in-store and through e-commerce.</p></div></div>
    <div class="card">
      <div class="toolbar table-toolbar"><div><h2>Stock inventory</h2><span class="section-meta">${products.length} products</span></div><div class="search-wrap compact-search"><span class="search-icon">⌕</span><input placeholder="Search product" aria-label="Search inventory" oninput="filterInv(this.value)"></div></div>
      <div class="tw"><table id="invTable"><thead><tr><th>Product</th><th>Category</th><th>Current stock</th><th>Price</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  },
  ledger() {
    const rows = [...sales].reverse().slice(0, 40).map(s => `<tr><td>${s.date}</td><td><strong>${s.name}</strong></td><td class="num">${s.qty}</td><td class="num">${money(s.price)}</td><td class="num"><strong>${money(s.total)}</strong></td><td class="num up">${money(s.profit)}</td></tr>`).join('');
    return `
    ${salesSubnav('ledger')}
    <div class="page-head"><div><div class="eyebrow">SALES</div><h1>Daily sales</h1><p>Line-by-line record of products sold.</p></div></div>
    <div class="card">
      <div class="section-head table-head"><div><h2>Sales entries</h2><span class="section-meta">${sales.length} sales entries available</span></div></div>
      <div class="tw"><table><thead><tr><th>Date</th><th>Product</th><th>Qty</th><th>Price</th><th>Total</th><th>Profit</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="table-footnote">Showing the 40 most recent entries. New completed sales from Checkout appear here.</div>
    </div>`;
  },
  products() {
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
    const stats = computeStats(analyticsRangeDays);
    const label = rangeLabel(analyticsRangeDays);
    return `
    <div class="page-head"><div><div class="eyebrow">REPORTING</div><h1>Reports</h1><p>Financial and operational summaries for the current reporting period.</p></div><div class="period-control"><label for="reportsRange">Showing</label><select id="reportsRange" onchange="setAnalyticsRange(this.value, 'reports')">${[7,14,30,60].map(n => `<option value="${n}" ${n === analyticsRangeDays ? 'selected' : ''}>Last ${n} days</option>`).join('')}</select></div></div>
    <div class="grid g2">
    <div class="card"><div class="section-head"><div><h2>Profit &amp; Loss</h2><span class="section-meta">${label}</span></div></div>
      <div class="plrow"><span>Gross sales revenue</span><span class="num">${money(stats.totalRev)}</span></div>
      <div class="plrow"><span>Cost of goods sold</span><span class="num down">-${money(stats.totalCOGS)}</span></div>
      <div class="plrow total"><span>Gross profit</span><span class="num">${money(stats.totalProfit)}</span></div>
      ${Object.entries(opex).map(([k, v]) => `<div class="plrow"><span>${k}</span><span class="num down">-${money(v)}</span></div>`).join('')}
      <div class="plrow"><span>Total operating expenses</span><span class="num down">-${money(totalOpex)}</span></div>
      <div class="plrow total"><span>Net profit</span><span class="num ${stats.netProfit >= 0 ? 'up' : 'down'}">${money(stats.netProfit)}</span></div>
    </div>
    <div class="card"><div class="section-head"><div><h2>Report summary</h2><span class="section-meta">Key operating figures</span></div></div>
      <div class="plrow"><span>Net margin</span><span class="num">${stats.totalRev ? ((stats.netProfit / stats.totalRev) * 100).toFixed(1) : '0.0'}%</span></div>
      <div class="plrow"><span>Avg. transaction value</span><span class="num">${money(sales.length ? stats.totalRev / new Set(sales.map(s => s.transactionId)).size : 0)}</span></div>
      <div class="plrow"><span>Units sold</span><span class="num">${sales.reduce((a, s) => a + s.qty, 0)}</span></div>
      <div class="plrow"><span>Inventory value on hand</span><span class="num">${money(products.reduce((a, p) => a + p.stock * p.cost, 0))}</span></div>
      <div class="plrow"><span>products below low-stock warning level</span><span class="num down">${stats.lowStockCount}</span></div>
    </div></div>
    <div class="sec card"><div class="section-head"><div><h2>Daily sales report</h2><span class="section-meta">Today</span></div></div>
      <div class="mini-stat-grid">
        <div><span>Revenue</span><strong class="num">${money(stats.todayRows.reduce((a, r) => a + r.total, 0))}</strong></div>
        <div><span>Transactions</span><strong class="num">${stats.todayTxCount}</strong></div>
        <div><span>Items sold</span><strong class="num">${stats.todayRows.reduce((a, r) => a + r.qty, 0)}</strong></div>
        <div><span>Profit</span><strong class="num">${money(stats.todayRows.reduce((a, r) => a + r.profit, 0))}</strong></div>
      </div>
      <div class="tw"><table><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>
      ${stats.todayRows.length ? [...stats.todayRows].reverse().map(r => `<tr><td><strong>${r.name}</strong></td><td class="num">${r.qty}</td><td class="num">${money(r.total)}</td></tr>`).join('') : `<tr><td colspan="3" class="empty-state">No sales rung up today yet — use Checkout to record a sale.</td></tr>`}
      </tbody></table></div>
    </div>
    <div class="card"><div class="section-head"><div><h2>Category performance</h2><span class="section-meta">Revenue and margin by category</span></div></div><div class="tw"><table><thead><tr><th>Category</th><th>Revenue</th><th>Profit</th><th>Margin</th></tr></thead><tbody>
    ${CATS.map(c => { const rows = sales.filter(s => s.cat === c); const rev = rows.reduce((a, r) => a + r.total, 0); const pr = rows.reduce((a, r) => a + r.profit, 0); return `<tr><td><strong>${c}</strong></td><td class="num">${money(rev)}</td><td class="num">${money(pr)}</td><td class="num">${rev ? ((pr / rev) * 100).toFixed(1) : '0.0'}%</td></tr>`; }).join('')}
    </tbody></table></div></div>`;
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
    await loadData();
    render('products');
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
        { label: 'Revenue', data: stats.salesByDay.map(d => d.rev), borderColor: '#C96A3E', backgroundColor: '#C96A3E22', tension: .3, fill: true },
        { label: 'Profit', data: stats.salesByDay.map(d => d.profit), borderColor: '#3F8F7E', backgroundColor: '#3F8F7E22', tension: .3, fill: true }
      ]
    }, options: { plugins: { legend: { labels: { color: axis.ticks.color } } }, scales: { x: axis, y: axis } }
  }));
  charts.push(new Chart(document.getElementById('topChart'), { type: 'bar', data: { labels: stats.topProducts.map(p => p.name.split(' ').slice(0, 2).join(' ')), datasets: [{ label: 'Revenue', data: stats.topProducts.map(p => +p.rev.toFixed(2)), backgroundColor: '#C96A3E' }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: axis, y: axis } } }));
  charts.push(new Chart(document.getElementById('catChart'), { type: 'bar', data: { labels: CATS, datasets: [{ label: 'Revenue', data: CATS.map(c => +periodSales.filter(s => s.cat === c).reduce((a, r) => a + r.total, 0).toFixed(2)), backgroundColor: '#3F8F7E' }] }, options: { plugins: { legend: { display: false } }, scales: { x: axis, y: axis } } }));
}

const navDefsAdmin = [
  ["dashboard", "Dashboard", "dashboard"],
  ["history", "Sales", "sales"],
  ["inventory", "Inventory", "inventory"],
  ["analytics", "Analytics", "analytics"],
  ["reports", "Reports", "reports"]
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
    <div class="login-brand">Til<span>·</span>POS</div>
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

async function logout() {
  try { await api('/logout', { method: 'POST' }); } catch (_) {}
  currentUser = null;
  cart = []; voucher = null;
  closeLowStockPopup();
  destroyCharts();
  document.body.classList.remove('checkout-mode');
  showAppShell(false);
  document.getElementById('loginScreen').innerHTML = loginView();
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

function render(tab) {
  const allowed = visibleViewsForRole();
  if (!(tab in views) || !allowed.includes(tab)) tab = currentUser?.role_name === 'ADMIN' ? 'dashboard' : 'checkout';
  const activeGroup = navGroup[tab] || 'checkout';
  const defs = currentUser?.role_name === 'ADMIN' ? navDefsAdmin : navDefsCashier;
  const nav = document.getElementById('nav');
  if (nav) nav.innerHTML = defs.map(([id, label, group]) => `<button class="${group === activeGroup ? 'on' : ''}" onclick="render('${id}')">${label}</button>`).join('');
  updateUserHeader();
  destroyCharts();
  document.body.classList.toggle('checkout-mode', tab === 'checkout');
  document.getElementById('main').innerHTML = views[tab === 'dashboard' ? 'adminDashboard' : tab]();
  if (tab === 'analytics') drawDashboardCharts();
  history.replaceState(null, '', '#' + tab);
}

async function startApp() {
  document.getElementById('loginScreen').innerHTML = loginView();
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
      showAppShell(false);
    }
  } catch (_) {
    showAppShell(false);
    document.getElementById('loginScreen').innerHTML = loginView('Could not reach the POS server. Start Apache and MySQL in XAMPP, then refresh this page.');
  }
}
startApp();
