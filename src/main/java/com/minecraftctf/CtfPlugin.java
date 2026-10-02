package com.minecraftctf;

import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Color;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.WorldCreator;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.data.Bisected;
import org.bukkit.block.data.type.Door;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.inventory.InventoryPickupItemEvent;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerItemDamageEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.weather.WeatherChangeEvent;
import org.bukkit.event.world.WorldLoadEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.LeatherArmorMeta;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.util.Vector;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

public final class CtfPlugin extends JavaPlugin implements Listener {
    static final String ARENA_WORLD = "ctf_arena";
    static final int MAX_TEAM_SIZE = 16;
    static final int FLAG_COUNT = 8;
    static final int MATCH_SECONDS = 180;

    private World arenaWorld;
    private ArenaMap map;
    private Match match;
    private BukkitTask tickTask;
    private final Map<UUID, Team> lobby = new LinkedHashMap<>();
    private final Map<UUID, Boolean> ready = new ConcurrentHashMap<>();
    private int requestedPlayers = 0;
    private boolean allowEmptyOpponent = false;
    private String requestedMapMode = "fixed";
    private boolean readyPrompted = false;
    private Path eventLog;
    private ViewerStateWriter viewerWriter;
    private BukkitTask viewerTask;
    private Map<String, Object> viewerResult;
    private final Map<UUID, Team> viewerTeams = new LinkedHashMap<>();
    private final Map<String, String> viewerCapturedFlags = new LinkedHashMap<>();
    private final Deque<Map<String, Object>> viewerEvents = new ArrayDeque<>();

    @Override public void onEnable() {
        saveDefaultConfig();
        eventLog = getDataFolder().toPath().resolve("events.jsonl");
        getDataFolder().mkdirs();
        getServer().getPluginManager().registerEvents(this, this);
        Objects.requireNonNull(getCommand("ctf")).setExecutor(new CtfCommand(this));
        Objects.requireNonNull(getCommand("ctf")).setTabCompleter(new CtfCommand(this));
        arenaWorld = Bukkit.getWorld(ARENA_WORLD);
        if (arenaWorld == null) arenaWorld = new WorldCreator(ARENA_WORLD).createWorld();
        if (arenaWorld != null) {
            arenaWorld.setStorm(false); arenaWorld.setThundering(false); arenaWorld.setTime(6000);
            map = new ArenaMap(arenaWorld);
        }
        tickTask = Bukkit.getScheduler().runTaskTimer(this, this::tick, 1L, 1L);
        viewerWriter = new ViewerStateWriter(getDataFolder().toPath().resolve("viewer-state.json"), getLogger());
        viewerTask = Bukkit.getScheduler().runTaskTimer(this, () -> publishViewerState(true), 1L, 5L);
        getLogger().info("MinecraftCTF enabled. Use /ctf setup then /ctf join <left|right>.");
    }

    @Override public void onDisable() {
        if (tickTask != null) tickTask.cancel();
        if (viewerTask != null) viewerTask.cancel();
        if (match != null) finish("server_shutdown");
        if (viewerWriter != null) { publishViewerState(false); viewerWriter.close(); }
    }

    void setupMap() {
        if (arenaWorld == null) return;
        if (match != null) finish("map_reset");
        map = new ArenaMap(arenaWorld);
        map.build();
        viewerCapturedFlags.clear();
        viewerResult = null;
        viewerTeams.clear();
        viewerTeams.putAll(lobby);
        broadcast("固定地图已生成：世界 " + ARENA_WORLD + "，中央分界线 x=0。");
        event("map_setup", Map.of("world", ARENA_WORLD, "mode", "fixed"));
    }

    boolean join(Player player, Team team) {
        if (match != null) { player.sendMessage(Component.text("比赛进行中，无法加入。")); return false; }
        long count = lobby.values().stream().filter(t -> t == team).count();
        if (count >= MAX_TEAM_SIZE) { player.sendMessage(Component.text("该队已满。")); return false; }
        lobby.put(player.getUniqueId(), team); ready.put(player.getUniqueId(), false);
        viewerTeams.put(player.getUniqueId(), team); viewerResult = null;
        player.sendMessage(Component.text("已加入 " + team.label + " 队。当前人数 " + lobby.size() + "，每队上限 " + MAX_TEAM_SIZE + "。"));
        event("lobby_join", Map.of("player", player.getName(), "team", team.id));
        return true;
    }

    void ready(Player player) {
        if (!lobby.containsKey(player.getUniqueId())) { player.sendMessage(Component.text("请先 /ctf join left 或 /ctf join right。")); return; }
        ready.put(player.getUniqueId(), true);
        player.sendMessage(Component.text("已准备。"));
        if (lobby.size() >= 1 && ready.values().stream().filter(Boolean::booleanValue).count() == lobby.size()
                && teamCount(Team.LEFT) > 0 && (allowEmptyOpponent || teamCount(Team.RIGHT) > 0)) start();
    }

