#Requires -Version 5.1
<#
.SYNOPSIS
Starts the n8n that install-n8n.ps1 installed, after the stock-market setup.

.DESCRIPTION
  1. Reads install.json (where Node.js 24 and n8n are) from the install folder.
  2. Loads windows\n8n.env (KEY=VALUE lines, # starts a comment line) into this window's environment.
  3. Runs tools\first-run-setup.mjs: your keys become n8n credentials, the workflows are imported once and published
     as soon as their keys are in (the header of that file explains each rule).
  4. Runs "n8n start" in this window. Ctrl+C stops n8n. Open http://localhost:5678 and create the owner account.

n8n keeps its data (SQLite database, encryption key, logs) in <install folder>\.n8n, apart from any other n8n on this
PC. Back that folder up: the encryption key in .n8n\config is what unlocks the saved credentials.

.EXAMPLE
windows\start-n8n.cmd

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File windows\start-n8n.ps1 -RegisterAtLogon
Starts n8n hidden at every logon (setup output in <install folder>\setup.log, n8n's log in .n8n\logs).
-UnregisterAtLogon removes that again.
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$EnvFile = '',
    # Skip tools\first-run-setup.mjs and only start n8n.
    [switch]$SkipSetup,
    # No console: setup output goes to setup.log and n8n logs to a file (the logon task uses this).
    [switch]$Hidden,
    [switch]$RegisterAtLogon,
    [switch]$UnregisterAtLogon
)

$ErrorActionPreference = 'Stop'
$script:TaskName = 'n8n-sm start at logon'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'n8n-sm' }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot 'n8n.env' }
$script:SetupLog = Join-Path $InstallRoot 'setup.log'

function Join-Parts { return [System.IO.Path]::Combine([string[]]$args) }

