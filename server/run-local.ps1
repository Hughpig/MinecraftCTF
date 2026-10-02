# Paper server quick start (do not run automatically)
$ErrorActionPreference = 'Stop'
$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (!(Test-Path (Join-Path $serverDir 'paper-1.21.8-60.jar'))) { throw '请先把 Paper 1.21.8 build 60 服务端 jar 放到 server/paper-1.21.8-60.jar' }
New-Item -ItemType Directory -Force -Path (Join-Path $serverDir 'plugins') | Out-Null
Copy-Item (Join-Path $serverDir '..\target\minecraft-ctf-0.1.0-SNAPSHOT.jar') (Join-Path $serverDir 'plugins\minecraft-ctf.jar') -Force
Set-Content -Path (Join-Path $serverDir 'eula.txt') -Value 'eula=true' -Encoding ASCII
Push-Location -LiteralPath $serverDir
try {
    java -Xms1G -Xmx2G -jar (Join-Path $serverDir 'paper-1.21.8-60.jar') --nogui
} finally {
    Pop-Location
}
