import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { getSkinUrl } from './db.js';

export const HEAD_SIZES = [32, 64, 128, 256];
const SKIN_HOST = 'textures.minecraft.net';
const MAX_SKIN_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 8000;

const headDir = path.join(config.cacheDir, 'heads');
await mkdir(headDir, { recursive: true });

// Skin URL looked up via Mojang for players the plugin never saw online.
const mojangLookups = new Map(); // uuid -> { url|null, expires }
const inflight = new Map(); // cache file -> Promise<Buffer>

/** Returns { webp: Buffer, fallback: boolean } for a known player uuid, or null if unknown. */
export async function getHead(uuid, size) {
  const { exists, skinUrl } = await getSkinUrl(uuid);
  if (!exists) return null;

  const url = skinUrl ?? (await lookupMojang(uuid));
  const hash = url ? textureHash(url) : null;
  if (!hash) return { webp: await fallbackHead(size), fallback: true };

  // The texture hash identifies the exact skin, so a cached file never goes stale.
  const file = path.join(headDir, `${hash}-${size}.webp`);
  try {
    return { webp: await readFile(file), fallback: false };
  } catch {
    /* not cached yet */
  }

  let job = inflight.get(file);
  if (!job) {
    job = renderAndStore(hash, size, file).finally(() => inflight.delete(file));
    inflight.set(file, job);
  }
  try {
    return { webp: await job, fallback: false };
  } catch (err) {
    console.warn(`head render failed for ${uuid}: ${err.message}`);
    return { webp: await fallbackHead(size), fallback: true };
  }
}

function textureHash(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== SKIN_HOST) return null;
    const hash = u.pathname.split('/').pop();
    return /^[0-9a-f]{16,64}$/i.test(hash) ? hash.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function renderAndStore(hash, size, file) {
  const png = await download(`https://${SKIN_HOST}/texture/${hash}`);
  const webp = await renderHead(png, size);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, webp);
  await rename(tmp, file);
  return webp;
}

/** Face (8,8) + hat overlay (40,8), both 8x8, scaled up with nearest neighbour. */
export async function renderHead(skinPng, size) {
  const img = sharp(skinPng);
  const { width, height } = await img.metadata();
  if (width !== 64 || (height !== 64 && height !== 32)) throw new Error(`unexpected skin size ${width}x${height}`);

  const face = await sharp(skinPng).extract({ left: 8, top: 8, width: 8, height: 8 }).ensureAlpha().png().toBuffer();
  let merged = face;
  if (await hasHatLayer(skinPng, height)) {
    const hat = await sharp(skinPng).extract({ left: 40, top: 8, width: 8, height: 8 }).ensureAlpha().png().toBuffer();
    merged = await sharp(face).composite([{ input: hat }]).png().toBuffer();
  }
  return sharp(merged).resize(size, size, { kernel: 'nearest' }).webp({ lossless: true }).toBuffer();
}

/**
 * Legacy 64x32 skins have no real hat layer: the area is either empty or filled with opaque
 * junk. Minecraft ("Notch transparency hack") ignores that area unless it has transparent pixels.
 */
async function hasHatLayer(skinPng, height) {
  if (height !== 32) return true;
  const { data, info } = await sharp(skinPng)
    .extract({ left: 32, top: 0, width: 32, height: 16 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += info.channels) if (data[i] < 128) return true;
  return false;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_SKIN_BYTES) throw new Error('skin too large');
  return buf;
}

async function lookupMojang(uuid) {
  const hit = mojangLookups.get(uuid);
  if (hit && hit.expires > Date.now()) return hit.url;
  let url = null;
  let ttl = 10 * 60 * 1000; // failures (incl. 429) are retried after 10 minutes
  try {
    const res = await fetch(
      `https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replaceAll('-', '')}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (res.ok) {
      const profile = await res.json();
      const prop = profile.properties?.find((p) => p.name === 'textures');
      if (prop) {
        url = JSON.parse(Buffer.from(prop.value, 'base64').toString()).textures?.SKIN?.url ?? null;
        ttl = 6 * 3600 * 1000;
      }
    }
  } catch {
    /* network failure: fall through with the short TTL */
  }
  mojangLookups.set(uuid, { url, expires: Date.now() + ttl });
  return url;
}

// --- Steve-ish placeholder, drawn from an 8x8 palette so we ship no binary assets -----------

const PALETTE = { h: [43, 29, 20], s: [198, 134, 99], w: [255, 255, 255], p: [76, 56, 150], m: [140, 84, 62] };
const FACE = ['hhhhhhhh', 'hhhhhhhh', 'hssssssh', 'ssssssss', 'swpsspws', 'ssssssss', 'sssmmsss', 'ssssssss'];
const fallbackCache = new Map();

async function fallbackHead(size) {
  let buf = fallbackCache.get(size);
  if (buf) return buf;
  const raw = Buffer.alloc(8 * 8 * 3);
  FACE.forEach((row, y) => {
    for (let x = 0; x < 8; x++) {
      const [r, g, b] = PALETTE[row[x]] ?? PALETTE.s;
      raw.set([r, g, b], (y * 8 + x) * 3);
    }
  });
  buf = await sharp(raw, { raw: { width: 8, height: 8, channels: 3 } })
    .resize(size, size, { kernel: 'nearest' })
    .webp({ lossless: true })
    .toBuffer();
  fallbackCache.set(size, buf);
  return buf;
}
