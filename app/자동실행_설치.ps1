[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherName = "culture-subtitle-control.pyw"
$launcherPath = Join-Path $projectRoot $launcherName
$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "Culture Subtitle Workbench.lnk"

if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "Autostart launcher was not found: $launcherPath"
}

$python = Get-Command python.exe -ErrorAction Stop
$pythonwPath = (& $python.Source -c "import sys; from pathlib import Path; print(Path(sys.executable).with_name('pythonw.exe'))").Trim()
if (-not (Test-Path -LiteralPath $pythonwPath)) {
    throw "Python windowless executable was not found."
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pythonwPath
$shortcut.Arguments = "`"$launcherPath`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = "문화자막 서버를 창 없이 시작합니다."
$shortcut.Save()

Start-Process -FilePath $pythonwPath -ArgumentList "`"$launcherPath`"" -WorkingDirectory $projectRoot -WindowStyle Hidden
Write-Output "Autostart registered: $shortcutPath ($launcherName)"
