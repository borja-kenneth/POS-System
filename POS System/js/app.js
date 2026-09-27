// ---------- Mock data ----------
const CATS = ["Beverages", "Snacks", "Bakery", "Dairy", "Household", "Personal Care"];
const names = ["House Blend Coffee 250g", "Sparkling Water 500ml", "Oat Milk 1L", "Sea Salt Chips", "Dark Choc Bar", "Sourdough Loaf", "Butter Croissant", "Cheddar Block 200g", "Greek Yogurt Tub", "Dish Soap 750ml", "Paper Towels 2pk", "Shampoo 400ml", "Hand Cream 50ml", "Cola 12pk", "Granola Bars 6pk"];
function seed(i) { let x = Math.sin(i * 999) * 10000; return x - Math.floor(x); }
const products = names.map((n, i) => {
  const cost = +(2 + seed(i) * 18).toFixed(2);
  const price = +(cost * (1.35 + seed(i + 50) * 0.5)).toFixed(2);
  const stock = Math.floor(seed(i + 7) * 80);
  return { id: "SKU" + (1000 + i), name: n, cat: CATS[i % CATS.length], cost, price, stock, reorder: 12 };
});
const today = new Date();
function fmtDate(d) { return d.toISOString().slice(0, 10); }
const days = [...Array(14)].map((_, i) => { const d = new Date(today); d.setDate(d.getDate() - (13 - i)); return d; });
const sales = [];
days.forEach((d, di) => {
  const n = 6 + Math.floor(seed(di * 3) * 10);
  for (let k = 0; k < n; k++) {
    const p = products[Math.floor(seed(di * 100 + k) * products.length)];
    const qty = 1 + Math.floor(seed(di * 50 + k) * 4);
    sales.push({ date: fmtDate(d), sku: p.id, name: p.name, cat: p.cat, qty, price: p.price, cost: p.cost, total: +(qty * p.price).toFixed(2), profit: +(qty * (p.price - p.cost)).toFixed(2) });
  }
});
const opex = { "Rent": 1800, "Wages": 2600, "Utilities": 320, "Marketing": 250, "Misc": 180 };
const totalOpex = Object.values(opex).reduce((a, b) => a + b, 0);
const money = n => "₱" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// All figures below are recomputed on every call so that a sale rung up on
// the Dashboard (checkout) immediately flows into Analytics, Reports and
// the Sales Ledger — they are never cached from page load.
function computeStats() {
  const salesByDay = days.map(d => {
    const rows = sales.filter(s => s.date === fmtDate(d));
    return { date: fmtDate(d).slice(5), rev: +rows.reduce((a, r) => a + r.total, 0).toFixed(2), profit: +rows.reduce((a, r) => a + r.profit, 0).toFixed(2), tx: rows.length };
  });
  const totalRev = +sales.reduce((a, r) => a + r.total, 0).toFixed(2);
  const totalProfit = +sales.reduce((a, r) => a + r.profit, 0).toFixed(2);
  const totalCOGS = +(totalRev - totalProfit).toFixed(2);
  const todayRows = sales.filter(s => s.date === fmtDate(today));
  const netProfit = +(totalProfit - totalOpex).toFixed(2);
  const byProduct = {};
  sales.forEach(s => { byProduct[s.sku] = byProduct[s.sku] || { name: s.name, qty: 0, rev: 0, profit: 0 }; byProduct[s.sku].qty += s.qty; byProduct[s.sku].rev += s.total; byProduct[s.sku].profit += s.profit; });
  const topProducts = Object.values(byProduct).sort((a, b) => b.rev - a.rev).slice(0, 6);
  const lowStockCount = products.filter(p => p.stock <= p.reorder).length;
  return { salesByDay, totalRev, totalProfit, totalCOGS, todayRows, netProfit, byProduct, topProducts, lowStockCount };
}