    boolean start() {
        if (map == null || !map.built) setupMap();
        if (requestedMapMode.equals("random")) broadcast("当前 MVP 尚未启用随机地图，本局使用 fixed 固定坐标。" );
        int required = requestedPlayers > 0 ? requestedPlayers : 1;
        boolean singleTeam = allowEmptyOpponent && teamCount(Team.RIGHT) == 0;
        if (teamCount(Team.LEFT) < required || (!singleTeam && teamCount(Team.RIGHT) < required)) {
            broadcast("人数未满足：需要每队 " + required + " 人" + (singleTeam ? "（当前为单队测试）" : "")
                    + "，当前左队 " + teamCount(Team.LEFT) + "，右队 " + teamCount(Team.RIGHT) + "。");
            return false;
        }
        if (match != null) return false;
        map.resetState();
        viewerCapturedFlags.clear();
        match = new Match(lobby);
        lobby.keySet().forEach(id -> ready.put(id, false));
        for (UUID id : match.players.keySet()) {
            Player p = Bukkit.getPlayer(id); if (p != null) preparePlayer(p, match.players.get(id));
        }
        String json = "{\"left\":[" + names(Team.LEFT) + "],\"right\":[" + names(Team.RIGHT) + "]}";
        for (UUID id : match.players.keySet()) {
            Player p = Bukkit.getPlayer(id); if (p != null) p.sendMessage(Component.text("Game start: " + json));
        }
        broadcast(ChatColor.GREEN + "比赛开始！180 秒，夺取并插满 8 个目标点。" );
        event("match_start", Map.of("left", namesList(Team.LEFT), "right", namesList(Team.RIGHT), "map", requestedMapMode, "players_per_team", required));
        return true;
    }

    void stop() { if (match != null) finish("admin_stop"); else broadcast("当前没有进行中的比赛。"); }

    void status(Player viewer) {
        if (match == null) { viewer.sendMessage(Component.text("状态：等待大厅，总人数 " + lobby.size() + "，左队 " + teamCount(Team.LEFT) + "，右队 " + teamCount(Team.RIGHT) + "。")); return; }
        viewer.sendMessage(Component.text("状态：进行中，剩余 " + match.remainingSeconds() + " 秒，比分 " + match.score(Team.LEFT) + ":" + match.score(Team.RIGHT)));
    }

    private int teamCount(Team t) { return (int) lobby.values().stream().filter(x -> x == t).count(); }
    private String names(Team t) { return namesList(t).stream().map(n -> "\"" + n + "\"").collect(Collectors.joining(",")); }
    private List<String> namesList(Team t) { return (match == null ? lobby : match.players).entrySet().stream().filter(e -> e.getValue() == t).map(e -> Optional.ofNullable(Bukkit.getPlayer(e.getKey())).map(Player::getName).orElse("offline")).toList(); }

    private void preparePlayer(Player p, Team team) {
        p.setGameMode(GameMode.ADVENTURE); clearCombatInventory(p); p.setHealth(20); p.setFoodLevel(20); p.setFireTicks(0); p.setAllowFlight(false);
        equipTeamArmor(p, team);
        p.teleport(map.spawn(team));
        p.sendMessage(Component.text("你是 " + team.label + " 队。徒手模式：靠近敌方旗座自动携旗，回到己方任意空金块插旗。"));
    }

    private void tick() {
        if (match == null || map == null) return;
        if (match.remainingSeconds() <= 0) { finish("timeout"); return; }
        for (UUID id : new ArrayList<>(match.players.keySet())) {
            Player p = Bukkit.getPlayer(id); if (p == null || !p.isOnline()) continue;
            Team team = match.players.get(id);
            if (match.jailedUntil.getOrDefault(id, 0L) > System.currentTimeMillis()) {
                p.setVelocity(new Vector()); p.setFoodLevel(20);
                continue;
            }
            if (match.jailedUntil.containsKey(id)) releaseIfExpired(p, team);
            enforceBareHands(p);
            handleFlagAndGoal(p, team);
            if (match == null) return;
        }
        handleCollisions();
        handlePrisonPlates();
        if (Bukkit.getCurrentTick() % 20 == 0) broadcastScorebar();
    }

    private void enforceBareHands(Player p) {
        clearCombatInventory(p);
        if (p.getFoodLevel() < 7) p.setFoodLevel(7);
        p.setTotalExperience(0); p.setExp(0); p.setLevel(0);
    }

