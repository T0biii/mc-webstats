const app = document.getElementById('app');
const pill = document.getElementById('live-pill');

// ---------- helpers ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const nf = new Intl.NumberFormat('en');
const fmtNum = (n) => nf.format(Math.round(n));
const fmtCompact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : fmtNum(n));

function fmtTicks(t) {
  const s = Math.floor(t / 20);
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  return `${m}m ${s % 60}s`;
}
const fmtDist = (cm) => (cm >= 100000 ? `${(cm / 100000).toFixed(1)} km` : `${(cm / 100).toFixed(0)} m`);
const fmtDamage = (v) => `${fmtNum(v / 10)} HP`;

function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function prettyName(key) {
  const name = key.includes(':') ? key.split(':').slice(1).join(':') : key;
  return name.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format a stat value according to what the key means. */
function fmtStat(category, stat, value) {
  if (category === 'custom') {
    if (stat.endsWith('_one_cm')) return fmtDist(value);
    if (/(_time|play_time|play_one_minute|time_since_|total_world_time)/.test(stat)) return fmtTicks(value);
    if (/^minecraft:(damage_|.*_absorbed|.*_resisted)/.test(stat)) return fmtDamage(value);
  }
  return fmtNum(value);
}

const headUrl = (uuid, size = 64) => `/head/${uuid}.webp?size=${size}`;
const headImg = (uuid, cls = '', size = 64, alt = '') =>
  h('img', { class: `head ${cls}`, src: headUrl(uuid, size), alt, width: size, height: size, loading: 'lazy' });

function link(href, ...children) {
  return h('a', { href, 'data-link': true }, ...children);
}

function tile(label, value) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value));
}

function setTitle(t) {
  document.title = t;
}

// ---------- live pill (all pages) ----------
async function refreshLive() {
  try {
    const live = await api('/api/live');
    document.getElementById('server-name').textContent = live.serverName;
    pill.className = `pill ${live.up ? 'up' : 'down'}`;
    pill.textContent = live.up ? `ONLINE ${live.online}/${live.max}` : 'OFFLINE';
    return live;
  } catch {
    pill.className = 'pill down';
    pill.textContent = 'NO DATA';
    return null;
  }
}

// ---------- home ----------
async function renderHome() {
  app.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const [live, server, boards] = await Promise.all([refreshLive(), api('/api/server'), api('/api/leaderboards')]);
  setTitle(`${live?.serverName ?? 'Server'} Stats`);

  const tiles = h('div', { class: 'grid tiles' },
    tile('Players', fmtNum(server.players)),
    tile('Total playtime', fmtTicks(server.playtimeTicks)),
    tile('Blocks mined', fmtCompact(server.blocksMined)),
    tile('Items crafted', fmtCompact(server.itemsCrafted)),
    tile('Mobs killed', fmtCompact(server.mobKills)),
    tile('Deaths', fmtCompact(server.deaths)),
    tile('Distance travelled', fmtDist(server.distanceCm)),
    tile('Jumps', fmtCompact(server.jumps)),
    tile('Damage dealt', fmtDamage(server.damageDealt)),
    tile('Fish caught', fmtCompact(server.fishCaught)),
    tile('Animals bred', fmtCompact(server.animalsBred)),
    tile('Villager trades', fmtCompact(server.villagerTrades)),
  );

  const onlinePanel = h('section', { class: 'panel' },
    h('h2', {}, 'Online now'),
    live?.players?.length
      ? h('div', { class: 'grid players' }, live.players.map((p) => playerCard(p)))
      : h('div', { class: 'empty' }, live?.up ? 'Nobody online right now.' : 'Server is offline.'),
  );

  const chartPanel = h('section', { class: 'panel' }, h('h2', {}, 'Players, last 24 hours'), chart(live?.history ?? [], live?.max));

  const boardPanels = h('div', { class: 'grid cols-2' }, boards.map(leaderboardPanel));
  const tops = h('div', { class: 'grid cols-2' },
    topList('Most mined blocks', server.topMined, 'mined'),
    topList('Most killed mobs', server.topKilled, 'killed'),
  );

  const players = await playersSection();
  app.replaceChildren(
    h('h1', {}, 'Server statistics'), tiles, h('div', { style: 'height:24px' }),
    onlinePanel, chartPanel, h('h1', {}, 'Leaderboards'), boardPanels, h('div', { style: 'height:24px' }), tops,
    h('h1', {}, 'Players'), players,
  );
}