function Say([string]$Message) {
    $line = '[start-n8n] ' + $Message
    if ($Hidden) { try { Add-Content -LiteralPath $script:SetupLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss ') + $line) -Encoding UTF8 } catch { } }
    else { Write-Host $line }
}

# KEY=VALUE lines into this process's environment (same rules as Docker's env_file: no inline comments,
# optional quotes around the value). An empty value removes the variable. Returns how many were set.
function Import-EnvFile([string]$Path) {
    $count = 0
    foreach ($raw in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }
        $i = $line.IndexOf('=')
        if ($i -lt 1) { continue }
        $key = $line.Substring(0, $i).Trim()
        $value = $line.Substring($i + 1).Trim()
        if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
        $count++
    }
    return $count
}

function Set-Default([string]$Name, [string]$Value) {
    if (-not [Environment]::GetEnvironmentVariable($Name, 'Process')) { [Environment]::SetEnvironmentVariable($Name, $Value, 'Process') }
}

# Whether something already answers on 127.0.0.1:<port> (an n8n started earlier, for example).
function Test-PortBusy([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $wait = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        return ($wait.AsyncWaitHandle.WaitOne(700) -and $client.Connected)
    } catch { return $false } finally { $client.Close() }
}

# Runs node with arguments and returns its exit code. Output goes to the console (Out-Host, so it is not mixed
# into this function's return value), or in -Hidden mode is appended to setup.log as UTF-8 text.
function Invoke-Node([string]$NodeExe, [string[]]$Arguments) {
    if (-not $Hidden) { & $NodeExe @Arguments | Out-Host; return $LASTEXITCODE }
    $ErrorActionPreference = 'Continue'   # stderr lines arrive as error records in Windows PowerShell
    & $NodeExe @Arguments 2>&1 | ForEach-Object { "$_" } | Add-Content -LiteralPath $script:SetupLog -Encoding UTF8
    return $LASTEXITCODE
}

function Register-AtLogon {
    try {
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $taskArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Hidden -InstallRoot "{1}" -EnvFile "{2}"' -f $PSCommandPath, $InstallRoot, $EnvFile
        $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $action = New-ScheduledTaskAction -Execute $ps -Argument $taskArgs -WorkingDirectory $script:RepoRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $null = Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -Description 'Starts n8n (stock-market setup) hidden at logon.'
        Write-Host ('[start-n8n] task "{0}" registered: n8n starts hidden at every logon. Setup output: {1}; n8n log: {2}' -f $script:TaskName, $script:SetupLog, (Join-Parts $InstallRoot '.n8n' 'logs' 'n8n.log'))
        return 0
    } catch {
        Write-Host ('[start-n8n] could not register the logon task: {0}' -f $_.Exception.Message)
        Write-Host '[start-n8n] instead: press Win+R, type shell:startup, and put a shortcut to windows\start-n8n.cmd in that folder.'
        return 2
    }
}

# Everything up to "n8n start". Returns an exit code to stop with, or @{ Node; Js; Version; Port } to start n8n.
function Invoke-Start {
    if ($UnregisterAtLogon) {
        try { Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction Stop; Write-Host ('[start-n8n] task "{0}" removed' -f $script:TaskName) }
        catch { Write-Host ('[start-n8n] no task "{0}" to remove ({1})' -f $script:TaskName, $_.Exception.Message) }
        return 0
    }
    if ($RegisterAtLogon) { return (Register-AtLogon) }

    $infoPath = Join-Path $InstallRoot 'install.json'
    if (-not (Test-Path -LiteralPath $infoPath)) { Say ('n8n is not installed yet ({0} is missing): run windows\install-n8n.cmd first' -f $infoPath); return 2 }
    $info = Get-Content -Raw -LiteralPath $infoPath | ConvertFrom-Json
    foreach ($p in @($info.nodeExe, $info.n8nJs)) {
        if (-not (Test-Path -LiteralPath $p)) { Say ('{0} is missing: run windows\install-n8n.cmd again' -f $p); return 2 }
    }
    # An earlier version of install-n8n.ps1 used a Node 24 found on PATH. That Node can change under n8n.
    if ([System.IO.Path]::GetFullPath($info.nodeExe) -ne [System.IO.Path]::GetFullPath((Join-Parts $InstallRoot 'node' 'node.exe'))) {
        Say ('n8n runs on the Node.js in {0}, not on its own copy. Run windows\install-n8n.cmd once more, so that switching or upgrading that Node.js (nvm) cannot break n8n.' -f $info.nodeDir)
    }
    $env:PATH = $info.nodeDir + [System.IO.Path]::PathSeparator + $info.appDir + [System.IO.Path]::PathSeparator + $env:PATH

    if (Test-Path -LiteralPath $EnvFile) { Say ('loaded {0} settings from {1}' -f (Import-EnvFile $EnvFile), $EnvFile) }
    else { Say ('{0} not found: copy windows\n8n.env.example to windows\n8n.env and fill in your keys. Until then the credentials are REPLACE_ME and nothing is published.' -f $EnvFile) }

    Set-Default 'N8N_USER_FOLDER' $InstallRoot
    Set-Default 'SM_WORKFLOWS_DIR' (Join-Path $script:RepoRoot 'workflows')
    Set-Default 'GENERIC_TIMEZONE' 'Africa/Lagos'
    Set-Default 'N8N_LISTEN_ADDRESS' '127.0.0.1'
    Set-Default 'N8N_PORT' '5678'
    Set-Default 'N8N_DIAGNOSTICS_ENABLED' 'false'
    Set-Default 'N8N_AUTO_PUBLISH' 'true'
    if ($Hidden) { Set-Default 'N8N_LOG_OUTPUT' 'file' }
    $env:N8N_BIN_JS = $info.n8nJs   # the setup runs the n8n CLI with this Node, no cmd.exe in between

    $port = [int]$env:N8N_PORT
    if (Test-PortBusy $port) { Say ('something already answers on port {0} (an n8n started earlier?). Open http://localhost:{0}, or stop it before starting again.' -f $port); return 1 }

    if (-not $SkipSetup) {
        Say 'stock-market setup: credentials, workflows, publishing'
        $code = Invoke-Node $info.nodeExe @((Join-Parts $script:RepoRoot 'tools' 'first-run-setup.mjs'))
        if ($code -ne 0) { Say 'the setup failed (see above); n8n starts anyway' }
    }
    return @{ Node = $info.nodeExe; Js = $info.n8nJs; Version = $info.n8nVersion; Port = $port }
}

# Dot-sourcing (". .\start-n8n.ps1") only loads the functions, for tests.
if ($MyInvocation.InvocationName -ne '.') {
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }   # node writes UTF-8
    if ($Hidden -and (Test-Path -LiteralPath $script:SetupLog) -and ((Get-Item -LiteralPath $script:SetupLog).Length -gt 5MB)) {
        Move-Item -LiteralPath $script:SetupLog -Destination ($script:SetupLog + '.old') -Force
    }
    $plan = Invoke-Start | Select-Object -Last 1
    if (-not ($plan -is [hashtable])) { exit ([int]$plan) }
    Say ('starting n8n {0}: http://localhost:{1} (Ctrl+C stops it)' -f $plan.Version, $plan.Port)
    if ($Hidden) { exit (Invoke-Node $plan.Node @($plan.Js, 'start')) }
    # Started here at the top level, n8n writes straight to this console window.
    & $plan.Node $plan.Js start
    exit $LASTEXITCODE
}
