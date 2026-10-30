'use strict';

// Standalone HTML for /internal/cost (internalCostRoutes.js). Inline CSS and
// JS, no external requests. Every value from the API is written with
// textContent, never as HTML.
const COST_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cost Monitor</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#5d6670;--line:#e3e6ea;--accent:#2f6fd6;--accent2:#9db8ea;--warn:#b5471b;--ok:#1d7f4e}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e22;--ink:#e8eaed;--muted:#9aa3ad;--line:#2c3036;--accent:#6c9ef0;--accent2:#34507f;--warn:#f08a5d;--ok:#5cc28d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{font-size:20px;margin:0}
h2{font-size:15px;margin:0 0 10px}
.muted{color:var(--muted)}
.small{font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.kpi .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.kpi .l{font-size:12px;color:var(--muted)}
.controls{display:flex;gap:6px;flex-wrap:wrap}
button,input{font:inherit;color:inherit}
button{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}
button.on{background:var(--accent);border-color:var(--accent);color:#fff}
input{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{font-size:12px;color:var(--muted);font-weight:600;cursor:pointer;user-select:none}
td.route{font-family:ui-monospace,Menlo,monospace;font-size:12px;max-width:380px;overflow:hidden;text-overflow:ellipsis}
.tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:10px;border:1px solid var(--line);color:var(--muted);margin-left:6px}
.bar{height:6px;background:var(--accent2);border-radius:3px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:760px){.grid2{grid-template-columns:1fr}}
svg text{fill:var(--muted);font-size:10px}
#login{max-width:380px;margin:12vh auto}
.err{color:var(--warn)}
</style>
</head>
<body>
<main>
  <section id="login" class="card" hidden>
    <h1>Cost Monitor</h1>
    <p class="muted">Internal page. Enter the access key.</p>
    <form id="loginForm"><input id="key" type="password" autocomplete="off" placeholder="Access key" aria-label="Access key"><p></p><button class="on" type="submit">Open</button></form>
    <p id="loginErr" class="err small"></p>
  </section>

  <section id="app" hidden>
    <header>
      <div><h1>Cost Monitor</h1><div class="muted small" id="range"></div></div>
      <div class="controls">
        <button data-h="6">6h</button><button data-h="24">24h</button><button data-h="72">3d</button><button data-h="168">7d</button><button data-h="336">14d</button>
        <button id="refresh">Refresh</button><button id="logout">Lock</button>
      </div>
    </header>
    <div class="kpis" id="kpis"></div>
    <div class="card">
      <h2>Estimated Data Store cost per hour (₹)</h2>
      <div id="chart"></div>
    </div>
    <div class="card">
      <h2>Components</h2>
      <div class="tablewrap"><table id="components"></table></div>
    </div>
    <div class="grid2">
      <div class="card"><h2>CRM API calls by org</h2><div class="tablewrap"><table id="orgs"></table></div></div>
      <div class="card"><h2>Last API credits seen</h2><div class="tablewrap"><table id="credits"></table></div></div>
    </div>
    <p class="muted small" id="notes"></p>
  </section>
</main>
<script>
(function () {
  var KEY = 'mgCostKey', HOURS = 'mgCostHours';
  var dataUrl = location.pathname.replace(/\\/+$/, '') + '/data';
  var hours = 24, sortKey = 'costInr', data = null;
  try { hours = Number(localStorage.getItem(HOURS)) || 24; } catch (e) {}
  function getKey() { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function setKey(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch (e) {} }
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, text, cls) { var n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
  var nf = new Intl.NumberFormat('en-IN');
  function num(n) { return nf.format(Math.round(n || 0)); }
  function inr(n) { return '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 }); }
  function dsOps(ds) { return (ds.fetch || 0) + (ds.insert || 0) + (ds.update || 0) + (ds.delete || 0); }

  function showLogin(msg) { $('app').hidden = true; $('login').hidden = false; $('loginErr').textContent = msg || ''; $('key').focus(); }
  $('loginForm').addEventListener('submit', function (e) { e.preventDefault(); setKey($('key').value.trim()); $('key').value = ''; load(); });
  $('logout').addEventListener('click', function () { setKey(''); showLogin(); });
  $('refresh').addEventListener('click', load);
  Array.prototype.forEach.call(document.querySelectorAll('[data-h]'), function (b) {
    b.addEventListener('click', function () { hours = Number(b.dataset.h); try { localStorage.setItem(HOURS, hours); } catch (e) {} load(); });
  });

  function load() {
    var key = getKey();
    if (!key) return showLogin();
    fetch(dataUrl + '?hours=' + hours, { headers: { 'X-Internal-Key': key }, cache: 'no-store' })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.status === 401) { setKey(''); return showLogin('That key was not accepted.'); }
        if (r.status !== 200) { $('login').hidden = true; $('app').hidden = false; $('notes').textContent = 'Error: ' + (r.body.error || r.status); return; }
        data = r.body; render();
      })
      .catch(function (e) { showLogin('Could not reach the server: ' + e.message); });
  }

  function kpi(label, value, sub) {
    var d = el('div', undefined, 'kpi'); d.appendChild(el('div', value, 'v')); d.appendChild(el('div', label, 'l'));
    if (sub) d.appendChild(el('div', sub, 'l')); return d;
  }

  function render() {
    $('login').hidden = true; $('app').hidden = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-h]'), function (b) { b.classList.toggle('on', Number(b.dataset.h) === hours); });
    $('range').textContent = data.from + ':00 → ' + data.to + ':59 IST';
    var t = data.totals, k = $('kpis'); k.textContent = '';
    k.appendChild(kpi('Estimated Data Store cost', inr(t.costInr), 'about ' + inr(t.projectedMonthlyInr) + ' / 30 days at this rate'));
    k.appendChild(kpi('Requests', num(t.requests), num(t.errors) + ' server errors'));
    k.appendChild(kpi('Data Store ops', num(dsOps(t.ds)), num(t.ds.fetch) + ' fetch · ' + num(t.ds.insert + t.ds.update + t.ds.delete) + ' write'));
    k.appendChild(kpi('Rows read', num(t.ds.fetchRows)));
    k.appendChild(kpi('CRM API calls', num(t.api), num(t.tokenRefresh) + ' token refreshes'));
    k.appendChild(kpi('Idle sweeps', num(t.idle), num(t.unchanged) + ' unchanged notifications'));
    chart(); components(); orgs(); credits();
    var notes = 'Prices per op: fetch ' + data.prices.fetch + ', insert ' + data.prices.insert + ', update ' + data.prices.update + ', delete ' + data.prices.delete + ' (₹). '
      + 'Counted by the function itself and saved hourly; an instance recycled before saving loses its last minutes, so these are a floor. The Catalyst billing page is the source of truth.';
    if (data.truncated) notes += ' Only the first ' + data.rowsRead + ' saved rows were read; pick a shorter range.';
    if (data.unreadable) notes += ' ' + data.unreadable + ' saved rows could not be read.';
    $('notes').textContent = notes;
  }

  function chart() {
    var box = $('chart'); box.textContent = '';
    var rows = data.hourly, W = Math.max(box.clientWidth || 600, 300), H = 180, pad = 28;
    var max = Math.max.apply(null, rows.map(function (r) { return r.costInr; }).concat([0.0001]));
    var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', '100%'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Estimated cost per hour');
    var bw = (W - pad) / Math.max(rows.length, 1);
    rows.forEach(function (r, i) {
      var h = (H - 30) * (r.costInr / max), x = pad + i * bw;
      var rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', x + 1); rect.setAttribute('y', H - 18 - h); rect.setAttribute('width', Math.max(bw - 2, 1)); rect.setAttribute('height', Math.max(h, r.costInr > 0 ? 1 : 0));
      rect.setAttribute('rx', 2); rect.setAttribute('fill', 'var(--accent)');
      var tip = document.createElementNS(NS, 'title');
      tip.textContent = r.hour + ':00 IST — ' + inr(r.costInr) + ', ' + num(r.requests) + ' requests, ' + num(dsOps(r.ds)) + ' ops, ' + num(r.api) + ' API calls';
      rect.appendChild(tip); svg.appendChild(rect);
      var every = Math.ceil(rows.length / 12);
      if (i % every === 0) {
        var label = document.createElementNS(NS, 'text');
        label.setAttribute('x', x + 1); label.setAttribute('y', H - 4);
        label.textContent = rows.length > 48 ? r.hour.slice(5, 10) + ' ' + r.hour.slice(11) : r.hour.slice(11) + 'h';
        svg.appendChild(label);
      }
    });
    var top = document.createElementNS(NS, 'text'); top.setAttribute('x', 0); top.setAttribute('y', 12); top.textContent = inr(max); svg.appendChild(top);
    box.appendChild(svg);
  }

  var COLS = [
    ['route', 'Component'], ['requests', 'Requests'], ['costInr', '₹ est.'], ['fetch', 'Fetch'], ['fetchRows', 'Rows read'],
    ['writes', 'Writes'], ['api', 'API calls'], ['tokenRefresh', 'Token refresh'], ['idle', 'Idle'], ['errors', '5xx'], ['avgMs', 'Avg ms'],
  ];
  function value(c, key) {
    if (key === 'fetch' || key === 'fetchRows') return c.ds[key];
    if (key === 'writes') return c.ds.insert + c.ds.update + c.ds.delete;
    return c[key];
  }
  function components() {
    var table = $('components'); table.textContent = '';
    var head = el('tr');
    COLS.forEach(function (col) {
      var th = el('th', col[1] + (sortKey === col[0] ? ' ▾' : ''));
      th.addEventListener('click', function () { sortKey = col[0]; components(); });
      head.appendChild(th);
    });
    table.appendChild(head);
    var list = data.components.slice().sort(function (a, b) {
      var x = value(a, sortKey), y = value(b, sortKey);
      return typeof x === 'string' ? String(x).localeCompare(y) : (y || 0) - (x || 0);
    });
    var maxCost = Math.max.apply(null, list.map(function (c) { return c.costInr; }).concat([0.0001]));
    if (!list.length) { var r = el('tr'), td = el('td', 'No usage saved for this range yet. Totals are saved about every 10 minutes.'); td.colSpan = COLS.length; r.appendChild(td); table.appendChild(r); }
    list.forEach(function (c) {
      var tr = el('tr');
      COLS.forEach(function (col) {
        var v = value(c, col[0]), td;
        if (col[0] === 'route') {
          td = el('td', undefined, 'route'); td.title = c.route; td.appendChild(document.createTextNode(c.route));
          if (c.trigger) td.appendChild(el('span', c.trigger, 'tag'));
          var orgs = Object.keys(c.apiByOrg || {});
          if (orgs.length) td.title += '\\nAPI: ' + orgs.map(function (o) { return o + ' ' + c.apiByOrg[o]; }).join(', ');
        } else if (col[0] === 'costInr') {
          td = el('td', inr(v)); var bar = el('div', undefined, 'bar'); bar.style.width = Math.round(100 * v / maxCost) + '%'; td.appendChild(bar);
        } else td = el('td', num(v));
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  }
  function simple(id, headers, rows) {
    var table = $(id); table.textContent = '';
    var head = el('tr'); headers.forEach(function (h) { head.appendChild(el('th', h)); }); table.appendChild(head);
    if (!rows.length) { var r = el('tr'), td = el('td', 'None in this range'); td.colSpan = headers.length; r.appendChild(td); table.appendChild(r); }
    rows.forEach(function (cells) { var tr = el('tr'); cells.forEach(function (c) { tr.appendChild(el('td', c)); }); table.appendChild(tr); });
  }
  function orgs() { simple('orgs', ['Org', 'Calls'], data.orgs.map(function (o) { return [o.org, num(o.calls)]; })); }
  function credits() {
    simple('credits', ['Org', 'Remaining', 'Hour (IST)'], Object.keys(data.credits).map(function (o) { return [o, num(data.credits[o].value), data.credits[o].hour + ':00']; }));
  }
  window.addEventListener('resize', function () { if (data) chart(); });
  load();
})();
</script>
</body>
</html>
`;

module.exports = { COST_PAGE_HTML };