function playerCard(p) {
  return link(`/player/${p.uuid}`,
    h('div', { class: 'player-card' },
      headImg(p.uuid, '', 64, ''),
      h('div', { class: 'name' }, p.online ? h('span', { class: 'online-dot' }) : null, p.name),
      p.playtimeTicks != null ? h('div', { class: 'meta' }, p.online ? fmtTicks(p.playtimeTicks) : `seen ${fmtAgo(p.lastSeen)}`) : null,
    ));
}

function chart(history, max) {
  if (history.length < 2) return h('div', { class: 'empty panel inset' }, 'Not enough data yet.');
  const top = Math.max(1, max || 0, ...history.map((p) => p.online));
  const fmtT = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return h('div', {},
    h('div', { class: 'chart panel inset', style: 'margin:0' },
      history.map((p) => h('div', { class: 'bar', style: `height:${Math.max(3, (p.online / top) * 100)}%`, title: `${fmtT(p.ts)} · ${p.online} online` }))),
    h('div', { class: 'chart-axis' }, h('span', {}, fmtT(history[0].ts)), h('span', {}, `peak ${Math.max(...history.map((p) => p.online))}`), h('span', {}, fmtT(history.at(-1).ts))),
  );
}

function fmtBoard(unit, v) {
  return unit === 'ticks' ? fmtTicks(v) : unit === 'cm' ? fmtDist(v) : fmtNum(v);
}

function leaderboardPanel(lb) {
  return h('section', { class: 'panel', style: 'margin:0' },
    h('h2', {}, lb.title),
    lb.entries.length
      ? h('ol', { class: 'lb-list' }, lb.entries.map((e, i) =>
        h('li', {},
          h('span', { class: 'lb-rank' }, `#${i + 1}`),
          headImg(e.uuid, 'small', 32, ''),
          h('span', { class: 'lb-name' }, link(`/player/${e.uuid}`, e.name)),
          h('span', { class: 'lb-value' }, fmtBoard(lb.unit, e.value)))))
      : h('div', { class: 'empty' }, 'No data yet.'),
  );
}

function topList(title, rows, category) {
  return h('section', { class: 'panel', style: 'margin:0' },
    h('h2', {}, title),
    rows.length
      ? h('ol', { class: 'lb-list' }, rows.map((r, i) =>
        h('li', {}, h('span', { class: 'lb-rank' }, `#${i + 1}`), h('span', { class: 'lb-name' }, prettyName(r.stat)), h('span', { class: 'lb-value' }, fmtStat(category, r.stat, r.value)))))
      : h('div', { class: 'empty' }, 'No data yet.'),
  );
}

async function playersSection() {
  const state = { q: '', sort: 'playtime', page: 1 };
  const list = h('div', { class: 'grid players' });
  const pager = h('div', { class: 'pager' });
  const search = h('input', { type: 'search', placeholder: 'Search player…', maxlength: '32', 'aria-label': 'Search player' });
  const sort = h('select', { 'aria-label': 'Sort players' },
    h('option', { value: 'playtime' }, 'Most playtime'),
    h('option', { value: 'last_seen' }, 'Last seen'),
    h('option', { value: 'name' }, 'Name A–Z'));

  async function load() {
    const qs = new URLSearchParams({ q: state.q, sort: state.sort, page: state.page });
    const data = await api(`/api/players?${qs}`);
    list.replaceChildren(...(data.players.length ? data.players.map(playerCard) : [h('div', { class: 'empty' }, 'No players found.')]));
    const pages = Math.max(1, Math.ceil(data.total / 48));
    pager.replaceChildren(
      h('button', { disabled: state.page <= 1, onclick: () => { state.page--; load(); } }, '< Prev'),
      h('span', {}, `${state.page} / ${pages}`),
      h('button', { disabled: state.page >= pages, onclick: () => { state.page++; load(); } }, 'Next >'),
    );
  }
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = search.value.trim(); state.page = 1; load(); }, 250);
  });
  sort.addEventListener('change', () => { state.sort = sort.value; state.page = 1; load(); });
  await load();
  return h('section', { class: 'panel' }, h('div', { class: 'toolbar' }, search, sort), list, pager);
}