    private void clearCombatInventory(Player p) {
        PlayerInventory inv = p.getInventory();
        for (int i = 0; i < 36; i++) inv.clear(i);
        inv.setItemInOffHand(null);
    }

    private void equipTeamArmor(Player p, Team team) {
        Color color = team == Team.LEFT ? Color.RED : Color.BLUE;
        ItemStack[] armor = new ItemStack[]{new ItemStack(Material.LEATHER_BOOTS), new ItemStack(Material.LEATHER_LEGGINGS), new ItemStack(Material.LEATHER_CHESTPLATE), new ItemStack(Material.LEATHER_HELMET)};
        for (ItemStack item : armor) {
            LeatherArmorMeta meta = (LeatherArmorMeta) item.getItemMeta();
            meta.setColor(color); meta.addEnchant(Enchantment.BINDING_CURSE, 1, true); item.setItemMeta(meta);
        }
        p.getInventory().setArmorContents(armor);
    }

    private void handleFlagAndGoal(Player p, Team team) {
        UUID id = p.getUniqueId();
        if (match.carriedFlag.containsKey(id)) {
            if (map.isHomeHalf(team, p.getLocation())) {
                for (Target target : map.targets(team)) {
                    if (!match.lockedTargets.contains(target.id) && target.location.distanceSquared(p.getLocation()) <= 2.5) {
                        deposit(p, team, target); return;
                    }
                }
            }
            return;
        }
        Team enemy = team.other();
        if (map.isEnemyHalf(team, p.getLocation())) {
            for (Flag flag : map.flags(enemy)) {
                if (match.availableFlags.contains(flag.id) && flag.location.distanceSquared(p.getLocation()) <= 2.5) { pickup(p, flag); return; }
            }
        }
    }

    private void pickup(Player p, Flag flag) {
        match.availableFlags.remove(flag.id); match.carriedFlag.put(p.getUniqueId(), flag.id);
        flag.setVisible(false); p.getInventory().setHelmet(new ItemStack(flag.owner == Team.LEFT ? Material.RED_BANNER : Material.BLUE_BANNER));
        p.sendMessage(Component.text("你携带了 " + flag.owner.label + " 队的旗！回到己方半场插入任意空金块。"));
        broadcast(p.getName() + " 夺取了 " + flag.owner.label + " 队的一面旗。");
        event("flag_pickup", Map.of("player", p.getName(), "flag", flag.id, "owner", flag.owner.id));
    }

    private void deposit(Player p, Team team, Target target) {
        String flagId = match.carriedFlag.remove(p.getUniqueId());
        viewerCapturedFlags.put(target.id, flagId);
        match.lockedTargets.add(target.id); target.setLocked(true); equipTeamArmor(p, team);
        p.sendMessage(Component.text("插旗成功！目标点 " + target.id + " 永久锁定。"));
        broadcast(team.label + " 队已插旗 " + match.score(team) + "/8。" );
        event("flag_capture", Map.of("player", p.getName(), "team", team.id, "target", target.id, "flag", flagId, "score", match.score(team)));
        if (match.score(team) >= FLAG_COUNT) finish("eight_captures_" + team.id);
    }

    private void handleCollisions() {
        List<Player> players = match.players.keySet().stream().map(Bukkit::getPlayer).filter(Objects::nonNull).filter(Player::isOnline).toList();
        for (int i = 0; i < players.size(); i++) for (int j = i + 1; j < players.size(); j++) {
            Player a = players.get(i), b = players.get(j); Team ta = match.players.get(a.getUniqueId()), tb = match.players.get(b.getUniqueId());
            if (ta == tb || !a.getWorld().equals(b.getWorld()) || a.getLocation().distanceSquared(b.getLocation()) > 1.44) continue;
            if (match.jailedUntil.containsKey(a.getUniqueId()) || match.jailedUntil.containsKey(b.getUniqueId())) continue;
            if (map.isHomeHalf(ta, a.getLocation())) jail(b, tb, ta, a.getName());
            else if (map.isHomeHalf(tb, b.getLocation())) jail(a, ta, tb, b.getName());
        }
    }

    private void jail(Player victim, Team victimTeam, Team jailerTeam, String jailer) {
        if (match.jailedUntil.containsKey(victim.getUniqueId())) return;
        dropCarriedFlag(victim, "capture");
        long until = System.currentTimeMillis() + 30_000L;
        match.jailedUntil.put(victim.getUniqueId(), until); match.prisonTeam.put(victim.getUniqueId(), victimTeam);
        victim.teleport(map.prison(victimTeam)); victim.sendMessage(Component.text("你被 " + jailer + " 抓捕，监禁 30 秒。任意玩家踩监狱门口压力板可提前开门。"));
        broadcast(victim.getName() + " 被抓捕并关入 " + victimTeam.label + " 队监狱。" );
        event("jail", Map.of("victim", victim.getName(), "team", victimTeam.id, "jailer", jailer, "until", until));
    }

