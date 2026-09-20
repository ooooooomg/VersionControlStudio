# 创建 VersionControl Studio 桌面快捷方式(在 main/studio 完成 npm install 后运行)
$ErrorActionPreference = "Stop"

$studio = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$electron = Join-Path $studio "node_modules\electron\dist\electron.exe"
$ico = Join-Path $studio "resources\icons\icon.ico"

if (-not (Test-Path $electron)) { throw "electron.exe 不存在(请先在 main/studio 执行 npm install): $electron" }

$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = Join-Path $desktop "VersionControl Studio.lnk"
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = $electron
$s.Arguments = '"' + $studio + '"'
$s.WorkingDirectory = $studio
$s.IconLocation = "$ico,0"
$s.Description = "VersionControl Studio — git 驱动的项目版本控制(AI 直连)"
$s.WindowStyle = 7  # 最小化,避免控制台闪现
$s.Save()
Write-Output "created: $lnk"