// ---------- Checkout (Dashboard) state ----------
let cart = [];
let voucher = null;
let payMethod = "cash";
let posQuery = "";
let posCat = "All";
let txCounter = 5000;
const VOUCHERS = {
  SENIOR20: { pct: 0.20, label: "SENIOR20 · 20% (Senior/PWD discount)" },
  BULK10: { pct: 0.10, label: "BULK10 · 10% (bulk order)" },
  WELCOME5: { pct: 0.05, label: "WELCOME5 · 5% (first-time customer)" },
};

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
  const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0);
  const discount = voucher ? subtotal * VOUCHERS[voucher].pct : 0;
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
  return `<button class="${payMethod === 'cash' ? 'on' : ''}" onclick="setPay('cash')">Cash</button><button class="${payMethod === 'card' ? 'on' : ''}" onclick="setPay('card')">Card</button>`;
}
function cashRowHTML() {
  if (payMethod !== 'cash') return '';
  return `<div class="pos-cashrow"><span>Cash tendered</span><input id="cashGiven" placeholder="0.00" oninput="onCashInput()"></div>`;
}
function checkoutBtnState() {
  const { total } = cartTotals();
  const cashGiven = parseFloat(document.getElementById('cashGiven')?.value) || 0;
  const canCheckout = cart.length > 0 && (payMethod === 'card' || cashGiven >= total);
  const btn = document.getElementById('checkoutBtn');
  if (!btn) return;
  btn.disabled = !canCheckout;
  btn.style.opacity = canCheckout ? 1 : .45;
  btn.textContent = (payMethod === 'cash' && cashGiven > 0) ? `Charge · Change ${money(Math.max(cashGiven - total, 0))}` : 'Charge';
}
function refreshCartPanel() {
  document.getElementById('posLines').innerHTML = cartLinesHTML();
  document.getElementById('posTotals').innerHTML = totalsHTML();
  document.getElementById('voucherApplied').innerHTML = voucherChipHTML();
  document.getElementById('posPay').innerHTML = payButtonsHTML();
  document.getElementById('posCashRow').innerHTML = cashRowHTML();
  const cc = document.getElementById('cartCount'); if (cc) cc.textContent = cart.reduce((a, l) => a + l.qty, 0);
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
  if (VOUCHERS[code]) voucher = code;
  else { voucher = null; alert("Invalid code. Try SENIOR20, BULK10, or WELCOME5."); }
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
    document.getElementById('kpiTodayTx').textContent = stats.todayRows.length + ' transactions';
    document.getElementById('kpiLowStock').textContent = stats.lowStockCount;
  }
}

function finalizeSale() {
  const { subtotal, discount, tax, total } = cartTotals();
  const cashGiven = parseFloat(document.getElementById('cashGiven')?.value) || 0;
  const change = payMethod === 'cash' ? Math.max(cashGiven - total, 0) : 0;
  const pct = voucher ? VOUCHERS[voucher].pct : 0;

  const receiptLines = cart.map(l => {
    const effPrice = +(l.price * (1 - pct)).toFixed(2);
    const lineTotal = +(l.qty * effPrice).toFixed(2);
    // record the sale into the shared ledger — this is what makes
    // Analytics, Reports and the Sales Ledger update automatically
    sales.push({ date: fmtDate(today), sku: l.id, name: l.name, cat: l.cat, qty: l.qty, price: effPrice, cost: l.cost, total: lineTotal, profit: +(lineTotal - l.qty * l.cost).toFixed(2) });
    const prod = products.find(p => p.id === l.id);
    if (prod) prod.stock = Math.max(prod.stock - l.qty, 0);
    return { name: l.name, qty: l.qty, price: effPrice, lineTotal };
  });

  const tx = { id: ++txCounter, time: new Date(), lines: receiptLines, subtotal, discount, tax, total, payMethod, cashGiven, change, voucher };
  showReceipt(tx);
  cart = []; voucher = null;
  refreshCartPanel();
  document.getElementById('posCats').innerHTML = catButtonsHTML();
  document.getElementById('posGrid').innerHTML = posItemsHTML(filteredProducts());
  refreshDashboardKPIs();
}

