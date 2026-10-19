import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { UUID_RE, cached, getPlayer, leaderboard, LEADERBOARDS, listPlayers, liveStatus, pool, serverStats } from './db.js';
import { HEAD_SIZES, getHead } from './heads.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// trustProxy: we sit behind Cloudflare (and optionally cloudflared / a reverse proxy).
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

// Cloudflare caches by Cache-Control when "Respect Existing Headers" / cache rules are on.
const edge = (seconds) => `public, max-age=${seconds}, s-maxage=${seconds}`;

app.register(fastifyStatic, {
  root: path.join(root, 'public'),
  maxAge: '5m',
});
app.register(fastifyStatic, {
  root: [
    path.join(root, 'node_modules/@fontsource/press-start-2p/files'),
    path.join(root, 'node_modules/@fontsource/vt323/files'),
  ],
  prefix: '/fonts/',
  decorateReply: false,
  maxAge: '365d',
  immutable: true,
});

app.get('/healthz', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});

app.get('/api/live', async (_req, reply) => {
  reply.header('Cache-Control', edge(30));
  return cached('live', 15_000, liveStatus);
});

app.get('/api/server', async (_req, reply) => {
  reply.header('Cache-Control', edge(60));
  return cached('server', 60_000, serverStats);
});

app.get('/api/leaderboards', async (_req, reply) => {
  reply.header('Cache-Control', edge(60));
  return cached('leaderboards', 60_000, async () =>
    (await Promise.all(Object.keys(LEADERBOARDS).map((k) => leaderboard(k, 5)))),
  );
});

app.get('/api/leaderboards/:key', async (req, reply) => {
  const key = req.params.key;
  if (!(key in LEADERBOARDS)) return reply.code(404).send({ error: 'unknown leaderboard' });
  reply.header('Cache-Control', edge(60));
  return cached(`lb:${key}`, 60_000, () => leaderboard(key, 50));
});

app.get('/api/players', async (req, reply) => {
  const { q = '', sort = 'playtime', page = '1' } = req.query;
  const limit = 48;
  const offset = (Math.max(1, Number.parseInt(page, 10) || 1) - 1) * limit;
  reply.header('Cache-Control', edge(30));
  return listPlayers({ search: String(q).slice(0, 32), sort: String(sort), limit, offset });
});

app.get('/api/players/:uuid', async (req, reply) => {
  const { uuid } = req.params;
  if (!UUID_RE.test(uuid)) return reply.code(400).send({ error: 'bad uuid' });
  const player = await getPlayer(uuid.toLowerCase());
  if (!player) return reply.code(404).send({ error: 'player not found' });
  reply.header('Cache-Control', edge(30));
  return player;
});

// /head/<uuid>.webp?size=64 -- generated from the skin texture, then cached on disk (and by Cloudflare).
app.get('/head/:file', async (req, reply) => {
  const m = /^([0-9a-f-]{36})\.webp$/i.exec(req.params.file);
  if (!m || !UUID_RE.test(m[1])) return reply.code(400).send({ error: 'bad uuid' });
  const size = Number.parseInt(req.query.size ?? '64', 10);
  if (!HEAD_SIZES.includes(size)) return reply.code(400).send({ error: `size must be one of ${HEAD_SIZES.join(', ')}` });

  const head = await getHead(m[1].toLowerCase(), size);
  if (!head) return reply.code(404).send({ error: 'player not found' });

  reply.type('image/webp');
  // Placeholder heads must not stick around in Cloudflare once the real skin becomes available.
  reply.header('Cache-Control', head.fallback ? edge(300) : edge(86_400));
  return reply.send(head.webp);
});

// SPA fallback for /player/<uuid> style links
app.setNotFoundHandler((req, reply) => {
  if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/head/')) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({ error: 'not found' });
});

app.setErrorHandler((err, _req, reply) => {
  app.log.error(err);
  reply.code(500).send({ error: 'internal error' });
});

await app.listen({ port: config.port, host: '0.0.0.0' });
