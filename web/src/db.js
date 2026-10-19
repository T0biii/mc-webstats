import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 8,
  waitForConnections: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  charset: 'utf8mb4',
});

/** Small TTL cache so a busy site (or a bot) cannot hammer the aggregate queries. */
const cache = new Map();
export async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

const num = (v) => Number(v ?? 0);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Leaderboards: either a single stat or the sum of a whole category. */
export const LEADERBOARDS = {
  playtime: { title: 'Playtime', unit: 'ticks', column: 'playtime_ticks' },
  mined: { title: 'Blocks mined', unit: 'count', category: 'minecraft:mined' },
  mob_kills: { title: 'Mobs killed', unit: 'count', category: 'minecraft:custom', stat: 'minecraft:mob_kills' },
  deaths: { title: 'Deaths', unit: 'count', category: 'minecraft:custom', stat: 'minecraft:deaths' },
  walked: { title: 'Distance walked', unit: 'cm', category: 'minecraft:custom', stat: 'minecraft:walk_one_cm' },
  jumps: { title: 'Jumps', unit: 'count', category: 'minecraft:custom', stat: 'minecraft:jump' },
};

export async function leaderboard(key, limit = 10) {
  const lb = LEADERBOARDS[key];
  if (!lb) return null;
  let rows;
  if (lb.column) {
    [rows] = await pool.query(
      `SELECT uuid, name, ${lb.column} AS value FROM players WHERE ${lb.column} > 0 ORDER BY value DESC LIMIT ?`,
      [limit],
    );
  } else if (lb.stat) {
    [rows] = await pool.query(
      `SELECT p.uuid, p.name, s.value FROM player_stats s JOIN players p ON p.uuid = s.uuid
       WHERE s.category = ? AND s.stat = ? AND s.value > 0 ORDER BY s.value DESC LIMIT ?`,
      [lb.category, lb.stat, limit],
    );
  } else {
    [rows] = await pool.query(
      `SELECT p.uuid, p.name, SUM(s.value) AS value FROM player_stats s JOIN players p ON p.uuid = s.uuid
       WHERE s.category = ? GROUP BY p.uuid, p.name HAVING value > 0 ORDER BY value DESC LIMIT ?`,
      [lb.category, limit],
    );
  }
  return {
    key,
    title: lb.title,
    unit: lb.unit,
    entries: rows.map((r) => ({ uuid: r.uuid, name: r.name, value: num(r.value) })),
  };
}

export async function serverStats() {
  const [[totals]] = await pool.query(
    'SELECT COUNT(*) AS players, COALESCE(SUM(playtime_ticks), 0) AS playtime FROM players',
  );
  const [catRows] = await pool.query(
    `SELECT category, SUM(value) AS total FROM player_stats
     WHERE category IN ('minecraft:mined','minecraft:crafted','minecraft:broken','minecraft:used',
                        'minecraft:picked_up','minecraft:dropped','minecraft:killed','minecraft:killed_by')
     GROUP BY category`,
  );
  const [customRows] = await pool.query(
    `SELECT stat, SUM(value) AS total FROM player_stats
     WHERE category = 'minecraft:custom'
       AND stat IN ('minecraft:deaths','minecraft:mob_kills','minecraft:player_kills','minecraft:jump',
                    'minecraft:walk_one_cm','minecraft:sprint_one_cm','minecraft:fly_one_cm',
                    'minecraft:swim_one_cm','minecraft:boat_one_cm','minecraft:aviate_one_cm',
                    'minecraft:damage_dealt','minecraft:damage_taken','minecraft:fish_caught',
                    'minecraft:animals_bred','minecraft:traded_with_villager')
     GROUP BY stat`,
  );
  const [topMined] = await pool.query(
    `SELECT stat, SUM(value) AS total FROM player_stats WHERE category = 'minecraft:mined'
     GROUP BY stat ORDER BY total DESC LIMIT 10`,
  );
  const [topKilled] = await pool.query(
    `SELECT stat, SUM(value) AS total FROM player_stats WHERE category = 'minecraft:killed'
     GROUP BY stat ORDER BY total DESC LIMIT 10`,
  );

  const categories = Object.fromEntries(catRows.map((r) => [r.category.replace('minecraft:', ''), num(r.total)]));
  const custom = Object.fromEntries(customRows.map((r) => [r.stat.replace('minecraft:', ''), num(r.total)]));
  const distanceCm = ['walk', 'sprint', 'fly', 'swim', 'boat', 'aviate']
    .reduce((sum, k) => sum + (custom[`${k}_one_cm`] ?? 0), 0);

  return {
    players: num(totals.players),
    playtimeTicks: num(totals.playtime),
    blocksMined: categories.mined ?? 0,
    itemsCrafted: categories.crafted ?? 0,
    mobKills: custom.mob_kills ?? 0,
    playerKills: custom.player_kills ?? 0,
    deaths: custom.deaths ?? 0,
    jumps: custom.jump ?? 0,
    distanceCm,
    damageDealt: custom.damage_dealt ?? 0,
    damageTaken: custom.damage_taken ?? 0,
    fishCaught: custom.fish_caught ?? 0,
    animalsBred: custom.animals_bred ?? 0,
    villagerTrades: custom.traded_with_villager ?? 0,
    categories,
    topMined: topMined.map((r) => ({ stat: r.stat, value: num(r.total) })),
    topKilled: topKilled.map((r) => ({ stat: r.stat, value: num(r.total) })),
  };
}

