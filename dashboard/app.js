'use strict';

// Local data is the sole input. Text always enters the page through textContent.
const radar = window.RADAR;
const byId = id => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0});
const state = {query: '', category: '', chain: '', watchlist: false, minTvl: 0, sort: 'rank', direction: 1};
let selectedSlug = null;
let detailTrigger = null;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function money(value, exact = false) {
  if (value == null || !Number.isFinite(value)) return 'Unreported';
  if (exact) return usd.format(value);
  for (const [scale, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (Math.abs(value) >= scale) return '$' + (value / scale).toFixed(2) + suffix;
  }
  return usd.format(value);
}
function percent(value) {
  return value == null ? '—' : (value > 0 ? '+' : '') + value.toFixed(2) + '%';
}
function isWatched(row) {
  return typeof row.watchlist === 'boolean' ? row.watchlist : row.tvl_usd >= radar.floor_usd;
}
function knownAge(row) {
  return row.age_known !== false && row.listed_at != null;
}
function filterRows(rows, filters) {
  const query = filters.query.trim().toLowerCase();
  return rows.filter(row => (!query || row.name.toLowerCase().includes(query) || row.slug.toLowerCase().includes(query))
    && (!filters.category || (row.category || 'Uncategorized') === filters.category)
    && (!filters.chain || row.chains.includes(filters.chain))
    && (!filters.watchlist || isWatched(row)) && row.tvl_usd >= filters.minTvl);
}
function sortRows(rows, key, direction) {
  return rows.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    // Unreported growth remains at the end in either direction.
    if (av == null && bv != null) return 1;
    if (bv == null && av != null) return -1;
    const comparison = typeof av === 'string' ? av.localeCompare(bv) : (av ?? 0) - (bv ?? 0);
    return comparison * direction || a.rank - b.rank;
  });
}
function getFactors(row, model) {
  const growth = Math.max(model.growth_floor, Math.min(model.growth_cap, row.change_7d ?? model.unknown_growth_pct));
  const age = row.age_days ?? model.unknown_age_days;
  return {
    base: model.base_scale_usd * Math.log1p(row.tvl_usd / model.tvl_scale_usd),
    growth: 1 + model.growth_weight * growth / 100,
    maturity: model.maturity_floor + model.maturity_range * Math.min(age, model.maturity_days) / model.maturity_days,
    chain: 1 + Math.min(model.chain_bonus_cap, model.chain_log_weight * Math.log2(Math.max(1, row.chains.length)))
  };
}

