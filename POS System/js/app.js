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
const today = new Date();
const days = [...Array(14)].map((_, i) => { const d = new Date(today); d.setHours(0,0,0,0); d.setDate(d.getDate() - (13 - i)); return d; });

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
function computeStats() {
  const salesByDay = days.map(d => {
    const rows = sales.filter(s => s.date === fmtDate(d));
    const uniqueTx = new Set(rows.map(r => r.transactionId));
    return {
      date: fmtDate(d).slice(5),
      rev: +rows.reduce((a, r) => a + r.total, 0).toFixed(2),
      profit: +rows.reduce((a, r) => a + r.profit, 0).toFixed(2),
      tx: uniqueTx.size
    };
  });
  const totalRev = +sales.reduce((a, r) => a + r.total, 0).toFixed(2);
  const totalProfit = +sales.reduce((a, r) => a + r.profit, 0).toFixed(2);
  const totalCOGS = +(totalRev - totalProfit).toFixed(2);
  const todayRows = sales.filter(s => s.date === fmtDate(today));
  const todayTxCount = new Set(todayRows.map(r => r.transactionId)).size;
  const netProfit = +(totalProfit - totalOpex).toFixed(2);
  const byProduct = {};
  sales.forEach(s => {
    byProduct[s.sku] = byProduct[s.sku] || { name: s.name, qty: 0, rev: 0, profit: 0 };
    byProduct[s.sku].qty += s.qty;
    byProduct[s.sku].rev += s.total;
    byProduct[s.sku].profit += s.profit;
  });
  const topProducts = Object.values(byProduct).sort((a, b) => b.rev - a.rev).slice(0, 6);
  const lowStockCount = products.filter(p => p.stock <= p.reorder).length;
  return { salesByDay, totalRev, totalProfit, totalCOGS, todayRows, todayTxCount, netProfit, byProduct, topProducts, lowStockCount };
}

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
    render('alerts');
  } catch (err) {
    alert(err.message);
  }
}

