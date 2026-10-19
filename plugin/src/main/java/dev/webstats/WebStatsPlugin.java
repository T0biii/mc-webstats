package dev.webstats;

import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.logging.Level;

public final class WebStatsPlugin extends JavaPlugin implements Listener {

    private Database database;
    private StatsSync sync;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        try {
            database = new Database(getConfig().getConfigurationSection("database"));
            database.init();
        } catch (Exception e) {
            getLogger().log(Level.SEVERE, "Could not connect to the database, disabling. Check config.yml.", e);
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        sync = new StatsSync(this, database);
        sync.start();
        getServer().getPluginManager().registerEvents(this, this);
    }

    @Override
    public void onDisable() {
        if (sync != null) sync.stop();
        if (database != null) database.close();
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        sync.trigger(40L);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        // The server writes the stat file on disconnect; give it a moment, then mirror it.
        sync.trigger(60L);
    }

    @Override
    public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        if (args.length == 1 && args[0].equalsIgnoreCase("sync")) {
            sync.run();
            sender.sendMessage("WebStats: sync started.");
            return true;
        }
        return false;
    }
}