// Same category precedence, capital thresholds and holding periods as lib/model.ts.
// Generated from the row; no dependency on board.json or prewritten plan fields.
function farmActions(category, capital) {
  const c = (category ?? '').toLowerCase();
  if (/lend|cdp|collateral/.test(c)) return [
    `Supply $${capital} of an asset supported in the app's documented lending or collateral market; leave borrowing disabled and record the withdrawal terms`,
    'Add $5 to the same supplied position; record the receipt and updated balance'];
  if (/bridge/.test(c)) return [
    `Use the published route selector to bridge $${capital} from another supported chain to the chain below; verify the destination balance and keep the receipt`,
    'Bridge $5 on the same supported route once; record both transaction receipts and the received amount'];
  if (/stak|restaked/.test(c)) return [
    `Stake $${capital} of the documented staking asset in the app; record the receipt balance, lock and unbonding delay`,
    'Add $5 through the same staking flow and record the receipt balance; do not compound with borrowed funds'];
  if (/perp|derivative|options|synthetic|basis/.test(c)) return [
    `Fund the documented trading account with $${capital}; if supported, execute one unlevered trade of at most $5 and close it; retain the remaining collateral`,
    'Execute and close one supported unlevered trade of at most $5; log realized costs and skip if leverage is mandatory'];
  if (/rwa/.test(c)) return [
    `Check eligibility, redemption windows and minimums; if eligible and the minimum allows it, subscribe $${capital} to a documented real-world-asset product`,
    'Review the issuer statement and redemption status; add $5 only if the published minimum permits it, otherwise log a review without transacting'];
  if (/dex|liquidity/.test(c)) return [
    `Split $${capital} across the two assets of a documented liquid pool and add liquidity using the app's default range; record the receipt and pool fee`,
    'Swap $5 through the same app at a maximum 0.5% slippage; record the receipt and pool position balance'];
  if (/yield|farm|curator|allocator|vault|index/.test(c)) return [
    `Deposit $${capital} into one documented unlevered vault or strategy; read the underlying exposure and withdrawal queue before approving`,
    'Add $5 to the same vault or strategy; record shares received, fees and any withdrawal queue change'];
  if (/stable|reserve/.test(c)) return [
    `Use $${capital} in a documented mint or deposit flow, verify backing and redemption terms, and record the receipt balance`,
    'Repeat the supported mint or deposit with $5 and record the resulting balance and redemption quote'];
  if (/prediction/.test(c)) return [
    `Set aside a $${capital} participation budget and buy at most $5 of one outcome using the documented market flow; leave the remainder uncommitted`,
    'Review settlement terms and place at most one $5 outcome purchase if eligible; log the maximum possible loss'];
  return [
    `Reserve $${capital} for the app's documented participation flow; read eligibility, minimums and exit terms, test with $5, then commit the remainder only if the flow fits`,
    'Repeat the same documented participation action with at most $5 and record the receipt; skip if the app offers no suitable action'];
}
function capitalFor(row) {
  return row.tvl_usd >= 5e9 ? 250 : row.tvl_usd >= 1e9 ? 150 : row.tvl_usd >= 1e8 ? 100 : 50;
}
function holdDaysFor(row) {
  const age = row.age_days ?? radar.model.unknown_age_days;
  return age < 180 ? 60 : age < 365 ? 45 : 30;
}
function farmSteps(row) {
  const chain = row.chains[0] ?? 'the chain confirmed by the protocol documentation';
  const capital = capitalFor(row), hold = holdDaysFor(row);
  const [position, weekly] = farmActions(row.category, capital);
  return [
    `Create a fresh wallet for ${row.name} on ${chain}, keep its recovery phrase offline and verify the app through the protocol's own published link. The snapshot records no token. Cost: $${capital} reserved capital plus a $10 gas budget, not a fee quote. Time: 10 minutes.`,
    `${position}. Use ${chain}; if the documented asset, route or minimum is unavailable, skip the position. Cost: up to $${capital} capital plus a $5 gas/fee budget. Time: 20 minutes.`,
    `${weekly}. Treat it as a candidate qualifying action only when the protocol publishes matching eligibility rules; do not assume rewards. Cost: up to $5 extra capital plus $3 gas/fees per week. Time: 10 minutes every 7 days.`,
    `Maintain the documented position or bridged balance for a planned ${hold} days and inspect withdrawal terms each week; exit sooner if the exposure no longer fits. Holding does not guarantee eligibility. Cost: up to $${capital} capital remains exposed, plus weekly additions; $0 gas to hold. Time: ${hold} days and 5 minutes per weekly review.`,
    `Check ${row.name}'s own published eligibility or rewards link, if one exists. Claim only through that published link after checking permissions; if no program is published, log that fact and make no claim. Cost: $0 to check; budget at most $5 gas for a verified claim. Time: 10 minutes per check.`,
    `Keep a farm log for ${row.name}: wallet address, ${chain}, dates, transaction receipts, capital, gas, balances and exit or claim checks. Reconcile weekly and record the final withdrawal. Cost: $0 for the log; reserve $5 gas for exit. Time: 5 minutes now, 5 minutes weekly and 10 minutes to reconcile exit.`
  ];
}

