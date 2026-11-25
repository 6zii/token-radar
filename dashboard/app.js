// Token Radar's dashboard, radar-2. It reads window.RADAR — the dataset main.ts writes beside
// dashboard/ — and renders the ranked board, a filterable table, and a per-protocol detail drawer
// carrying the model's own inputs and the protocol's farm plan. No network: every byte it shows
// is already in data.js.
//
// The view lives in the URL hash, so any view opens directly: #detail=<slug> opens a protocol,
// #filter=<category> filters by category, #chain=<chain> filters by chain, #tab=pre-token|live
// picks the tab, #q=<text> searches, #watchlist=1 shows the watchlist only. The older #p= and
// #category= spellings still work.
(function () {
  'use strict';

  var data = window.RADAR;
  if (!data) return;
  var app = document.getElementById('board');
  var view = {
    query: '',
    category: 'all',
    chain: 'all',
    watchlistOnly: false,
    tab: 'pre-token',
    sortKey: 'implied',
    sortDir: -1,
    selected: null,
  };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /** A dollar amount, shortened to $x.xxB / $x.xM / $xK once it is large. */
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  /** A percentage with an explicit sign. */
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  /** An age in days, as years once it passes one. */
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  /** A multiple with three decimals and an x. */
  function multipleLabel(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(3) + 'x';
  }

  // A row is on the watchlist when its TVL reaches the floor: the board's early rows are all
  // below it, so the floor alone separates the two.
  function onWatchlist(row) { return row.tvl_usd >= data.floor_usd; }

  // The model, run again in the page: the drawer recomputes a row from the snapshot figures and
  // checks the number board.json carries, so the page's code and the board's data are visibly
  // the same arithmetic.
  function recomputeImplied(row, model) {
    var size = Math.sqrt(Math.max(0, row.tvl_usd) * Math.max(1, data.floor_usd));
    var catMult = row.category_multiple;
    var change = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, change));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    return Math.max(1, Math.round(size * catMult * growthMult * maturity));
  }

  /** Build an element: `attrs` sets class/text/html/handlers/attributes, the rest are children. */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else if (value !== null && value !== undefined) node.setAttribute(key, value);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        child.forEach(function (item) { if (item) node.appendChild(item); });
      } else if (typeof child === 'string') {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
    return node;
  }

  /** Read the view out of the URL hash. */
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.query = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('detail')) view.selected = params.get('detail');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('filter')) view.category = params.get('filter');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('tab')) view.tab = params.get('tab') === 'live' ? 'live' : 'pre-token';
    if (params.get('watchlist')) view.watchlistOnly = params.get('watchlist') === '1';
  }
  /** Write the view back into the URL hash. */
  function writeHash() {
    var params = new URLSearchParams();
    if (view.query) params.set('q', view.query);
    if (view.category !== 'all') params.set('filter', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.watchlistOnly) params.set('watchlist', '1');
    if (view.tab === 'live') params.set('tab', 'live');
    if (view.selected) params.set('detail', view.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /** The board rows the current filters leave, before sorting. */
  function visibleRows() {
    var q = view.query.trim().toLowerCase();
    return data.rows.filter(function (row) {
      if (view.category !== 'all' && row.category !== view.category) return false;
      if (view.chain !== 'all' && !(row.chains || []).includes(view.chain)) return false;
      if (view.watchlistOnly && !onWatchlist(row)) return false;
      if (!q) return true;
      var haystack = [row.name, row.slug, row.category, (row.chains || []).join(' ')].join(' ').toLowerCase();
      return haystack.indexOf(q) >= 0;
    });
  }
  /** The visible rows in the current sort order. */
  function sortedVisible(list) {
    var key = view.sortKey;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -view.sortDir;
      if (av > bv) return view.sortDir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  /** The short chain label under a protocol's name: at most two chains. */
  function chainLabel(row) {
    var chains = row.chains && row.chains.length ? row.chains.slice(0, 2).join(', ') : 'an unnamed chain';
    return (row.category || 'Other') + ' on ' + chains;
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + data.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: data.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: data.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(data.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + data.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: data.watchlist_size + ' / ' + data.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(data.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(data.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(data.live_size) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(data.rows.map(function (row) { return row.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(data.rows.reduce(function (acc, row) { return acc.concat(row.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.query, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.query = search.value; writeHash(); render(); });
    var categorySelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); })
    );
    categorySelect.addEventListener('change', function () { view.category = categorySelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === view.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { view.chain = chainSelect.value; writeHash(); render(); });
    var watchlistToggle = el('button', { type: 'button', class: 'toggle', 'aria-pressed': view.watchlistOnly ? 'true' : 'false', text: 'Watchlist only', onclick: function () { view.watchlistOnly = !view.watchlistOnly; writeHash(); render(); } });
    var preTab = el('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; writeHash(); render(); } });
    var liveTab = el('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), categorySelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Scope' }), watchlistToggle),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, preTab, liveTab)),
      el('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : data.live.length + ' live-token protocols' })
    );
  }

  /** A sortable column header: clicking it picks the key, clicking again flips the direction. */
  function sortHeader(key, label) {
    var active = view.sortKey === key;
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (active) view.sortDir = -view.sortDir; else { view.sortKey = key; view.sortDir = -1; } render(); } },
        label,
        active ? el('span', { 'aria-hidden': 'true', text: view.sortDir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  /** One board row, with its growth, age, implied value bar and scope badge. */
  function boardRow(row, maxImplied) {
    var growth = row.change_7d === null ? 'n/a' : pct(row.change_7d);
    var growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
    var badge = onWatchlist(row)
      ? el('span', { class: 'badge', text: 'Watchlist' })
      : el('span', { class: 'badge early', text: 'Early' });
    var width = Math.max(3, Math.round((row.implied_value_usd / maxImplied) * 100));
    return el('tr', {
      'data-selected': view.selected === row.slug ? 'true' : 'false',
      tabindex: '0',
      onclick: function () { openDetail(row.slug); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(row.slug); } }
    },
      el('td', { class: 'num', text: String(row.rank) }),
      el('td', null, el('div', { class: 'name' },
        el('b', { text: row.name }),
        el('span', { class: 'sub', text: chainLabel(row) })
      )),
      el('td', { class: 'num', text: money(row.tvl_usd) }),
      el('td', { class: 'num ' + growthClass, text: growth }),
      el('td', { class: 'num', text: ageLabel(row.age_days) }),
      el('td', null, el('div', { class: 'implied' },
        el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + width + '%' })),
        el('span', { class: 'num', text: money(row.implied_value_usd) })
      )),
      el('td', null, badge)
    );
  }

  function boardTable() {
    var list = sortedVisible(visibleRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.query = ''; view.category = 'all'; view.chain = 'all'; view.watchlistOnly = false; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (row) { tbody.appendChild(boardRow(row, max)); });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Scope' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    data.live.forEach(function (row) {
      var growthClass = row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: row.name }), el('span', { class: 'sub', text: chainLabel(row) }))),
        el('td', { class: 'num', text: money(row.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: pct(row.change_7d) }),
        el('td', { class: 'num', text: money(row.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = data.model;
    var categories = Object.keys(data.category_multiples || {}).sort();
    var cells = categories.map(function (c) {
      return el('div', { class: 'multiple' }, el('span', { text: c }), el('b', { text: multipleLabel(data.category_multiples[c]) }));
    });
    cells.push(el('div', { class: 'multiple' }, el('span', { text: 'All other categories' }), el('b', { text: multipleLabel(data.overall_multiple) })));
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = round( sqrt(tvl_usd x $' + Math.round(data.floor_usd / 1e6) + 'M floor) x category multiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )'
      ),
      el('p', { class: 'sub', text: 'Size is sublinear: the square root of TVL times the watchlist floor, so a protocol ten times larger does not score ten times higher. The category multiple is the median market-cap / TVL of the live-token protocols in the same category (at least ' + m.category_min_live + ' of them, otherwise the overall median of ' + multipleLabel(data.overall_multiple) + '), clamped to [' + m.category_multiple_floor + ', ' + m.category_multiple_cap + ']. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days.' }),
      el('h3', { text: 'Category multiples from the live market' }),
      el('div', { class: 'multiples' }, cells)
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { view.selected = null; writeHash(); });

  /** The note under the equation: which multiple this row's category gets, and why. */
  function multipleNote(row) {
    if (row.category && data.category_multiples[row.category] !== undefined) {
      return 'Live ' + row.category + ' protocols trade at a median ' + multipleLabel(data.category_multiples[row.category]) + ' of TVL.';
    }
    return 'No live-token ' + (row.category || 'other') + ' protocols report a multiple, so the overall median of ' + multipleLabel(data.overall_multiple) + ' applies.';
  }

  function openDetail(slug) {
    var row = data.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    view.selected = slug;
    writeHash();
    dialog.textContent = '';
    var recomputed = recomputeImplied(row, data.model);
    var matches = recomputed === row.implied_value_usd;
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + data.board_size + (onWatchlist(row) ? ' · Watchlist' : ' · Early') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: money(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Size (sqrt of TVL x floor)' }), el('b', { class: 'num', text: money(row.size_usd) })),
        el('div', null, el('span', { text: 'Category multiple' }), el('b', { class: 'num', text: multipleLabel(row.category_multiple) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: pct(row.change_7d) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: ageLabel(row.age_days) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: money(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: multipleNote(row) }),
      el('p', { class: 'sub', text: 'Model ' + data.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(recomputed) + (matches ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, (row.farm_steps || []).map(function (step) {
        var at = step.indexOf(' Cost: ');
        var action = at >= 0 ? step.slice(0, at) : step;
        var tail = at >= 0 ? step.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(view.tab === 'pre-token' ? boardTable() : liveTable());
    if (view.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (view.selected) openDetail(view.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