function receiptHTML(tx) {
  return `
    <h3>Til · POS Console</h3>
    <div class="pr-sub">Receipt #${tx.id} · ${tx.time.toLocaleString()}</div>
    ${tx.lines.map(l => `<div class="pr-line"><span>${l.qty}× ${l.name}</span><span>${money(l.lineTotal)}</span></div>`).join('')}
    <hr>
    <div class="pr-line"><span>Subtotal</span><span>${money(tx.subtotal)}</span></div>
    ${tx.discount > 0 ? `<div class="pr-line"><span>Discount${tx.voucher ? ' (' + tx.voucher + ')' : ''}</span><span>-${money(tx.discount)}</span></div>` : ''}
    <div class="pr-line"><span>VAT (12%)</span><span>${money(tx.tax)}</span></div>
    <div class="pr-line" style="font-weight:700"><span>TOTAL</span><span>${money(tx.total)}</span></div>
    <hr>
    <div class="pr-line"><span>Paid via</span><span>${tx.payMethod.toUpperCase()}</span></div>
    ${tx.payMethod === 'cash' ? `<div class="pr-line"><span>Tendered</span><span>${money(tx.cashGiven)}</span></div><div class="pr-line"><span>Change</span><span>${money(tx.change)}</span></div>` : ''}`;
}
function receiptText(tx) {
  let l = ["TIL · POS CONSOLE", `Receipt #${tx.id}`, tx.time.toLocaleString(), '------------------------'];
  tx.lines.forEach(i => l.push(`${i.qty}x ${i.name}  ${money(i.lineTotal)}`));
  l.push('------------------------');
  l.push(`Subtotal  ${money(tx.subtotal)}`);
  if (tx.discount > 0) l.push(`Discount  -${money(tx.discount)}`);
  l.push(`VAT 12%   ${money(tx.tax)}`);
  l.push(`TOTAL     ${money(tx.total)}`);
  l.push('------------------------');
  l.push(`Paid via  ${tx.payMethod.toUpperCase()}`);
  if (tx.payMethod === 'cash') { l.push(`Tendered  ${money(tx.cashGiven)}`); l.push(`Change    ${money(tx.change)}`); }
  l.push('Thank you!');
  return l.join('\n');
}
function showReceipt(tx) {
  document.getElementById('posReceiptBody').innerHTML = receiptHTML(tx) + `
    <div class="pos-receipt-actions">
      <button class="btn" onclick="downloadReceipt(${tx.id})">Download</button>
      <button class="btn" style="background:var(--accent2)" onclick="toggleEmailRow(${tx.id})">Email</button>
    </div>
    <div class="pos-email-row" id="emailRow-${tx.id}"><input type="email" id="emailInput-${tx.id}" placeholder="name@email.com"><button class="btn" onclick="sendEmailReceipt(${tx.id})">Send</button></div>
    <div class="pos-sent" id="sentMsg-${tx.id}">Digital receipt sent (demo — no email is actually dispatched).</div>
    <button class="btn primary-full" onclick="closeReceipt()">New sale</button>`;
  window.__lastReceipt = tx;
  document.getElementById('posOverlay').classList.add('show');
}
function toggleEmailRow(id) { document.getElementById('emailRow-' + id).classList.toggle('show'); }
function sendEmailReceipt(id) {
  const val = document.getElementById('emailInput-' + id).value.trim();
  if (!val) return;
  const msg = document.getElementById('sentMsg-' + id);
  msg.textContent = `Digital receipt sent to ${val} (demo — no email is actually dispatched).`;
  msg.classList.add('show');
}
async function downloadReceipt(id) {
  const tx = window.__lastReceipt && window.__lastReceipt.id === id ? window.__lastReceipt : null;
  if (!tx) return;
  const text = receiptText(tx);
  try {
    const downloads = await claude.use("downloads");
    if (downloads) { await downloads.save({ filename: `receipt-${id}.txt`, data: text }); return; }
  } catch (e) { /* fall through to blob download */ }
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `receipt-${id}.txt`; a.click();
  URL.revokeObjectURL(url);
}
function closeReceipt() { document.getElementById('posOverlay').classList.remove('show'); }