    private void handlePrisonPlates() {
        for (Team t : Team.values()) {
            Location plate = map.prisonPlate(t);
            boolean stepped = match.players.keySet().stream().map(Bukkit::getPlayer).filter(Objects::nonNull).anyMatch(p -> p.getLocation().distanceSquared(plate) <= 2.25);
            if (stepped) {
                for (UUID id : new ArrayList<>(match.jailedUntil.keySet())) {
                    if (match.prisonTeam.get(id) == t) release(Bukkit.getPlayer(id), "pressure_plate");
                }
            }
        }
    }

    private void releaseIfExpired(Player p, Team team) { if (match.jailedUntil.getOrDefault(p.getUniqueId(), 0L) <= System.currentTimeMillis()) release(p, "timer"); }
    private void release(Player p, String reason) {
        if (p == null) return; Team t = match.prisonTeam.remove(p.getUniqueId()); match.jailedUntil.remove(p.getUniqueId());
        p.teleport(map.spawn(t)); p.sendMessage(Component.text("监禁结束，你已获释。")); event("release", Map.of("player", p.getName(), "reason", reason));
    }

    private void dropCarriedFlag(Player p, String reason) {
        if (match == null || p == null) return;
        String flagId = match.carriedFlag.remove(p.getUniqueId()); if (flagId == null) return;
        Flag flag = map.flag(flagId); if (flag != null) { match.availableFlags.add(flag.id); map.dropFlagNear(flag, p.getLocation()); flag.setVisible(true); }
        Team carrierTeam = match.players.get(p.getUniqueId()); if (carrierTeam != null) equipTeamArmor(p, carrierTeam);
        p.sendMessage(Component.text("你携带的旗已在附近重新立起。")); event("flag_reset", Map.of("player", p.getName(), "flag", flagId, "reason", reason));
    }

    private void broadcastScorebar() {
        if (match == null) return;
        String text = ChatColor.YELLOW + "CTF " + match.remainingSeconds() + "s  " + Team.LEFT.label + " " + match.score(Team.LEFT) + "/8  -  " + Team.RIGHT.label + " " + match.score(Team.RIGHT) + "/8";
        for (UUID id : match.players.keySet()) { Player p = Bukkit.getPlayer(id); if (p != null) p.sendActionBar(Component.text(text)); }
    }

    private void finish(String reason) {
        if (match == null) return;
        int left = match.score(Team.LEFT), right = match.score(Team.RIGHT);
        String result = left == right ? "draw" : (left > right ? "left" : "right");
        viewerResult = Map.of("left", left, "right", right, "result", result, "reason", reason,
                "startedAt", match.start, "endedAt", System.currentTimeMillis());
        broadcast("比赛结束：" + left + ":" + right + (result.equals("draw") ? "，平局。" : "，" + (result.equals("left") ? Team.LEFT.label : Team.RIGHT.label) + " 获胜。"));
        for (UUID id : match.players.keySet()) { Player p = Bukkit.getPlayer(id); if (p != null) p.sendMessage(Component.text("Game over!")); }
        event("match_end", Map.of("reason", reason, "left", left, "right", right, "result", result));
        for (UUID id : match.players.keySet()) { Player p = Bukkit.getPlayer(id); if (p != null) { dropCarriedFlag(p, "match_end"); clearCombatInventory(p); p.getInventory().setArmorContents(new ItemStack[4]); p.setGameMode(GameMode.ADVENTURE); p.teleport(map.lobby()); } }
        match = null; lobby.clear(); ready.clear(); requestedPlayers = 0; allowEmptyOpponent = false; requestedMapMode = "fixed"; readyPrompted = false;
    }

    private void broadcast(String msg) { Bukkit.broadcast(Component.text("[CTF] " + msg)); }
    private void event(String type, Map<String, ?> data) {
        viewerEvents.addLast(Map.of("ts", Instant.now().toString(), "event", type, "data", new LinkedHashMap<>(data)));
        while (viewerEvents.size() > 30) viewerEvents.removeFirst();
        String payload = data.entrySet().stream().map(e -> "\"" + e.getKey() + "\":\"" + String.valueOf(e.getValue()).replace("\"", "'") + "\"").collect(Collectors.joining(","));
        try { Files.writeString(eventLog, "{\"ts\":\"" + Instant.now() + "\",\"event\":\"" + type + "\"," + payload + "}\n", StandardCharsets.UTF_8, Files.exists(eventLog) ? java.nio.file.StandardOpenOption.APPEND : java.nio.file.StandardOpenOption.CREATE); } catch (IOException e) { getLogger().warning("event log failed: " + e.getMessage()); }
    }

