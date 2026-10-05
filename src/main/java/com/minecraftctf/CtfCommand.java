package com.minecraftctf;

import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;

import java.util.List;

public final class CtfCommand implements CommandExecutor, TabCompleter {
    private final CtfPlugin plugin;
    public CtfCommand(CtfPlugin plugin){this.plugin=plugin;}
    @Override public boolean onCommand(CommandSender sender, Command command, String label, String[] args){
        String sub=args.length==0?"status":args[0].toLowerCase();
        switch(sub){
            case "setup" -> { plugin.setupMap(); sender.sendMessage("固定地图 setup 请求已处理，完成状态见聊天。"); }
            case "join" -> { if(!(sender instanceof Player p)){sender.sendMessage("仅玩家可加入。");return true;} if(args.length<2 || (!args[1].equalsIgnoreCase("left")&&!args[1].equalsIgnoreCase("right"))){sender.sendMessage("用法: /ctf join left|right");return true;} plugin.join(p,args[1].equalsIgnoreCase("left")?CtfPlugin.Team.LEFT:CtfPlugin.Team.RIGHT); }
            case "ready" -> { if(sender instanceof Player p) plugin.ready(p); }
            case "start" -> plugin.start();
            case "stop" -> plugin.stop();
            case "status" -> { if(sender instanceof Player p) plugin.status(p); else sender.sendMessage("使用 /ctf status 查看比赛状态。"); }
            default -> sender.sendMessage("/ctf setup|join <left|right>|ready|start|stop|status");
        }
        return true;
    }
    @Override public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args){
        if(args.length==1) return List.of("setup","join","ready","start","stop","status");
        if(args.length==2 && args[0].equalsIgnoreCase("join")) return List.of("left","right");
        return List.of();
    }
}
