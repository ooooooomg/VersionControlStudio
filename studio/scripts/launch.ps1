$desktop = [Environment]::GetFolderPath('Desktop')
Start-Process (Join-Path $desktop "VersionControl Studio.lnk")