// ---------- Views ----------
const views = {
  dashboard() {
    const stats = computeStats();
    const todayRev = stats.todayRows.reduce((a, r) => a + r.total, 0);
    return `
    <div class="sec grid g4">
      <div class="card kpi"><div class="l">Revenue today</div><div class="v num" id="kpiTodayRev">${money(todayRev)}</div><div class="d" id="kpiTodayTx">${stats.todayRows.length} transactions</div></div>
      <div class="card kpi"><div class="l">Items in cart</div><div class="v num" id="cartCount">${cart.reduce((a, l) => a + l.qty, 0)}</div><div class="d">Current sale</div></div>
      <div class="card kpi"><div class="l">Low stock items</div><div class="v num down" id="kpiLowStock">${stats.lowStockCount}</div><div class="d">need reordering</div></div>
      <div class="card kpi"><div class="l">Register</div><div class="v" style="font-size:1.05rem">Front counter</div><div class="d">Open · ${payMethod === 'cash' ? 'Cash drawer' : 'Card terminal'} ready</div></div>
    </div>
    <div class="sec grid g2">
      <div class="card">
        <div class="toolbar">
          <h2 style="margin:0">Ring up a sale — ${products.length} SKUs</h2>
          <input placeholder="Search product or SKU" value="${posQuery}" oninput="setPosQuery(this.value)">
        </div>
        <div class="pos-cats" id="posCats">${catButtonsHTML()}</div>
        <div class="pos-grid" id="posGrid">${posItemsHTML(filteredProducts())}</div>
      </div>
      <div class="card pos-cart">
        <h2>Current sale</h2>
        <div class="pos-lines" id="posLines">${cartLinesHTML()}</div>
        <div id="posTotals">${totalsHTML()}</div>
        <div class="pos-voucher">
          <div class="toolbar" style="margin-bottom:.3rem">
            <input id="voucherInput" placeholder="Voucher code" style="flex:1">
            <button class="btn" style="background:var(--accent2)" onclick="applyVoucher()">Apply</button>
          </div>
          <div class="hint">Try SENIOR20, BULK10, or WELCOME5</div>
          <div id="voucherApplied">${voucherChipHTML()}</div>
        </div>
        <div class="pos-pay" id="posPay">${payButtonsHTML()}</div>
        <div id="posCashRow">${cashRowHTML()}</div>
        <button class="btn" id="checkoutBtn" style="width:100%;margin-top:.5rem" onclick="finalizeSale()">Charge</button>
        <div class="hint"><a href="javascript:void(0)" onclick="clearCart()">Clear sale</a></div>
      </div>
    </div>`;
  },
  analytics() {
    const stats = computeStats();
    const wk1 = stats.salesByDay.slice(0, 7).reduce((a, d) => a + d.rev, 0);
    const wk2 = stats.salesByDay.slice(7, 14).reduce((a, d) => a + d.rev, 0);
    const trend = wk1 ? (((wk2 - wk1) / wk1) * 100).toFixed(1) : "0.0";
    return `
    <div class="sec grid g4">
      <div class="card kpi"><div class="l">Revenue (14d)</div><div class="v num">${money(stats.totalRev)}</div><div class="d ${trend >= 0 ? 'up' : 'down'}">${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend)}% vs prior week</div></div>
      <div class="card kpi"><div class="l">Gross Profit</div><div class="v num">${money(stats.totalProfit)}</div><div class="d">${((stats.totalProfit / stats.totalRev) * 100).toFixed(1)}% margin</div></div>
      <div class="card kpi"><div class="l">Transactions today</div><div class="v num">${stats.todayRows.length}</div><div class="d">${money(stats.todayRows.reduce((a, r) => a + r.total, 0))} sold</div></div>
      <div class="card kpi"><div class="l">Low stock items</div><div class="v num">${stats.lowStockCount}</div><div class="d down">need reordering</div></div>
    </div>
    <div class="sec grid g2">
      <div class="card"><h2>Revenue &amp; profit, last 14 days</h2><canvas id="trendChart"></canvas></div>
      <div class="card"><h2>Top products by revenue</h2><canvas id="topChart"></canvas></div>
    </div>
    <div class="sec card"><h2>Sales by category</h2><canvas id="catChart" style="max-height:220px"></canvas></div>`;
  },
  inventory() {
    const rows = products.map(p => {
      const status = p.stock === 0 ? 'out' : p.stock <= p.reorder ? 'low' : 'ok';
      return `<tr><td>${p.id}</td><td>${p.name}</td><td>${p.cat}</td><td class="num">${p.stock}</td><td class="num">${money(p.cost)}</td><td class="num">${money(p.price)}</td><td><span class="tag ${status}">${status === 'ok' ? 'In stock' : status === 'low' ? 'Low' : 'Out'}</span></td></tr>`;
    }).join('');
    return `<div class="card"><div class="toolbar"><h2 style="margin:0">Central stock inventory — ${products.length} SKUs</h2><input placeholder="Search product or SKU" oninput="filterInv(this.value)"></div>
    <div class="tw"><table id="invTable"><thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Stock</th><th>Cost</th><th>Price</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  },
  ledger() {
    const rows = [...sales].reverse().slice(0, 40).map(s => `<tr><td>${s.date}</td><td>${s.sku}</td><td>${s.name}</td><td class="num">${s.qty}</td><td class="num">${money(s.price)}</td><td class="num">${money(s.total)}</td><td class="num up">${money(s.profit)}</td></tr>`).join('');
    return `<div class="card"><h2>Daily sales ledger — ${sales.length} transactions over 14 days</h2>
    <div class="tw"><table><thead><tr><th>Date</th><th>SKU</th><th>Item</th><th>Qty</th><th>Price</th><th>Total</th><th>Profit</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="hint">Showing most recent 40 of ${sales.length} entries. New sales rung up on the Dashboard appear here instantly.</div></div>`;
  },
  products() {
    const rows = products.map(p => `<tr><td>${p.id}</td><td>${p.name}</td><td><select>${CATS.map(c => `<option ${c === p.cat ? 'selected' : ''}>${c}</option>`).join('')}</select></td><td><input class="num" style="width:70px" value="${p.cost}"></td><td><input class="num" style="width:70px" value="${p.price}"></td><td><input class="num" style="width:60px" value="${p.stock}"></td><td><button class="btn" style="background:var(--accent2)">Save</button></td></tr>`).join('');
    return `<div class="card"><div class="toolbar"><h2 style="margin:0">Product management</h2><button class="btn" onclick="alert('Add-product form would open here.')">+ Add product</button></div>
    <div class="tw"><table><thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>Cost</th><th>Price</th><th>Stock</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  },
  reports() {
    const stats = computeStats();
    return `<div class="grid g2">
    <div class="card"><h2>Profit &amp; Loss — trailing 14 days</h2>
      <div class="plrow"><span>Gross sales revenue</span><span class="num">${money(stats.totalRev)}</span></div>
      <div class="plrow"><span>Cost of goods sold</span><span class="num down">-${money(stats.totalCOGS)}</span></div>
      <div class="plrow total"><span>Gross profit</span><span class="num">${money(stats.totalProfit)}</span></div>
      ${Object.entries(opex).map(([k, v]) => `<div class="plrow"><span>${k}</span><span class="num down">-${money(v)}</span></div>`).join('')}
      <div class="plrow"><span>Total operating expenses</span><span class="num down">-${money(totalOpex)}</span></div>
      <div class="plrow total"><span>Net profit</span><span class="num ${stats.netProfit >= 0 ? 'up' : 'down'}">${money(stats.netProfit)}</span></div>
    </div>
    <div class="card"><h2>Report summary</h2>
      <div class="plrow"><span>Net margin</span><span class="num">${((stats.netProfit / stats.totalRev) * 100).toFixed(1)}%</span></div>
      <div class="plrow"><span>Avg. transaction value</span><span class="num">${money(stats.totalRev / sales.length)}</span></div>
      <div class="plrow"><span>Units sold</span><span class="num">${sales.reduce((a, s) => a + s.qty, 0)}</span></div>
      <div class="plrow"><span>Inventory value on hand</span><span class="num">${money(products.reduce((a, p) => a + p.stock * p.cost, 0))}</span></div>
      <div class="plrow"><span>SKUs below reorder point</span><span class="num down">${stats.lowStockCount}</span></div>
    </div></div>
    <div class="sec"></div>
    <div class="card"><h2>Daily sales report — today</h2>
      <div class="grid g4" style="margin-bottom:.9rem">
        <div><div class="l" style="color:var(--sub);font-size:.78rem">Revenue</div><div class="num" style="font-weight:700">${money(stats.todayRows.reduce((a, r) => a + r.total, 0))}</div></div>
        <div><div class="l" style="color:var(--sub);font-size:.78rem">Transactions</div><div class="num" style="font-weight:700">${stats.todayRows.length}</div></div>
        <div><div class="l" style="color:var(--sub);font-size:.78rem">Items sold</div><div class="num" style="font-weight:700">${stats.todayRows.reduce((a, r) => a + r.qty, 0)}</div></div>
        <div><div class="l" style="color:var(--sub);font-size:.78rem">Profit</div><div class="num" style="font-weight:700">${money(stats.todayRows.reduce((a, r) => a + r.profit, 0))}</div></div>
      </div>
      <div class="tw"><table><thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>
      ${stats.todayRows.length ? [...stats.todayRows].reverse().map(r => `<tr><td>${r.sku}</td><td>${r.name}</td><td class="num">${r.qty}</td><td class="num">${money(r.total)}</td></tr>`).join('') : `<tr><td colspan="4" class="hint">No sales rung up today yet — use the Dashboard to check out a sale.</td></tr>`}
      </tbody></table></div>
    </div>
    <div class="sec"></div>
    <div class="card"><h2>Category performance</h2><div class="tw"><table><thead><tr><th>Category</th><th>Revenue</th><th>Profit</th><th>Margin</th></tr></thead><tbody>
    ${CATS.map(c => { const rows = sales.filter(s => s.cat === c); const rev = rows.reduce((a, r) => a + r.total, 0); const pr = rows.reduce((a, r) => a + r.profit, 0); return `<tr><td>${c}</td><td class="num">${money(rev)}</td><td class="num">${money(pr)}</td><td class="num">${rev ? ((pr / rev) * 100).toFixed(1) : '0.0'}%</td></tr>`; }).join('')}
    </tbody></table></div></div>`;
  }
};

function filterInv(q) {
  q = q.toLowerCase();
  document.querySelectorAll('#invTable tbody tr').forEach(tr => {
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

const tabDefs = [["dashboard", "Dashboard"], ["analytics", "Analytics"], ["inventory", "Inventory"], ["ledger", "Sales Ledger"], ["products", "Products"], ["reports", "Reports"]];
function render(tab) {
  document.getElementById('nav').innerHTML = tabDefs.map(([id, label]) => `<button class="${id === tab ? 'on' : ''}" onclick="render('${id}')">${label}</button>`).join('');
  destroyCharts();
  document.getElementById('main').innerHTML = views[tab]();
  if (tab === 'analytics') drawDashboardCharts();
  history.replaceState(null, '', '#' + tab);
}
render(location.hash.slice(1) in views ? location.hash.slice(1) : 'dashboard');
