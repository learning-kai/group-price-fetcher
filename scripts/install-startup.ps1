param(
  [string]$TaskName = "GroupPriceFetcher"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$serverPath = Join-Path $projectRoot "src\server.js"
$arguments = "--disable-warning=ExperimentalWarning `"$serverPath`""

$action = New-ScheduledTaskAction `
  -Execute $node `
  -Argument $arguments `
  -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Local scheduler for Group Price Fetcher" `
  -RunLevel Limited `
  -Force | Out-Null

Write-Host "已安装登录启动任务：$TaskName"
Write-Host "项目目录：$projectRoot"
