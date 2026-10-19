const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  serverName: env.SERVER_NAME ?? 'Minecraft Server',
  cacheDir: env.CACHE_DIR ?? '/data/cache',
  // Plugin pushes a snapshot every update-interval-seconds; older than 3x means the server is down.
  snapshotIntervalSeconds: Number(env.SNAPSHOT_INTERVAL_SECONDS ?? 300),
  db: {
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 3306),
    database: env.DB_NAME ?? 'webstats',
    user: env.DB_USER ?? 'webstats',
    password: env.DB_PASSWORD ?? '',
  },
};
