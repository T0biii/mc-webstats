# WebStats

Paper-Plugin, das Spielerstatistiken in eine MariaDB/MySQL schreibt, plus eine Webseite im Block-Stil (hinter Cloudflare), die sie anzeigt.

```
plugin/   Paper-Plugin (Java 21, Gradle)  -> WebStats-<version>.jar
web/      Node 22 + Fastify + sharp       -> Docker-Image ghcr.io/<owner>/webstats-web
```

## Funktionsweise

- **Plugin**: liest alle paar Minuten (async) die Vanilla-Dateien `world/stats/<uuid>.json` – das deckt auch Offline-Spieler ab und belastet den Main-Thread nicht. Nur geänderte Dateien werden geschrieben. Zusätzlich: Online-Spieler/TPS-Snapshots für den 24h-Graphen. Tabellen werden automatisch angelegt (`players`, `player_stats`, `server_snapshots`); serverweite Werte berechnet die Webseite per SQL-Summe.
- **Web**: serverweite Statistiken (Summen über alle Spieler), Bestenlisten, Spielerseiten mit allen Kategorien, Suche.
- **Köpfe**: `/head/<uuid>.webp?size=32|64|128|256` – Face + Hat-Layer aus der Skin-Textur, nearest-neighbor hochskaliert, als lossless WebP unter `/data/cache/heads/<texture-hash>-<size>.webp` gecacht. Der Hash identifiziert den Skin, der Cache wird also nie ungültig. Cloudflare cached die Bilder zusätzlich (`Cache-Control: public, s-maxage=86400`).
- **Schrift**: Press Start 2P (Überschriften) + VT323 (Text), beide OFL und selbst gehostet (via `@fontsource`). Wer die echte Minecraft-Optik will: [Monocraft](https://github.com/IdreesInc/Monocraft) (OFL) nach `web/public/fonts/` legen und in `style.css` eintragen.

## Plugin installieren

1. Jar aus dem Actions-Artifact bzw. dem GitHub-Release nach `plugins/` kopieren.
2. Server einmal starten, `plugins/WebStats/config.yml` mit den DB-Daten füllen, neu starten.
3. `/webstats sync` erzwingt einen Sync (Permission `webstats.admin`).

Die Treiber (MariaDB, HikariCP) lädt Paper selbst von Maven Central (`libraries:` in `plugin.yml`), der Server braucht also Internet beim ersten Start.

Für die Webseite reicht ein DB-User mit `SELECT`:

```sql
CREATE USER 'webstats_ro'@'%' IDENTIFIED BY '...';
GRANT SELECT ON webstats.* TO 'webstats_ro'@'%';
```

## Webseite betreiben

```bash
cp .env.example .env   # ausfüllen
docker compose up -d
```

- `--profile db` startet zusätzlich eine MariaDB, `--profile tunnel` einen Cloudflare Tunnel (`TUNNEL_TOKEN`; Public Hostname -> `http://web:3000`).
- Hinter Cloudflare: Proxy (orange Wolke) an, SSL „Full“. Die API sendet `Cache-Control`-Header; eine Cache Rule „Eligible for cache / Respect origin“ für die Domain nutzt sie.
- `/data` (Volume `head-cache`) enthält die Kopf-Bilder und darf verloren gehen.

## GitHub Actions

- `plugin.yml`: baut bei Push/PR, lädt die Jar als Artifact hoch; bei Tag `v1.2.3` entsteht ein Release mit `WebStats-1.2.3.jar`.
- `web.yml`: baut `linux/amd64` + `arm64` und pusht nach `ghcr.io/<owner>/webstats-web` (`latest`, Version, SHA). Pakete sind anfangs privat – unter Package settings ggf. auf public stellen oder auf dem Server `docker login ghcr.io` nutzen.

## Entwicklung

```bash
cd web && npm install && DB_PASSWORD=... CACHE_DIR=./data/cache npm start
cd plugin && ./gradlew build
```

## Artefakte

Jeder Build lädt seine Ergebnisse als Actions-Artifact hoch (30 Tage): die Plugin-Jar samt `SHA256SUMS.txt` und das Web-Image als `webstats-web.tar.gz` (`gunzip -c webstats-web.tar.gz | docker load`).

## Lizenz

MIT, siehe [LICENSE](LICENSE). Beiträge: [CONTRIBUTING.md](CONTRIBUTING.md), Sicherheit: [SECURITY.md](SECURITY.md).