    private void publishViewerState(boolean online) {
        long now = System.currentTimeMillis();
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("schemaVersion", 1); state.put("updatedAt", now); state.put("online", online);
        state.put("phase", match != null ? "running" : viewerResult != null ? "finished" : "lobby");
        state.put("world", ARENA_WORLD);
        state.put("bounds", Map.of("minX", -24, "maxX", 24, "minZ", -36, "maxZ", 36));
        state.put("mapBuilt", map != null && map.built);
        state.put("duration", MATCH_SECONDS); state.put("flagsPerTeam", FLAG_COUNT);
        state.put("remainingSeconds", match != null ? match.remainingSeconds() : viewerResult != null ? 0 : MATCH_SECONDS);
        state.put("scores", match != null ? Map.of("left", match.score(Team.LEFT), "right", match.score(Team.RIGHT))
                : viewerResult != null ? Map.of("left", viewerResult.get("left"), "right", viewerResult.get("right"))
                : Map.of("left", 0, "right", 0));
        state.put("result", viewerResult);
        state.put("blocks", map != null ? map.viewerBlocks : List.of());
        List<Map<String, Object>> flags = new ArrayList<>(), targets = new ArrayList<>(), players = new ArrayList<>();
        List<Map<String, Object>> prisons = new ArrayList<>();
        if (map != null && map.built) {
            for (Flag flag : map.flags.values()) {
                boolean available = flag.location.getBlock().getType() == flag.wool;
                boolean carried = match != null && match.carriedFlag.containsValue(flag.id);
                flags.add(Map.of("id", flag.id, "team", flag.owner.id, "x", flag.location.getX(), "z", flag.location.getZ(),
                        "status", available ? "available" : carried ? "carried" : "captured"));
            }
            for (Target target : map.targets.values()) {
                boolean locked = target.location.clone().add(0, 1, 0).getBlock().getType() == Material.EMERALD_BLOCK;
                Flag capturedFlag = map.flag(viewerCapturedFlags.get(target.id));
                targets.add(Map.of("id", target.id, "team", target.owner.id, "x", target.location.getX(), "z", target.location.getZ(),
                        "locked", locked, "flagTeam", locked && capturedFlag != null ? capturedFlag.owner.id : ""));
            }
            for (Team team : Team.values()) {
                Location prison = map.prison(team), door = map.prisonDoor(team), plate = map.prisonPlate(team);
                prisons.add(Map.of("team", team.id, "x", prison.getX(), "y", prison.getY(), "z", prison.getZ(),
                        "doorX", door.getX(), "doorY", door.getY(), "doorZ", door.getZ(),
                        "plateX", plate.getX(), "plateY", plate.getY(), "plateZ", plate.getZ()));
            }
        }
        if (arenaWorld != null) {
            for (Player player : arenaWorld.getPlayers()) {
                Location location = player.getLocation(); UUID id = player.getUniqueId();
                Team team = match != null ? match.players.get(id) : lobby.getOrDefault(id, viewerTeams.get(id));
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("id", id.toString()); entry.put("name", player.getName()); entry.put("team", team != null ? team.id : "spectator");
                entry.put("x", location.getX()); entry.put("y", location.getY()); entry.put("z", location.getZ()); entry.put("yaw", location.getYaw());
                entry.put("carrying", match != null ? match.carriedFlag.getOrDefault(id, "") : "");
                entry.put("jailedSeconds", match != null ? Math.max(0, (match.jailedUntil.getOrDefault(id, 0L) - now + 999) / 1000) : 0);
                entry.put("ready", ready.getOrDefault(id, false)); players.add(entry);
            }
        }
        state.put("flags", flags); state.put("targets", targets); state.put("players", players);
        state.put("prisons", prisons); state.put("events", new ArrayList<>(viewerEvents));
        viewerWriter.publish(state);
    }

    private Map<String, String> parseMatch(String msg) {
        Map<String, String> out = new HashMap<>();
        for (String token : msg.split("\\s+")) {
            int colon = token.indexOf(':');
            if (colon > 0 && colon + 1 < token.length()) out.put(token.substring(0, colon).toLowerCase(Locale.ROOT), token.substring(colon + 1));
        }
        return out;
    }

    private boolean lobbyReadyToPrompt() {
        int required = requestedPlayers > 0 ? requestedPlayers : 1;
        return teamCount(Team.LEFT) >= required && (allowEmptyOpponent ? teamCount(Team.RIGHT) == 0 : teamCount(Team.RIGHT) >= required);
    }