/** Latest snapshot + online player list + last 24h history (max ~96 points). */
export async function liveStatus() {
  const [[latest]] = await pool.query('SELECT ts, online, max, tps FROM server_snapshots ORDER BY ts DESC LIMIT 1');
  const fresh = latest && Date.now() - num(latest.ts) < config.snapshotIntervalSeconds * 3000;
  const [players] = fresh
    ? await pool.query('SELECT uuid, name FROM players WHERE online = 1 ORDER BY name')
    : [[]];
  const since = Date.now() - 24 * 3600 * 1000;
  const [history] = await pool.query(
    'SELECT ts, online FROM server_snapshots WHERE ts >= ? ORDER BY ts',
    [since],
  );
  return {
    serverName: config.serverName,
    up: Boolean(fresh),
    online: fresh ? latest.online : 0,
    max: latest ? latest.max : 0,
    tps: latest ? num(latest.tps) : null,
    updatedAt: latest ? num(latest.ts) : null,
    players,
    history: downsample(history.map((h) => ({ ts: num(h.ts), online: h.online })), 96),
  };
}

function downsample(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, i) => points[Math.floor(i * step)]);
}

const SORTS = {
  name: 'name ASC',
  playtime: 'playtime_ticks DESC',
  last_seen: 'online DESC, last_seen DESC',
};

export async function listPlayers({ search = '', sort = 'playtime', limit = 48, offset = 0 }) {
  const order = SORTS[sort] ?? SORTS.playtime;
  const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const [rows] = await pool.query(
    `SELECT uuid, name, playtime_ticks, last_seen, online FROM players
     WHERE name LIKE ? ORDER BY ${order}, name ASC LIMIT ? OFFSET ?`,
    [like, limit, offset],
  );
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM players WHERE name LIKE ?', [like]);
  return {
    total: num(total),
    players: rows.map((r) => ({
      uuid: r.uuid,
      name: r.name,
      playtimeTicks: num(r.playtime_ticks),
      lastSeen: num(r.last_seen),
      online: Boolean(r.online),
    })),
  };
}

export async function getPlayer(uuid) {
  const [[p]] = await pool.query(
    'SELECT uuid, name, playtime_ticks, last_seen, online FROM players WHERE uuid = ?',
    [uuid],
  );
  if (!p) return null;
  const [rows] = await pool.query('SELECT category, stat, value FROM player_stats WHERE uuid = ?', [uuid]);
  const stats = {};
  for (const r of rows) {
    (stats[r.category.replace('minecraft:', '')] ??= []).push({ stat: r.stat, value: num(r.value) });
  }
  for (const list of Object.values(stats)) list.sort((a, b) => b.value - a.value);
  return {
    uuid: p.uuid,
    name: p.name,
    playtimeTicks: num(p.playtime_ticks),
    lastSeen: num(p.last_seen),
    online: Boolean(p.online),
    stats,
  };
}

export async function getSkinUrl(uuid) {
  const [[row]] = await pool.query('SELECT skin_url FROM players WHERE uuid = ?', [uuid]);
  return row ? { exists: true, skinUrl: row.skin_url } : { exists: false, skinUrl: null };
}
