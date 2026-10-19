package dev.webstats;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.bukkit.configuration.ConfigurationSection;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Thin JDBC layer. All methods block, call them off the main thread. */
final class Database implements AutoCloseable {

    record StatRow(String category, String stat, long value) {}

    /** stats == null means "stat file unchanged, only refresh the player row". */
    record PlayerRow(UUID uuid, String name, String skinUrl, long playtimeTicks,
                     boolean online, long lastSeen, List<StatRow> stats) {}

    record Snapshot(long ts, int online, int max, double tps) {}

    private static final int BATCH = 500;

    private final HikariDataSource ds;

    Database(ConfigurationSection c) {
        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl("jdbc:mariadb://" + c.getString("host", "localhost") + ":" + c.getInt("port", 3306)
                + "/" + c.getString("name", "webstats") + "?useUnicode=true&characterEncoding=utf8");
        cfg.setUsername(c.getString("user", "webstats"));
        cfg.setPassword(c.getString("password", ""));
        cfg.setMaximumPoolSize(Math.max(1, c.getInt("pool-size", 4)));
        cfg.setPoolName("WebStats");
        cfg.setConnectionTimeout(10_000);
        this.ds = new HikariDataSource(cfg);
    }

    void init() throws SQLException {
        try (Connection con = ds.getConnection(); Statement st = con.createStatement()) {
            st.executeUpdate("""
                CREATE TABLE IF NOT EXISTS players (
                  uuid           CHAR(36)     NOT NULL PRIMARY KEY,
                  name           VARCHAR(32)  NOT NULL,
                  skin_url       VARCHAR(255) NULL,
                  playtime_ticks BIGINT       NOT NULL DEFAULT 0,
                  online         TINYINT(1)   NOT NULL DEFAULT 0,
                  last_seen      BIGINT       NOT NULL DEFAULT 0,
                  INDEX idx_players_name (name),
                  INDEX idx_players_playtime (playtime_ticks)
                ) DEFAULT CHARSET = utf8mb4""");
            st.executeUpdate("""
                CREATE TABLE IF NOT EXISTS player_stats (
                  uuid     CHAR(36)     NOT NULL,
                  category VARCHAR(64)  NOT NULL,
                  stat     VARCHAR(128) NOT NULL,
                  value    BIGINT       NOT NULL,
                  PRIMARY KEY (uuid, category, stat),
                  INDEX idx_stats_category (category, stat)
                ) DEFAULT CHARSET = utf8mb4""");
            st.executeUpdate("""
                CREATE TABLE IF NOT EXISTS server_snapshots (
                  ts      BIGINT NOT NULL PRIMARY KEY,
                  online  INT    NOT NULL,
                  max     INT    NOT NULL,
                  tps     DOUBLE NOT NULL
                ) DEFAULT CHARSET = utf8mb4""");
        }
    }

    Map<UUID, String> loadNames() throws SQLException {
        Map<UUID, String> out = new HashMap<>();
        try (Connection con = ds.getConnection();
             Statement st = con.createStatement();
             ResultSet rs = st.executeQuery("SELECT uuid, name FROM players")) {
            while (rs.next()) {
                try {
                    out.put(UUID.fromString(rs.getString(1)), rs.getString(2));
                } catch (IllegalArgumentException ignored) {
                }
            }
        }
        return out;
    }

    void save(List<PlayerRow> players, Snapshot snap, int retentionDays) throws SQLException {
        try (Connection con = ds.getConnection()) {
            con.setAutoCommit(false);
            try {
                try (Statement st = con.createStatement()) {
                    st.executeUpdate("UPDATE players SET online = 0 WHERE online = 1");
                }

                // Unresolved names arrive as "Unknown-xxxxxx"; never overwrite a real name with those.
                try (PreparedStatement ps = con.prepareStatement("""
                        INSERT INTO players (uuid, name, skin_url, playtime_ticks, online, last_seen)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                          name = IF(VALUES(name) LIKE 'Unknown-%', name, VALUES(name)),
                          skin_url = COALESCE(VALUES(skin_url), skin_url),
                          playtime_ticks = VALUES(playtime_ticks),
                          online = VALUES(online),
                          last_seen = IF(VALUES(online) = 1, VALUES(last_seen), last_seen)""")) {
                    for (PlayerRow p : players) {
                        ps.setString(1, p.uuid().toString());
                        ps.setString(2, p.name());
                        ps.setString(3, p.skinUrl());
                        ps.setLong(4, p.playtimeTicks());
                        ps.setBoolean(5, p.online());
                        ps.setLong(6, p.lastSeen());
                        ps.addBatch();
                    }
                    ps.executeBatch();
                }

                try (PreparedStatement ps = con.prepareStatement("""
                        INSERT INTO player_stats (uuid, category, stat, value) VALUES (?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE value = VALUES(value)""")) {
                    int pending = 0;
                    for (PlayerRow p : players) {
                        if (p.stats() == null) continue;
                        for (StatRow s : p.stats()) {
                            ps.setString(1, p.uuid().toString());
                            ps.setString(2, s.category());
                            ps.setString(3, s.stat());
                            ps.setLong(4, s.value());
                            ps.addBatch();
                            if (++pending >= BATCH) {
                                ps.executeBatch();
                                pending = 0;
                            }
                        }
                    }
                    if (pending > 0) ps.executeBatch();
                }

                try (PreparedStatement ps = con.prepareStatement(
                        "INSERT INTO server_snapshots (ts, online, max, tps) VALUES (?, ?, ?, ?) "
                                + "ON DUPLICATE KEY UPDATE online = VALUES(online), max = VALUES(max), tps = VALUES(tps)")) {
                    ps.setLong(1, snap.ts());
                    ps.setInt(2, snap.online());
                    ps.setInt(3, snap.max());
                    ps.setDouble(4, snap.tps());
                    ps.executeUpdate();
                }

                try (PreparedStatement ps = con.prepareStatement("DELETE FROM server_snapshots WHERE ts < ?")) {
                    ps.setLong(1, snap.ts() - retentionDays * 86_400_000L);
                    ps.executeUpdate();
                }

                con.commit();
            } catch (SQLException e) {
                con.rollback();
                throw e;
            }
        }
    }

    @Override
    public void close() {
        ds.close();
    }
}