    private void maybePromptReady() {
        if (readyPrompted || !lobbyReadyToPrompt()) return;
        readyPrompted = true;
        for (UUID id : lobby.keySet()) { Player p = Bukkit.getPlayer(id); if (p != null) p.sendMessage(Component.text("Are you ready?")); }
        event("ready_prompt", Map.of("players", lobby.size(), "players_per_team", requestedPlayers, "map", requestedMapMode));
    }

    @EventHandler public void onChat(AsyncPlayerChatEvent e) {
        String msg = e.getMessage().trim();
        if (msg.startsWith("match team:")) {
            Map<String, String> request = parseMatch(msg);
            Bukkit.getScheduler().runTask(this, () -> {
                try { requestedPlayers = Math.max(1, Math.min(MAX_TEAM_SIZE, Integer.parseInt(request.getOrDefault("players", "1")))); } catch (NumberFormatException ignored) { requestedPlayers = 1; }
                requestedMapMode = request.getOrDefault("map", "fixed").toLowerCase(Locale.ROOT);
                allowEmptyOpponent = request.getOrDefault("enemy", "any").equalsIgnoreCase("none");
                if (!lobby.containsKey(e.getPlayer().getUniqueId())) {
                    Team suggested = allowEmptyOpponent ? Team.LEFT : (teamCount(Team.LEFT) <= teamCount(Team.RIGHT) ? Team.LEFT : Team.RIGHT);
                    join(e.getPlayer(), suggested);
                }
                maybePromptReady();
            });
        } else if (msg.equalsIgnoreCase("I'm ready!") || msg.equalsIgnoreCase("I’m ready!")) {
            Bukkit.getScheduler().runTask(this, () -> ready(e.getPlayer()));
        }
    }

    @EventHandler public void onJoin(PlayerJoinEvent e) { e.getPlayer().sendMessage(Component.text("本地 CTF：/ctf setup，然后 /ctf join left|right；两队各至少 1 人后 /ctf ready。")); }
    @EventHandler public void onQuit(PlayerQuitEvent e) { if (match != null && match.players.containsKey(e.getPlayer().getUniqueId())) dropCarriedFlag(e.getPlayer(), "quit"); lobby.remove(e.getPlayer().getUniqueId()); ready.remove(e.getPlayer().getUniqueId()); }
    @EventHandler public void onDeath(PlayerDeathEvent e) { if (match != null && match.players.containsKey(e.getEntity().getUniqueId())) dropCarriedFlag(e.getEntity(), "death"); }
    @EventHandler public void onRespawn(PlayerRespawnEvent e) { if (match != null && match.players.containsKey(e.getPlayer().getUniqueId())) { Team t = match.players.get(e.getPlayer().getUniqueId()); e.setRespawnLocation(map.prison(t)); } }
    @EventHandler public void onMove(PlayerMoveEvent e) {
        if (match == null || !match.players.containsKey(e.getPlayer().getUniqueId())) return;
        if (match.jailedUntil.containsKey(e.getPlayer().getUniqueId()) && match.jailedUntil.get(e.getPlayer().getUniqueId()) > System.currentTimeMillis()) { e.setTo(e.getFrom()); return; }
        Location to = e.getTo();
        if (to != null && (Math.abs(to.getX()) > 24 || Math.abs(to.getZ()) > 36 || to.getY() < 62 || to.getY() > 80)) e.setTo(e.getFrom());
    }
    @EventHandler public void onDamage(EntityDamageEvent e) { if (e.getEntity() instanceof Player p && match != null && match.players.containsKey(p.getUniqueId())) { if (!(e instanceof EntityDamageByEntityEvent)) e.setCancelled(true); } }
    @EventHandler public void onEntityDamage(EntityDamageByEntityEvent e) { if (e.getEntity() instanceof Player victim && match != null && match.players.containsKey(victim.getUniqueId())) { if (e.getDamager() instanceof Player attacker && match.players.containsKey(attacker.getUniqueId())) { e.setDamage(1.0); } else e.setCancelled(true); } }
    @EventHandler public void onBreak(BlockBreakEvent e) { if (match != null && match.players.containsKey(e.getPlayer().getUniqueId())) e.setCancelled(true); }
    @EventHandler public void onPlace(BlockPlaceEvent e) { if (match != null && match.players.containsKey(e.getPlayer().getUniqueId())) e.setCancelled(true); }
    @EventHandler public void onDrop(PlayerDropItemEvent e) { if (match != null && match.players.containsKey(e.getPlayer().getUniqueId())) e.setCancelled(true); }
    @EventHandler public void onItemDamage(PlayerItemDamageEvent e) { if (match != null && match.players.containsKey(e.getPlayer().getUniqueId())) e.setCancelled(true); }
    @EventHandler public void onPickup(InventoryPickupItemEvent e) { if (match != null) e.setCancelled(true); }
    @EventHandler public void onWeather(WeatherChangeEvent e) { if (e.getWorld().equals(arenaWorld)) e.setCancelled(true); }
    @EventHandler public void onInteract(PlayerInteractEvent e) { if (match != null && match.players.containsKey(e.getPlayer().getUniqueId())) e.setCancelled(true); }

