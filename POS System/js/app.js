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
const salesByDay = days.map(d => {
  const rows = sales.filter(s => s.date === fmtDate(d));
  return { date: fmtDate(d).slice(5), rev: +rows.reduce((a, r) => a + r.total, 0).toFixed(2), profit: +rows.reduce((a, r) => a + r.profit, 0).toFixed(2), tx: rows.length };
});
const totalRev = +sales.reduce((a, r) => a + r.total, 0).toFixed(2);
const totalProfit = +sales.reduce((a, r) => a + r.profit, 0).toFixed(2);
const totalCOGS = +(totalRev - totalProfit).toFixed(2);
const todayRows = sales.filter(s => s.date === fmtDate(today));
const opex = { "Rent": 1800, "Wages": 2600, "Utilities": 320, "Marketing": 250, "Misc": 180 };
const totalOpex = Object.values(opex).reduce((a, b) => a + b, 0);
const netProfit = +(totalProfit - totalOpex).toFixed(2);
const money = n => "₱" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// top products
const byProduct = {};
sales.forEach(s => { byProduct[s.sku] = byProduct[s.sku] || { name: s.name, qty: 0, rev: 0, profit: 0 }; byProduct[s.sku].qty += s.qty; byProduct[s.sku].rev += s.total; byProduct[s.sku].profit += s.profit; });
const topProducts = Object.values(byProduct).sort((a, b) => b.rev - a.rev).slice(0, 6);

// ---------- Views ----------
const views = {
  dashboard() {
    const wk1 = salesByDay.slice(0, 7).reduce((a, d) => a + d.rev, 0);
    const wk2 = salesByDay.slice(7, 14).reduce((a, d) => a + d.rev, 0);
    const trend = (((wk2 - wk1) / wk1) * 100).toFixed(1);
    return `
    <div class="sec grid g4">
      <div class="card kpi"><div class="l">Revenue (14d)</div><div class="v num">${money(totalRev)}</div><div class="d ${trend >= 0 ? 'up' : 'down'}">${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend)}% vs prior week</div></div>
      <div class="card kpi"><div class="l">Gross Profit</div><div class="v num">${money(totalProfit)}</div><div class="d">${((totalProfit / totalRev) * 100).toFixed(1)}% margin</div></div>
      <div class="card kpi"><div class="l">Transactions today</div><div class="v num">${todayRows.length}</div><div class="d">${money(todayRows.reduce((a, r) => a + r.total, 0))} sold</div></div>
      <div class="card kpi"><div class="l">Low stock items</div><div class="v num">${products.filter(p => p.stock <= p.reorder).length}</div><div class="d down">need reordering</div></div>
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
    <div class="hint">Showing most recent 40 of ${sales.length} entries.</div></div>`;
  },
  products() {
    const rows = products.map(p => `<tr><td>${p.id}</td><td>${p.name}</td><td><select>${CATS.map(c => `<option ${c === p.cat ? 'selected' : ''}>${c}</option>`).join('')}</select></td><td><input class="num" style="width:70px" value="${p.cost}"></td><td><input class="num" style="width:70px" value="${p.price}"></td><td><input class="num" style="width:60px" value="${p.stock}"></td><td><button class="btn" style="background:var(--accent2)">Save</button></td></tr>`).join('');
    return `<div class="card"><div class="toolbar"><h2 style="margin:0">Product management</h2><button class="btn" onclick="alert('Add-product form would open here.')">+ Add product</button></div>
    <div class="tw"><table><thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>Cost</th><th>Price</th><th>Stock</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  },
  reports() {
    return `<div class="grid g2">
    <div class="card"><h2>Profit &amp; Loss — trailing 14 days</h2>
      <div class="plrow"><span>Gross sales revenue</span><span class="num">${money(totalRev)}</span></div>
      <div class="plrow"><span>Cost of goods sold</span><span class="num down">-${money(totalCOGS)}</span></div>
      <div class="plrow total"><span>Gross profit</span><span class="num">${money(totalProfit)}</span></div>
      ${Object.entries(opex).map(([k, v]) => `<div class="plrow"><span>${k}</span><span class="num down">-${money(v)}</span></div>`).join('')}
      <div class="plrow"><span>Total operating expenses</span><span class="num down">-${money(totalOpex)}</span></div>
      <div class="plrow total"><span>Net profit</span><span class="num ${netProfit >= 0 ? 'up' : 'down'}">${money(netProfit)}</span></div>
    </div>
    <div class="card"><h2>Report summary</h2>
      <div class="plrow"><span>Net margin</span><span class="num">${((netProfit / totalRev) * 100).toFixed(1)}%</span></div>
      <div class="plrow"><span>Avg. transaction value</span><span class="num">${money(totalRev / sales.length)}</span></div>
      <div class="plrow"><span>Units sold</span><span class="num">${sales.reduce((a, s) => a + s.qty, 0)}</span></div>
      <div class="plrow"><span>Inventory value on hand</span><span class="num">${money(products.reduce((a, p) => a + p.stock * p.cost, 0))}</span></div>
      <div class="plrow"><span>SKUs below reorder point</span><span class="num down">${products.filter(p => p.stock <= p.reorder).length}</span></div>
    </div></div>
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
  const axis = { ticks: { color: getComputedStyle(document.body).getPropertyValue('--sub') }, grid: { color: getComputedStyle(document.body).getPropertyValue('--line') } };
  charts.push(new Chart(document.getElementById('trendChart'), {
    type: 'line', data: {
      labels: salesByDay.map(d => d.date), datasets: [
        { label: 'Revenue', data: salesByDay.map(d => d.rev), borderColor: '#C96A3E', backgroundColor: '#C96A3E22', tension: .3, fill: true },
        { label: 'Profit', data: salesByDay.map(d => d.profit), borderColor: '#3F8F7E', backgroundColor: '#3F8F7E22', tension: .3, fill: true }
      ]
    }, options: { plugins: { legend: { labels: { color: axis.ticks.color } } }, scales: { x: axis, y: axis } }
  }));
  charts.push(new Chart(document.getElementById('topChart'), { type: 'bar', data: { labels: topProducts.map(p => p.name.split(' ').slice(0, 2).join(' ')), datasets: [{ label: 'Revenue', data: topProducts.map(p => +p.rev.toFixed(2)), backgroundColor: '#C96A3E' }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: axis, y: axis } } }));
  charts.push(new Chart(document.getElementById('catChart'), { type: 'bar', data: { labels: CATS, datasets: [{ label: 'Revenue', data: CATS.map(c => +sales.filter(s => s.cat === c).reduce((a, r) => a + r.total, 0).toFixed(2)), backgroundColor: '#3F8F7E' }] }, options: { plugins: { legend: { display: false } }, scales: { x: axis, y: axis } } }));
}

const tabDefs = [["dashboard", "Dashboard"], ["inventory", "Inventory"], ["ledger", "Sales Ledger"], ["products", "Products"], ["reports", "Reports"]];
function render(tab) {
  document.getElementById('nav').innerHTML = tabDefs.map(([id, label]) => `<button class="${id === tab ? 'on' : ''}" onclick="render('${id}')">${label}</button>`).join('');
  destroyCharts();
  document.getElementById('main').innerHTML = views[tab]();
  if (tab === 'dashboard') drawDashboardCharts();
  history.replaceState(null, '', '#' + tab);
}
render(location.hash.slice(1) in views ? location.hash.slice(1) : 'dashboard');