function numberCell(value, className = '') {
  return node('td', value, 'num right ' + className);
}
function chainCell(row) {
  const cell = node('td', null, 'chain-list');
  cell.append(node('span', row.chains.slice(0, 2).join(', ') || 'Unreported'));
  if (row.chains.length > 2) cell.append(node('span', '+' + (row.chains.length - 2), 'chain-more'));
  cell.title = row.chains.join(', ');
  return cell;
}
function changeCell(row) {
  const cell = numberCell(percent(row.change_7d), row.change_7d == null ? 'unknown' : row.change_7d >= 0 ? 'positive' : 'negative');
  if (row.change_7d == null) cell.title = 'Seven-day TVL change unreported; model uses ' + radar.model.unknown_growth_pct + '%';
  return cell;
}
function renderBoard() {
  const rows = sortRows(filterRows(radar.rows, state), state.sort, state.direction);
  const maxValue = Math.max(...radar.rows.map(row => row.implied_value_usd), 1);
  const rendered = rows.map(row => {
    const tr = node('tr');
    tr.dataset.slug = row.slug;
    const identity = node('td', null, 'protocol-cell');
    const nameLine = node('div', null, 'name-line');
    const button = node('button', row.name, 'protocol-button');
    button.type = 'button';
    tr.addEventListener('click', () => openDetail(row.slug, button));
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', event => { event.stopPropagation(); openDetail(row.slug, button); });
    nameLine.append(button);
    if (isWatched(row)) nameLine.append(node('span', 'WATCHLIST', 'watch-badge'));
    identity.append(nameLine, node('span', row.slug, 'slug'));
    const value = numberCell(null, 'value-cell');
    value.append(node('span', money(row.implied_value_usd), 'value-number'));
    const track = node('span', null, 'value-track'), bar = node('i');
    bar.style.width = Math.max(1, row.implied_value_usd / maxValue * 100) + '%';
    track.setAttribute('aria-hidden', 'true');
    track.append(bar); value.append(track);
    value.title = money(row.implied_value_usd, true);
    const tvl = numberCell(money(row.tvl_usd)); tvl.title = money(row.tvl_usd, true);
    const age = numberCell(knownAge(row) ? row.age_days + 'd' : '—', 'unknown');
    age.title = knownAge(row) ? 'Days since listing; not a launch date' : 'Listing date unreported; model uses ' + radar.model.unknown_age_days + ' days';
    tr.append(node('td', String(row.rank).padStart(2, '0'), 'num rank' + (row.rank <= 3 ? ' top-rank' : '')), identity,
      node('td', row.category || 'Uncategorized', 'category-text'), chainCell(row), tvl, changeCell(row), age, value);
    return tr;
  });
  byId('board-body').replaceChildren(...rendered);
  byId('result-count').textContent = 'Showing ' + rows.length + ' of ' + radar.rows.length;
  byId('empty-state').hidden = rows.length !== 0;
  const labels = {rank: 'Rank', name: 'Protocol', tvl_usd: 'TVL', change_7d: '7d %', implied_value_usd: 'Implied value'};
  for (const key of Object.keys(labels)) {
    const active = state.sort === key;
    byId('head-' + key).setAttribute('aria-sort', active ? state.direction === 1 ? 'ascending' : 'descending' : 'none');
    byId('sort-' + key).replaceChildren(node('span', labels[key]), node('span', active ? state.direction === 1 ? '↑' : '↓' : '↕'));
  }
}
function resetFilters() {
  Object.assign(state, {query: '', category: '', chain: '', watchlist: false, minTvl: 0});
  for (const id of ['search', 'category', 'chain', 'min-tvl']) byId(id).value = '';
  byId('watchlist').checked = false;
  renderBoard();
}
function renderLive() {
  byId('live-body').replaceChildren(...radar.live.map(row => {
    const tr = node('tr'), identity = node('td');
    identity.append(node('strong', row.name), node('span', row.slug, 'slug'));
    const mcap = numberCell(money(row.mcap_usd), 'value-cell');
    mcap.title = money(row.mcap_usd, true) + ' recorded market cap';
    tr.append(identity, node('td', row.category || 'Uncategorized', 'category-text'), chainCell(row), numberCell(money(row.tvl_usd)), changeCell(row), mcap);
    return tr;
  }));
  byId('live-count').textContent = radar.live.length + ' live-token protocols · snapshot values only';
}
function setTab(tab) {
  const board = tab === 'board';
  byId('board-panel').hidden = !board;
  byId('live-panel').hidden = board;
  for (const key of ['board', 'live']) {
    const active = key === tab;
    byId(key + '-tab').setAttribute('aria-selected', String(active));
    byId(key + '-tab').tabIndex = active ? 0 : -1;
  }
}
function factList(target, items) {
  byId(target).replaceChildren(...items.map(([label, value]) => {
    const pair = node('div'); pair.append(node('dt', label), node('dd', value)); return pair;
  }));
}
function openDetail(slug, trigger) {
  const row = radar.rows.find(item => item.slug === slug);
  if (!row) return;
  selectedSlug = slug;
  detailTrigger = trigger || null;
  const f = getFactors(row, radar.model);
  const modelValue = Math.max(1, Math.round(f.base * f.growth * f.maturity * f.chain));
  byId('detail-rank').textContent = 'RANK ' + row.rank + ' / ' + radar.rows.length + (isWatched(row) ? ' · WATCHLIST' : ' · EARLY RADAR');
  byId('detail-title').textContent = row.name;
  byId('detail-meta').textContent = row.slug + ' / ' + (row.category || 'Uncategorized');
  byId('detail-value').textContent = money(row.implied_value_usd, true);
  factList('detail-facts', [
    ['Slug', row.slug], ['Category', row.category || 'Uncategorized'], ['Chains', row.chains.join(', ') || 'Unreported'],
    ['TVL', money(row.tvl_usd, true)], ['7d TVL change', row.change_7d == null ? 'Unreported' : percent(row.change_7d)],
    ['Listed date / UTC', row.listed_at || 'Unreported'], ['Age / days', knownAge(row) ? String(row.age_days) : 'Unknown; model uses ' + radar.model.unknown_age_days]
  ]);
  factList('detail-factors', [
    ['Log TVL base', money(f.base, true)], ['Effective base multiple', (f.base / row.tvl_usd).toFixed(4) + '× TVL'],
    ['Growth multiplier', (row.growth_multiplier ?? f.growth).toFixed(4) + '×'],
    ['Maturity multiplier', (row.maturity_multiplier ?? f.maturity).toFixed(4) + '×'],
    ['Chain bonus', f.chain.toFixed(4) + '×'], ['Rounded result', money(modelValue, true)]
  ]);
  byId('detail-check').textContent = modelValue === row.implied_value_usd ? '✓ Recomputed from this row. Matches the ranked value.' : 'Data mismatch: the recomputed value differs from the ranked value.';
  byId('farm-budget').textContent = '$' + capitalFor(row) + ' starting capital / ' + holdDaysFor(row) + '-day planned hold / ' + (row.chains[0] || 'documented chain');
  const titles = ['Prepare a dedicated wallet', 'Establish the position', 'Build a weekly routine', 'Hold & review', 'Verify eligibility', 'Keep the evidence'];
  byId('farm-steps').replaceChildren(...farmSteps(row).map((step, index) => {
    const costAt = step.indexOf(' Cost: '), timeAt = step.indexOf(' Time: ');
    const li = node('li');
    li.append(node('strong', titles[index], 'step-title'), node('p', step.slice(0, costAt), 'step-action'));
    const meta = node('div', null, 'step-meta'), cost = node('span'), time = node('span');
    cost.append(node('b', 'Cost: '), document.createTextNode(step.slice(costAt + 7, timeAt)));
    time.append(node('b', 'Time: '), document.createTextNode(step.slice(timeAt + 7)));
    meta.append(cost, time); li.append(meta); return li;
  }));
  const dialog = byId('detail');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function renderModel() {
  const m = radar.model;
  byId('model-version').textContent = radar.model_version;
  byId('model-summary').textContent = 'Snapshot ' + radar.as_of + '. The ' + money(radar.floor_usd) + ' TVL floor defines the watchlist; ' + radar.early_size + ' selected protocols below it extend the radar. The same formula scores every row, using TVL, seven-day TVL growth, listing age and chain count.';
  const formulas = [
    'Base = ' + money(m.base_scale_usd, true) + ' × ln(1 + TVL / ' + money(m.tvl_scale_usd, true) + ')',
    'Growth = 1 + ' + m.growth_weight + ' × clamp(7d %, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100',
    'Maturity = ' + m.maturity_floor + ' + ' + m.maturity_range + ' × min(age, ' + m.maturity_days + ') / ' + m.maturity_days,
    'Chains = 1 + min(' + m.chain_bonus_cap + ', ' + m.chain_log_weight + ' × log2(max(1, chain count)))',
    'Implied value = max(1, round(base × growth × maturity × chains))',
    'Missing growth → ' + m.unknown_growth_pct + '%; missing age → ' + m.unknown_age_days + ' days. Age is days since listing, not time since launch.'
  ];
  byId('model-constants').replaceChildren(...formulas.map(text => node('p', text)));
}
function init() {
  if (!radar || !Array.isArray(radar.rows) || !radar.model || !Array.isArray(radar.live)) {
    byId('data-error').hidden = false;
    byId('result-count').textContent = 'No local snapshot loaded';
    return;
  }
  byId('snapshot-date').textContent = radar.as_of;
  byId('snapshot-date').dateTime = radar.as_of;
  byId('stat-board').textContent = radar.rows.length;
  byId('stat-watch').textContent = radar.rows.filter(isWatched).length + ' / ' + radar.watchlist_size;
  byId('stat-early').textContent = radar.early_size;
  byId('stat-live').textContent = radar.live.length;
  byId('watch-floor').textContent = money(radar.floor_usd) + ' TVL floor · all covered';
  byId('board-tab-count').textContent = radar.rows.length;
  byId('live-tab-count').textContent = radar.live.length;
  // Source may contain an endpoint. Show its identity without printing any address.
  byId('source-note').textContent = 'DefiLlama snapshot / ' + radar.as_of + ' / ' + radar.model_version;
  for (const [id, values] of [['category', radar.rows.map(row => row.category || 'Uncategorized')], ['chain', radar.rows.flatMap(row => row.chains)]]) {
    for (const value of [...new Set(values)].sort()) {
      const option = node('option', value); option.value = value; byId(id).append(option);
    }
  }
  const updateFilters = () => {
    state.query = byId('search').value;
    state.category = byId('category').value;
    state.chain = byId('chain').value;
    state.watchlist = byId('watchlist').checked;
    state.minTvl = Math.max(0, Number(byId('min-tvl').value) || 0);
    renderBoard();
  };
  byId('filters').addEventListener('submit', event => event.preventDefault());
  for (const id of ['search', 'min-tvl']) byId(id).addEventListener('input', updateFilters);
  for (const id of ['category', 'chain', 'watchlist']) byId(id).addEventListener('change', updateFilters);
  for (const id of ['reset', 'empty-reset']) byId(id).addEventListener('click', resetFilters);
  for (const key of ['rank', 'name', 'tvl_usd', 'change_7d', 'implied_value_usd']) {
    byId('sort-' + key).addEventListener('click', () => {
      state.direction = state.sort === key ? -state.direction : key === 'rank' || key === 'name' ? 1 : -1;
      state.sort = key; renderBoard();
    });
  }
  for (const tab of ['board', 'live']) {
    byId(tab + '-tab').addEventListener('click', () => setTab(tab));
    byId(tab + '-tab').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'board' : event.key === 'End' ? 'live' : tab === 'board' ? 'live' : 'board';
      setTab(next); byId(next + '-tab').focus();
    });
  }
  const dialog = byId('detail');
  byId('close-detail').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { selectedSlug = null; if (detailTrigger) detailTrigger.focus(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  renderBoard(); renderLive(); renderModel();
}
init();