    enum Team { LEFT("left", "左"), RIGHT("right", "右"); final String id, label; Team(String id, String label){this.id=id;this.label=label;} Team other(){return this==LEFT?RIGHT:LEFT;} }

    static final class Match {
        final Map<UUID, Team> players = new LinkedHashMap<>();
        final long start = System.currentTimeMillis();
        final Set<String> availableFlags = new HashSet<>();
        final Set<String> lockedTargets = new HashSet<>();
        final Map<UUID, String> carriedFlag = new HashMap<>();
        final Map<UUID, Long> jailedUntil = new HashMap<>();
        final Map<UUID, Team> prisonTeam = new HashMap<>();
        Match(Map<UUID, Team> source) { players.putAll(source); for (Team t : Team.values()) for (int i=0;i<FLAG_COUNT;i++) availableFlags.add(t.id + "-flag-" + (i+1)); }
        int remainingSeconds(){return Math.max(0, MATCH_SECONDS - (int)((System.currentTimeMillis()-start)/1000));}
        int score(Team t){return (int) lockedTargets.stream().filter(id -> id.startsWith(t.id + "-goal-")).count();}
    }

    static final class Flag {
        final String id; final Team owner; final Location origin; Location location; final Material wool; final CtfPlugin plugin;
        Flag(String id, Team owner, Location location, Material wool, CtfPlugin plugin){this.id=id;this.owner=owner;this.origin=location.clone();this.location=location;this.wool=wool;this.plugin=plugin;}
        void setVisible(boolean visible){ Block b=location.getBlock(); b.setType(visible?wool:Material.AIR); location.clone().add(0,1,0).getBlock().setType(visible?Material.OAK_FENCE:Material.AIR); }
    }
    static final class Target {
        final String id; final Team owner; final Location location; final CtfPlugin plugin;
        Target(String id, Team owner, Location location, CtfPlugin plugin){this.id=id;this.owner=owner;this.location=location;this.plugin=plugin;}
        void setLocked(boolean locked){ location.getBlock().setType(Material.GOLD_BLOCK); location.clone().add(0,1,0).getBlock().setType(locked?Material.EMERALD_BLOCK:Material.AIR); }
    }

