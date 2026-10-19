package dev.webstats;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.webstats.Database.PlayerRow;
import dev.webstats.Database.Snapshot;
import dev.webstats.Database.StatRow;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.scheduler.BukkitTask;

import java.io.IOException;
import java.io.Reader;
import java.net.URL;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Level;

/**
 * Reads the vanilla stat files (world/stats/&lt;uuid&gt;.json) off the main thread and mirrors them
 * into the database. Reading the files covers offline players too and costs the server nothing.
 */
final class StatsSync {

    private record OnlinePlayer(UUID uuid, String name, String skinUrl) {}

    private final WebStatsPlugin plugin;
    private final Database db;
    private final AtomicBoolean running = new AtomicBoolean();
    private final AtomicBoolean triggerPending = new AtomicBoolean();

    /** uuid -> mtime of the stat file we last stored successfully. */
    private final Map<UUID, Long> seen = new ConcurrentHashMap<>();
    private final Map<UUID, String> names = new ConcurrentHashMap<>();
    private final Map<UUID, Long> playtimes = new ConcurrentHashMap<>();

    private BukkitTask task;

    StatsSync(WebStatsPlugin plugin, Database db) {
        this.plugin = plugin;
        this.db = db;
    }

    void start() {
        long periodTicks = Math.max(10, plugin.getConfig().getLong("update-interval-seconds", 300)) * 20L;
        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
            try {
                names.putAll(db.loadNames());
            } catch (Exception e) {
                plugin.getLogger().log(Level.WARNING, "Could not preload player names", e);
            }
            task = Bukkit.getScheduler().runTaskTimer(plugin, this::run, 100L, periodTicks);
        });
    }

    void stop() {
        if (task != null) task.cancel();
    }

    /** Debounced one-off sync, used after joins/quits so fresh data shows up quickly. */
    void trigger(long delayTicks) {
        if (!triggerPending.compareAndSet(false, true)) return;
        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            triggerPending.set(false);
            run();
        }, delayTicks);
    }

    /** Main thread: grab everything that needs the Bukkit API, then hand over to an async task. */
    void run() {
        if (!plugin.isEnabled() || !running.compareAndSet(false, true)) return;

        List<OnlinePlayer> online = new ArrayList<>();
        for (Player p : Bukkit.getOnlinePlayers()) {
            URL skin = null;
            try {
                skin = p.getPlayerProfile().getTextures().getSkin();
            } catch (Exception ignored) {
            }
            online.add(new OnlinePlayer(p.getUniqueId(), p.getName(), skin == null ? null : skin.toString()));
        }
        double[] tps = Bukkit.getTPS();
        Snapshot snap = new Snapshot(System.currentTimeMillis(), online.size(), Bukkit.getMaxPlayers(),
                Math.min(20.0, Math.round(tps[0] * 100.0) / 100.0));
        Path dir = statsDir();

        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
            try {
                sync(dir, online, snap);
            } catch (Exception e) {
                plugin.getLogger().log(Level.WARNING, "Stats sync failed", e);
            } finally {
                running.set(false);
            }
        });
    }

    private Path statsDir() {
        String configured = plugin.getConfig().getString("stats-folder", "auto");
        if (configured != null && !configured.equalsIgnoreCase("auto")) return Path.of(configured);
        World main = Bukkit.getWorlds().get(0);
        return main.getWorldFolder().toPath().resolve("stats");
    }

    private void sync(Path dir, List<OnlinePlayer> online, Snapshot snap) throws Exception {
        Map<UUID, OnlinePlayer> onlineById = new HashMap<>();
        for (OnlinePlayer o : online) {
            onlineById.put(o.uuid(), o);
            names.put(o.uuid(), o.name());
        }

        // uuid -> parsed file, only for files that changed since the last successful sync
        Map<UUID, ParsedFile> changed = new HashMap<>();
        if (Files.isDirectory(dir)) {
            try (DirectoryStream<Path> files = Files.newDirectoryStream(dir, "*.json")) {
                for (Path f : files) {
                    String fn = f.getFileName().toString();
                    UUID id;
                    try {
                        id = UUID.fromString(fn.substring(0, fn.length() - ".json".length()));
                    } catch (IllegalArgumentException e) {
                        continue;
                    }
                    long mtime = Files.getLastModifiedTime(f).toMillis();
                    Long prev = seen.get(id);
                    if (prev != null && prev == mtime) continue;
                    try {
                        changed.put(id, parse(f, mtime));
                    } catch (Exception e) {
                        plugin.getLogger().warning("Skipping unreadable stat file " + fn + ": " + e.getMessage());
                    }
                }
            }
        }

        Set<UUID> all = new HashSet<>(changed.keySet());
        all.addAll(onlineById.keySet());
        resolveMissingNames(all);

        List<PlayerRow> rows = new ArrayList<>(all.size());
        for (UUID id : all) {
            OnlinePlayer o = onlineById.get(id);
            ParsedFile pf = changed.get(id);
            if (pf != null) playtimes.put(id, pf.playtime());
            String name = names.getOrDefault(id, "Unknown-" + id.toString().substring(0, 6));
            long lastSeen = o != null ? snap.ts() : pf != null ? pf.mtime() : 0L;
            rows.add(new PlayerRow(id, name, o == null ? null : o.skinUrl(), playtimes.getOrDefault(id, 0L),
                    o != null, lastSeen, pf == null ? null : pf.stats()));
        }

        db.save(rows, snap, plugin.getConfig().getInt("snapshot-retention-days", 90));

        // Only remember files once the DB write succeeded, otherwise they are retried next cycle.
        changed.forEach((id, pf) -> seen.put(id, pf.mtime()));
    }

    /** Offline players may not be in our DB yet; ask the server's usercache (main thread only). */
    private void resolveMissingNames(Set<UUID> ids) throws Exception {
        List<UUID> missing = ids.stream().filter(id -> !names.containsKey(id)).toList();
        if (missing.isEmpty()) return;
        Map<UUID, String> resolved = Bukkit.getScheduler().callSyncMethod(plugin, () -> {
            Map<UUID, String> out = new HashMap<>();
            for (UUID id : missing) {
                String n = Bukkit.getOfflinePlayer(id).getName();
                if (n != null) out.put(id, n);
            }
            return out;
        }).get();
        names.putAll(resolved);
    }

    private record ParsedFile(long mtime, long playtime, List<StatRow> stats) {}

    private static ParsedFile parse(Path file, long mtime) throws IOException {
        List<StatRow> rows = new ArrayList<>();
        long playtime = 0;
        long legacyPlaytime = 0;
        try (Reader r = Files.newBufferedReader(file)) {
            JsonObject root = JsonParser.parseReader(r).getAsJsonObject();
            JsonObject stats = root.has("stats") ? root.getAsJsonObject("stats") : new JsonObject();
            for (Map.Entry<String, JsonElement> cat : stats.entrySet()) {
                if (!cat.getValue().isJsonObject()) continue;
                for (Map.Entry<String, JsonElement> stat : cat.getValue().getAsJsonObject().entrySet()) {
                    long value = stat.getValue().getAsLong();
                    rows.add(new StatRow(cat.getKey(), stat.getKey(), value));
                    if (cat.getKey().equals("minecraft:custom")) {
                        if (stat.getKey().equals("minecraft:play_time")) playtime = value;
                        else if (stat.getKey().equals("minecraft:play_one_minute")) legacyPlaytime = value;
                    }
                }
            }
        }
        return new ParsedFile(mtime, playtime > 0 ? playtime : legacyPlaytime, rows);
    }
}