function filteredProducts() {
  const q = posQuery.trim().toLowerCase();
  return products.filter(p => (posCat === "All" || p.cat === posCat) && (p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
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
      <div class="pi-cat">${p.cat} · ${p.id}</div>
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
      <div class="pl-name">${l.name}<div class="pl-sub">${money(l.price)} ea · ${l.id}</div></div>
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
  dashboard() {
    const stats = computeStats();
    const todayRev = stats.todayRows.reduce((a, r) => a + r.total, 0);
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

    <div class="sec grid g3">
      <div class="card kpi compact"><div class="l">Today's sales</div><div class="v num" id="kpiTodayRev">${money(todayRev)}</div><div class="d" id="kpiTodayTx">${stats.todayTxCount} transactions</div></div>
      <div class="card kpi compact"><div class="l">Low stock</div><div class="v num ${stats.lowStockCount ? 'down' : 'up'}" id="kpiLowStock">${stats.lowStockCount}</div><div class="d">${stats.lowStockCount ? 'items need attention' : 'All stock levels healthy'}</div></div>
      <div class="card kpi compact"><div class="l">Current sale</div><div class="v num" id="cartCount">${cartCount}</div><div class="d">items in cart</div></div>
    </div>

    <div class="sec grid pos-layout">
      <section class="card pos-products">
        <div class="section-head">
          <div><h2>Products</h2><span class="section-meta">${products.length} SKUs available</span></div>
          <div class="search-wrap"><span class="search-icon">⌕</span><input aria-label="Search products" placeholder="Search product or SKU" value="${posQuery}" oninput="setPosQuery(this.value)"></div>
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
          <label for="voucherInput" class="field-label">Discount / voucher</label>
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
  alerts() {
    const low = lowStockList();
    const out = low.filter(p => p.stock === 0);
    const atRisk = +low.reduce((a, p) => a + p.stock * p.cost, 0).toFixed(2);
    return `
    ${inventorySubnav('alerts')}
    <div class="page-head"><div><div class="eyebrow">INVENTORY</div><h1>Low stock alerts</h1><p>Items at or below their reorder point.</p></div></div>
    <div class="sec grid g4">
      <div class="card kpi compact"><div class="l">Out of stock</div><div class="v num ${out.length ? 'down' : 'up'}">${out.length}</div><div class="d">${out.length ? 'need immediate reorder' : 'None'}</div></div>
      <div class="card kpi compact"><div class="l">Low stock</div><div class="v num">${low.length - out.length}</div><div class="d">at or below reorder point</div></div>
      <div class="card kpi compact"><div class="l">SKUs flagged</div><div class="v num">${low.length}</div><div class="d">of ${products.length} total</div></div>
      <div class="card kpi compact"><div class="l">Stock value</div><div class="v num">${money(atRisk)}</div><div class="d">current value of flagged stock</div></div>
    </div>
    ${low.length ? `<div class="alert-banner ${out.length ? 'crit' : ''}"><strong>${out.length ? 'Immediate attention:' : 'Attention:'}</strong> ${out.length ? out.length + ' item(s) are out of stock. ' : ''}${low.length} item(s) are at or below the reorder point.</div>` : ''}
    <div class="card">
      <div class="section-head table-head"><div><h2>Items needing attention</h2><span class="section-meta">Review and restock as needed.</span></div></div>
      <div class="tw"><table><thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Stock</th><th>Reorder pt.</th><th>Status</th><th></th></tr></thead><tbody>
      ${low.length ? low.map(p => `<tr><td>${p.id}</td><td><strong>${p.name}</strong></td><td>${p.cat}</td><td class="num">${p.stock}</td><td class="num">${p.reorder}</td><td><span class="tag ${p.stock === 0 ? 'out' : 'low'}">${p.stock === 0 ? 'Out of stock' : 'Low stock'}</span></td><td class="action-cell"><button class="btn secondary" onclick="restockProduct('${p.id}')">Restock</button></td></tr>`).join('') : `<tr><td colspan="7" class="empty-state">All stock levels are healthy — nothing needs restocking right now.</td></tr>`}
      </tbody></table></div>
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
    const stats = computeStats();
    const wk1 = stats.salesByDay.slice(0, 7).reduce((a, d) => a + d.rev, 0);
    const wk2 = stats.salesByDay.slice(7, 14).reduce((a, d) => a + d.rev, 0);
    const trend = wk1 ? (((wk2 - wk1) / wk1) * 100).toFixed(1) : "0.0";
    return `
    <div class="page-head"><div><div class="eyebrow">INSIGHTS</div><h1>Analytics</h1><p>Understand sales performance, product demand, and category trends.</p></div><span class="period-pill">Last 14 days</span></div>
    <div class="sec grid g4">
      <div class="card kpi compact"><div class="l">Revenue</div><div class="v num">${money(stats.totalRev)}</div><div class="d ${trend >= 0 ? 'up' : 'down'}">${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend)}% vs prior week</div></div>
      <div class="card kpi compact"><div class="l">Gross profit</div><div class="v num">${money(stats.totalProfit)}</div><div class="d">${stats.totalRev ? ((stats.totalProfit / stats.totalRev) * 100).toFixed(1) : '0.0'}% margin</div></div>
      <div class="card kpi compact"><div class="l">Transactions today</div><div class="v num">${stats.todayTxCount}</div><div class="d">${money(stats.todayRows.reduce((a, r) => a + r.total, 0))} sold</div></div>
      <div class="card kpi compact"><div class="l">Low stock</div><div class="v num ${stats.lowStockCount ? 'down' : 'up'}">${stats.lowStockCount}</div><div class="d">${stats.lowStockCount ? 'need reordering' : 'No alerts'}</div></div>
    </div>
    <div class="sec grid g2">
      <div class="card chart-card"><div class="chart-title"><h2>Revenue &amp; profit</h2><span class="section-meta">14-day trend</span></div><canvas id="trendChart"></canvas></div>
      <div class="card chart-card"><div class="chart-title"><h2>Top products</h2><span class="section-meta">By revenue</span></div><canvas id="topChart"></canvas></div>
    </div>
    <div class="sec card chart-card"><div class="chart-title"><h2>Sales by category</h2><span class="section-meta">Revenue distribution</span></div><canvas id="catChart" style="max-height:240px"></canvas></div>`;
  },
  inventory() {
    const rows = products.map(p => {
      const status = p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok';
      return `<tr><td>${p.id}</td><td><strong>${p.name}</strong></td><td>${p.cat}</td><td class="num stock-value">${p.stock}</td><td class="num">${money(p.cost)}</td><td class="num"><strong>${money(p.price)}</strong></td><td><span class="tag ${status}">${status === 'ok' ? 'In stock' : status === 'low' ? 'Low stock' : 'Out of stock'}</span></td></tr>`;
    }).join('');
    return `
    ${inventorySubnav('inventory')}
    <div class="page-head"><div><div class="eyebrow">INVENTORY</div><h1>Central stock</h1><p>One inventory view for products sold in-store and through e-commerce.</p></div></div>
    <div class="card">
      <div class="toolbar table-toolbar"><div><h2>Stock inventory</h2><span class="section-meta">${products.length} SKUs</span></div><div class="search-wrap compact-search"><span class="search-icon">⌕</span><input placeholder="Search product or SKU" aria-label="Search inventory" oninput="filterInv(this.value)"></div></div>
      <div class="tw"><table id="invTable"><thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Stock</th><th>Cost</th><th>Price</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  },
  ledger() {
    const rows = [...sales].reverse().slice(0, 40).map(s => `<tr><td>${s.date}</td><td>${s.sku}</td><td><strong>${s.name}</strong></td><td class="num">${s.qty}</td><td class="num">${money(s.price)}</td><td class="num"><strong>${money(s.total)}</strong></td><td class="num up">${money(s.profit)}</td></tr>`).join('');
    return `
    ${salesSubnav('ledger')}
    <div class="page-head"><div><div class="eyebrow">SALES</div><h1>Daily sales ledger</h1><p>Line-level record of items sold across the store.</p></div></div>
    <div class="card">
      <div class="section-head table-head"><div><h2>Sales entries</h2><span class="section-meta">${sales.length} line entries across 14 days</span></div></div>
      <div class="tw"><table><thead><tr><th>Date</th><th>SKU</th><th>Item</th><th>Qty</th><th>Price</th><th>Total</th><th>Profit</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="table-footnote">Showing the 40 most recent entries. New completed sales from Checkout appear here.</div>
    </div>`;
  },
  products() {
    const rows = products.map(p => {
      const status = p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok';
      return `<tr data-product-row="${p.productId}"><td>${p.id}</td><td><strong>${p.name}</strong></td>
        <td><select id="product-category-${p.productId}">${CATS.map(c => `<option value="${categoryIdByName[c]}" ${c === p.cat ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
        <td><input id="product-cost-${p.productId}" class="num compact-input" type="number" min="0" step="0.01" value="${p.cost}"></td>
        <td><input id="product-price-${p.productId}" class="num compact-input" type="number" min="0" step="0.01" value="${p.price}"></td>
        <td><input id="product-reorder-${p.productId}" class="num compact-input" type="number" min="0" step="1" value="${p.reorder}"></td>
        <td class="num">${p.stock}</td><td><span class="tag ${status}">${status === 'ok' ? 'Active' : status === 'low' ? 'Low stock' : 'Out of stock'}</span></td>
        <td class="action-cell"><button class="btn secondary" onclick="saveProductRow(${p.productId})">Save</button></td></tr>`;
    }).join('');
    return `
    ${inventorySubnav('products')}
    <div class="page-head"><div><div class="eyebrow">INVENTORY</div><h1>Product management</h1><p>Maintain product details. Stock quantities are managed in Central stock.</p></div><button class="btn" onclick="addProduct()">+ Add product</button></div>
    <div class="card">
      <div class="toolbar table-toolbar"><div><h2>Products</h2><span class="section-meta">Edit category, cost, price, and reorder point.</span></div><div class="search-wrap compact-search"><span class="search-icon">⌕</span><input placeholder="Search product or SKU" aria-label="Search products" oninput="filterProducts(this.value)"></div></div>
      <div class="tw"><table id="productTable"><thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Cost</th><th>Price</th><th>Reorder</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  },
  reports() {
    const stats = computeStats();
    return `
    <div class="page-head"><div><div class="eyebrow">REPORTING</div><h1>Reports</h1><p>Financial and operational summaries for the current reporting period.</p></div><span class="period-pill">Trailing 14 days</span></div>
    <div class="grid g2">
    <div class="card"><div class="section-head"><div><h2>Profit &amp; Loss</h2><span class="section-meta">Trailing 14 days</span></div></div>
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
      <div class="plrow"><span>SKUs below reorder point</span><span class="num down">${stats.lowStockCount}</span></div>
    </div></div>
    <div class="sec card"><div class="section-head"><div><h2>Daily sales report</h2><span class="section-meta">Today</span></div></div>
      <div class="mini-stat-grid">
        <div><span>Revenue</span><strong class="num">${money(stats.todayRows.reduce((a, r) => a + r.total, 0))}</strong></div>
        <div><span>Transactions</span><strong class="num">${stats.todayTxCount}</strong></div>
        <div><span>Items sold</span><strong class="num">${stats.todayRows.reduce((a, r) => a + r.qty, 0)}</strong></div>
        <div><span>Profit</span><strong class="num">${money(stats.todayRows.reduce((a, r) => a + r.profit, 0))}</strong></div>
      </div>
      <div class="tw"><table><thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>
      ${stats.todayRows.length ? [...stats.todayRows].reverse().map(r => `<tr><td>${r.sku}</td><td><strong>${r.name}</strong></td><td class="num">${r.qty}</td><td class="num">${money(r.total)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty-state">No sales rung up today yet — use Checkout to record a sale.</td></tr>`}
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

async function addProduct() {
  const sku = prompt('SKU (example: SKU2000)');
  if (sku === null) return;
  const productName = prompt('Product name');
  if (productName === null) return;
  if (!CATS.length) return alert('No active product categories are available.');
  const categoryName = prompt(`Category (${CATS.join(', ')})`, CATS[0]);
  if (categoryName === null) return;
  const normalizedCategory = CATS.find(c => c.toLowerCase() === categoryName.trim().toLowerCase());
  if (!normalizedCategory) return alert('Category not found.');
  const costPrice = Number(prompt('Cost price', '0'));
  const sellingPrice = Number(prompt('Selling price', '0'));
  const reorderPoint = Number(prompt('Reorder point', '12'));
  const openingStock = Number(prompt('Opening stock', '0'));
  if ([costPrice, sellingPrice, reorderPoint, openingStock].some(n => !Number.isFinite(n) || n < 0)) {
    return alert('Please enter valid non-negative numbers.');
  }
  try {
    await api('/products', {
      method: 'POST',
      body: JSON.stringify({
        sku, productName, categoryId: categoryIdByName[normalizedCategory],
        costPrice, sellingPrice, reorderPoint, openingStock
      })
    });
    await loadData();
    render('products');
  } catch (err) {
    alert(`Could not add product: ${err.message}`);
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
  const stats = computeStats();
  const axis = { ticks: { color: getComputedStyle(document.body).getPropertyValue('--sub') }, grid: { color: getComputedStyle(document.body).getPropertyValue('--line') } };
  charts.push(new Chart(document.getElementById('trendChart'), {
    type: 'line', data: {
      labels: stats.salesByDay.map(d => d.date), datasets: [
        { label: 'Revenue', data: stats.salesByDay.map(d => d.rev), borderColor: '#C96A3E', backgroundColor: '#C96A3E22', tension: .3, fill: true },
        { label: 'Profit', data: stats.salesByDay.map(d => d.profit), borderColor: '#3F8F7E', backgroundColor: '#3F8F7E22', tension: .3, fill: true }
      ]
    }, options: { plugins: { legend: { labels: { color: axis.ticks.color } } }, scales: { x: axis, y: axis } }
  }));
  charts.push(new Chart(document.getElementById('topChart'), { type: 'bar', data: { labels: stats.topProducts.map(p => p.name.split(' ').slice(0, 2).join(' ')), datasets: [{ label: 'Revenue', data: stats.topProducts.map(p => +p.rev.toFixed(2)), backgroundColor: '#C96A3E' }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: axis, y: axis } } }));
  charts.push(new Chart(document.getElementById('catChart'), { type: 'bar', data: { labels: CATS, datasets: [{ label: 'Revenue', data: CATS.map(c => +sales.filter(s => s.cat === c).reduce((a, r) => a + r.total, 0).toFixed(2)), backgroundColor: '#3F8F7E' }] }, options: { plugins: { legend: { display: false } }, scales: { x: axis, y: axis } } }));
}

const navDefs = [
  ["dashboard", "Checkout", "checkout"],
  ["history", "Sales", "sales"],
  ["inventory", "Inventory", "inventory"],
  ["analytics", "Analytics", "analytics"],
  ["reports", "Reports", "reports"]
];
const navGroup = { dashboard: "checkout", history: "sales", ledger: "sales", inventory: "inventory", alerts: "inventory", products: "inventory", analytics: "analytics", reports: "reports" };

function inventorySubnav(active) {
  const count = lowStockList().length;
  return `<div class="subnav"><span class="subnav-label">Inventory</span><button class="${active === 'inventory' ? 'on' : ''}" onclick="render('inventory')">Central stock</button><button class="${active === 'alerts' ? 'on' : ''}" onclick="render('alerts')">Low stock ${count ? `<span class="subnav-badge">${count}</span>` : ''}</button><button class="${active === 'products' ? 'on' : ''}" onclick="render('products')">Products</button></div>`;
}
function salesSubnav(active) {
  return `<div class="subnav"><span class="subnav-label">Sales</span><button class="${active === 'history' ? 'on' : ''}" onclick="render('history')">Transactions</button><button class="${active === 'ledger' ? 'on' : ''}" onclick="render('ledger')">Sales ledger</button></div>`;
}
function render(tab) {
  if (!(tab in views)) tab = 'dashboard';
  const alertCount = lowStockList().length;
  const activeGroup = navGroup[tab] || 'checkout';
  document.getElementById('nav').innerHTML = navDefs.map(([id, label, group]) => {
    const badge = group === 'inventory' && alertCount ? ` <span class="nav-badge">${alertCount}</span>` : '';
    return `<button class="${group === activeGroup ? 'on' : ''}" onclick="render('${id}')">${label}${badge}</button>`;
  }).join('');
  destroyCharts();
  document.getElementById('main').innerHTML = views[tab]();
  if (tab === 'analytics') drawDashboardCharts();
  history.replaceState(null, '', '#' + tab);
}
async function startApp() {
  try {
    await loadData();
    render(location.hash.slice(1) in views ? location.hash.slice(1) : 'dashboard');
  } catch (err) {
    const openedFromFile = location.protocol === 'file:';
    const help = openedFromFile
      ? 'Open the POS through XAMPP at http://localhost/POS-System-XAMPP/ instead of double-clicking index.html.'
      : 'Make sure Apache and MySQL are running in XAMPP, the database was imported, and api/config.php has the correct MySQL settings.';
    document.getElementById('main').innerHTML = `<div class="card error-card"><h2>Cannot connect to POS database</h2><p>${err.message}</p><p>${help}</p><p>Test the PHP API at <a href="api/index.php?route=health">api/index.php?route=health</a>.</p></div>`;
  }
}
startApp();