    final class ArenaMap {
        final World world; final Map<String,Flag> flags=new LinkedHashMap<>(); final Map<String,Target> targets=new LinkedHashMap<>(); boolean built;
        final List<Map<String, Object>> viewerBlocks = new ArrayList<>();
        final int[] zs={-30,-22,-14,-6,6,14,22,30};
        ArenaMap(World world){this.world=world;}
        void build(){
            flags.clear(); targets.clear();
            for(int x=-24;x<=24;x++) for(int z=-36;z<=36;z++) for(int y=64;y<=80;y++) world.getBlockAt(x,y,z).setType(Material.AIR);
            for(int x=-24;x<=24;x++) for(int z=-36;z<=36;z++){ world.getBlockAt(x,62,z).setType(Material.STONE); world.getBlockAt(x,63,z).setType(Material.GRASS_BLOCK); }
            for(int x=-24;x<=24;x++) for(int y=64;y<=68;y++){ world.getBlockAt(x,y,-36).setType(Material.STONE_BRICKS); world.getBlockAt(x,y,36).setType(Material.STONE_BRICKS); }
            for(int z=-36;z<=36;z++) for(int y=64;y<=68;y++){ world.getBlockAt(-24,y,z).setType(Material.STONE_BRICKS); world.getBlockAt(24,y,z).setType(Material.STONE_BRICKS); }
            for(int z=-36;z<=36;z++) { world.getBlockAt(0,63,z).setType(Material.RED_CONCRETE); world.getBlockAt(0,64,z).setType(Material.WHITE_WOOL); }
            for(Team t:Team.values()){
                int sign=t==Team.LEFT?-1:1; Material wool=t==Team.LEFT?Material.RED_WOOL:Material.BLUE_WOOL; int x1=sign*18, x2=sign*10;
                for(int i=0;i<8;i++){
                    int x=i<4?x1:x2, z=zs[i%4];
                    Location fl=new Location(world,x,64,z); fl.getBlock().setType(wool); world.getBlockAt(x,65,z).setType(Material.OAK_FENCE);
                    flags.put(t.id+"-flag-"+(i+1),new Flag(t.id+"-flag-"+(i+1),t,fl,wool,CtfPlugin.this));
                    int gx=sign* (i<4?4:7); Location gl=new Location(world,gx,63,z); gl.getBlock().setType(Material.GOLD_BLOCK); targets.put(t.id+"-goal-"+(i+1),new Target(t.id+"-goal-"+(i+1),t,gl,CtfPlugin.this));
                }
                buildPrison(t); world.getBlockAt(sign*22,63,0).setType(wool); world.getBlockAt(sign*22,64,0).setType(wool);
            }
            world.getBlockAt(0,63,0).setType(Material.QUARTZ_BLOCK); built=true;
            viewerBlocks.clear();
            for (int x = -24; x <= 24; x++) for (int z = -36; z <= 36; z++) {
                Material material = world.getBlockAt(x, 64, z).getType();
                if (material == Material.STONE_BRICKS || material == Material.IRON_BARS || material == Material.WHITE_WOOL || material == Material.IRON_DOOR)
                    viewerBlocks.add(Map.of("x", x, "z", z, "kind", material == Material.WHITE_WOOL ? "divider" : material == Material.IRON_DOOR ? "door" : material == Material.IRON_BARS ? "prison" : "wall"));
            }
        }
        void resetState(){ for(Flag f:flags.values()){ f.location=f.origin.clone(); f.setVisible(true); } for(Target g:targets.values()) g.setLocked(false); }
        void buildPrison(Team team) {
            Location center = prison(team);
            int centerX = center.getBlockX(), centerZ = center.getBlockZ();
            for (int x = centerX - 2; x <= centerX + 2; x++) for (int z = centerZ - 2; z <= centerZ + 2; z++) {
                if (x != centerX - 2 && x != centerX + 2 && z != centerZ - 2 && z != centerZ + 2) continue;
                for (int y = 64; y <= 67; y++) world.getBlockAt(x, y, z).setType(Material.IRON_BARS);
            }
            Location entrance = prisonDoor(team);
            for (int y = 64; y <= 67; y++) world.getBlockAt(entrance.getBlockX(), y, entrance.getBlockZ()).setType(Material.AIR);
            for (Bisected.Half half : Bisected.Half.values()) {
                Door door = (Door) Bukkit.createBlockData(Material.IRON_DOOR);
                door.setFacing(BlockFace.NORTH); door.setHalf(half); door.setOpen(false);
                world.getBlockAt(entrance.getBlockX(), half == Bisected.Half.BOTTOM ? 64 : 65, entrance.getBlockZ()).setBlockData(door, false);
            }
            prisonPlate(team).getBlock().setType(Material.STONE_PRESSURE_PLATE);
        }
        void dropFlagNear(Flag flag, Location near){
            int cx=Math.max(-23, Math.min(23, near.getBlockX())), cz=Math.max(-35, Math.min(35, near.getBlockZ()));
            for(int radius=0; radius<=6; radius++) for(int dx=-radius; dx<=radius; dx++) for(int dz=-radius; dz<=radius; dz++){
                int x=cx+dx, z=cz+dz; if(x<=-24||x>=24||z<=-36||z>=36) continue;
                Block base=world.getBlockAt(x,63,z); if(base.getType()!=Material.GRASS_BLOCK) continue;
                if(world.getBlockAt(x,64,z).getType()!=Material.AIR || world.getBlockAt(x,65,z).getType()!=Material.AIR) continue;
                flag.location=new Location(world,x,64,z); return;
            }
        }
        Flag flag(String id){return flags.get(id);} List<Flag> flags(Team t){return flags.values().stream().filter(f->f.owner==t).toList();} List<Target> targets(Team t){return targets.values().stream().filter(g->g.owner==t).toList();}
        boolean isHomeHalf(Team t, Location l){return t==Team.LEFT?l.getX()<0:l.getX()>0;} boolean isEnemyHalf(Team t, Location l){return !isHomeHalf(t,l) && Math.abs(l.getX())>1;}
        Location spawn(Team t){return new Location(world,t==Team.LEFT?-12:12,64,0.5, (float)(t==Team.LEFT?Math.PI/2:-Math.PI/2),0);}
        Location prison(Team team){return new Location(world,team==Team.LEFT?-15.5:16.5,64,28.5,180,0);}
        Location prisonDoor(Team team){return new Location(world,team==Team.LEFT?-15.5:16.5,64,26.5);}
        Location prisonPlate(Team team){return new Location(world,team==Team.LEFT?-15.5:16.5,64,24.5);}
        Location lobby(){return new Location(world,0,64,0.5);}
    }
}