// ---------- player page ----------
const CATEGORY_LABELS = {
  custom: 'General', mined: 'Mined', crafted: 'Crafted', used: 'Used', broken: 'Broken',
  picked_up: 'Picked up', dropped: 'Dropped', killed: 'Killed', killed_by: 'Killed by',
};

async function renderPlayer(uuid) {
  app.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  refreshLive();
  let p;
  try {
    p = await api(`/api/players/${uuid}`);
  } catch {
    app.replaceChildren(h('div', { class: 'panel' }, h('h1', {}, 'Player not found'), link('/', '< Back')));
    return;
  }
  setTitle(`${p.name} · Stats`);

  const custom = Object.fromEntries((p.stats.custom ?? []).map((s) => [s.stat.replace('minecraft:', ''), s.value]));
  const sum = (cat) => (p.stats[cat] ?? []).reduce((a, s) => a + s.value, 0);
  const dist = ['walk', 'sprint', 'fly', 'swim', 'boat', 'aviate'].reduce((a, k) => a + (custom[`${k}_one_cm`] ?? 0), 0);

  const header = h('div', { class: 'player-head' },
    headImg(p.uuid, 'big', 128, p.name),
    h('div', {},
      h('h1', { style: 'margin:0 0 10px' }, p.name),
      h('div', { class: 'muted' }, p.online ? h('span', {}, h('span', { class: 'online-dot' }), 'Online now') : `Last seen ${fmtAgo(p.lastSeen)}`),
      h('div', { style: 'margin-top:12px' }, link('/', '< All players'))),
  );

  const tiles = h('div', { class: 'grid tiles' },
    tile('Playtime', fmtTicks(p.playtimeTicks)),
    tile('Blocks mined', fmtCompact(sum('mined'))),
    tile('Mobs killed', fmtCompact(custom.mob_kills ?? 0)),
    tile('Deaths', fmtCompact(custom.deaths ?? 0)),
    tile('Distance', fmtDist(dist)),
    tile('Jumps', fmtCompact(custom.jump ?? 0)),
  );

  const cats = Object.keys(CATEGORY_LABELS).filter((c) => p.stats[c]?.length);
  const body = h('div', {});
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const search = h('input', { type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter stats', maxlength: '40' });
  let active = cats[0];

  function draw() {
    const needle = search.value.trim().toLowerCase();
    const rows = (p.stats[active] ?? []).filter((s) => !needle || prettyName(s.stat).toLowerCase().includes(needle));
    body.replaceChildren(rows.length
      ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Stat'), h('th', { class: 'num' }, 'Value'))),
        h('tbody', {}, rows.map((s) => h('tr', {}, h('td', {}, prettyName(s.stat)), h('td', { class: 'num' }, fmtStat(active, s.stat, s.value))))))
      : h('div', { class: 'empty' }, 'Nothing here.'));
    tabs.replaceChildren(...cats.map((c) =>
      h('button', { class: 'tab', role: 'tab', 'aria-selected': String(c === active), onclick: () => { active = c; draw(); } }, CATEGORY_LABELS[c])));
  }
  search.addEventListener('input', draw);
  draw();

  app.replaceChildren(header, tiles, h('div', { style: 'height:24px' }),
    cats.length
      ? h('section', { class: 'panel' }, tabs, h('div', { class: 'toolbar' }, search), body)
      : h('div', { class: 'panel empty' }, 'No statistics recorded yet.'));
}

// ---------- router ----------
async function route() {
  window.scrollTo(0, 0);
  const m = location.pathname.match(/^\/player\/([0-9a-f-]{36})\/?$/i);
  try {
    if (m) await renderPlayer(m[1]);
    else await renderHome();
  } catch (err) {
    console.error(err);
    app.replaceChildren(h('div', { class: 'panel empty' }, 'Could not load data. Try again in a moment.'));
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  history.pushState({}, '', a.getAttribute('href'));
  route();
});
window.addEventListener('popstate', route);
setInterval(refreshLive, 60_000);
route();
