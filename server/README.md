# 本地 Paper 测试环境

- Paper：1.21.8 build 60
- Java：25.0.1
- 地址：`localhost:25565`
- 客户端版本：Minecraft 1.21.8
- 插件：`plugins/minecraft-ctf.jar`
- 当前配置为 `online-mode=false`，仅用于本机测试。
- 服务端绑定 `127.0.0.1`，不会对局域网或公网开放离线模式端口。

启动：

```powershell
.\run-local.ps1
```

脚本会切换到服务端目录后运行，因此也可以从项目根目录执行 `./server/run-local.ps1`。启动前应确认没有另一个 Paper 实例占用端口。

停止当前 Paper 进程：

```powershell
Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
  Where-Object { $_.CommandLine -like '*paper-1.21.8-60.jar*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
