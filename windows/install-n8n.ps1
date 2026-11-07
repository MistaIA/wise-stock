#Requires -Version 5.1
<#
.SYNOPSIS
Installs n8n 2.46.6 with npm on Windows, and retries every hour when the internet fails.

.DESCRIPTION
Steps:
  1. Node.js 24 (x64). n8n 2.46.6 needs Node 24 or newer, and Node 24 is the version for which all of n8n's
     native modules ship prebuilt Windows binaries (isolated-vm, the Kafka client, sqlite3), so no compiler or
     Visual Studio is needed. n8n gets its own copy: the latest Node 24 zip is downloaded from nodejs.org,
     checked against nodejs.org's SHA-256 list and unpacked into the install folder. A Node.js of your own (from
     the nodejs.org installer, nvm-windows, fnm or Volta) is neither used nor changed, so switching or upgrading
     it later cannot break n8n. Nothing is installed system-wide and no administrator rights are needed.
  2. npm install --global n8n@2.46.6 --prefix <install folder>\app
  3. Checks that n8n starts and reports 2.46.6, then writes install.json for start-n8n.ps1.

When a step fails because of the internet (no connection, DNS, timeout, connection reset, a download that breaks
off, a prebuilt binary that could not be fetched from GitHub), the install is retried every hour:
  - by default through a Windows scheduled task "n8n-sm install retry" (runs hidden, at most 30 days, and
    removes itself once n8n is installed), so it carries on after you close this window or restart the PC;
  - with -Loop, in this window instead.
Files locked by an antivirus scan (EBUSY, EPERM) are retried the same way. Any other failure stops the retries
and is written to install.log with the reason. npm's own output of each attempt is kept in logs\.

Install folder (default %LOCALAPPDATA%\n8n-sm):
  node\          n8n's own Node.js 24
  app\           n8n (app\n8n.cmd, app\node_modules\n8n)
  install.json   what start-n8n.ps1 needs
  install.log    one line per step and attempt
  logs\          npm output of each attempt

Exit codes: 0 installed, 1 network problem (a retry is scheduled), 2 stopped on another error,
3 another install run is already busy.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File windows\install-n8n.ps1
Installs now; on a network failure, hands over to the hourly task. Double-clicking install-n8n.cmd does the same.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File windows\install-n8n.ps1 -Loop
Retries every hour in this window instead of a scheduled task.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File windows\install-n8n.ps1 -Unregister
Removes the hourly retry task.
#>
[CmdletBinding()]
param(
    # One attempt, no task registration (the scheduled task runs the script like this).
    [switch]$Once,
    # Retry every hour in this window instead of using a scheduled task.
    [switch]$Loop,
    # Only register the hourly retry task.
    [switch]$RegisterTask,
    # Remove the hourly retry task and exit.
    [switch]$Unregister,
    [string]$InstallRoot = '',
    [string]$N8nVersion = '2.46.6',
    [int]$RetryMinutes = 60,
    [int]$RetryDays = 30
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest very slow in Windows PowerShell

$script:TaskName = 'n8n-sm install retry'
$script:NodeMajor = 24
$script:P = $null          # paths, set by Initialize-Paths
$script:LogFile = $null
$script:ProbeUrls = @('https://registry.npmjs.org/-/ping', 'https://github.com/')   # npm packages; prebuilt binaries
$script:NodeDistBase = 'https://nodejs.org/dist/'

# ---------------------------------------------------------------------------------------------------------------
# Logging and failure kinds
# ---------------------------------------------------------------------------------------------------------------
function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    if ($Level -eq 'ERROR') { Write-Host $line -ForegroundColor Red }
    elseif ($Level -eq 'WARN') { Write-Host $line -ForegroundColor Yellow }
    else { Write-Host $line }
    if ($script:LogFile) {
        try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch { }
    }
}

# A failure that is worth retrying in an hour (internet, or a file briefly locked by an antivirus).
function Stop-Retry([string]$Why) { throw ('RETRY: ' + $Why) }
# A failure that retrying will not fix.
function Stop-Hard([string]$Why) { throw ('STOP: ' + $Why) }

# Messages of network failures, from npm, node-pre-gyp, prebuild-install, curl and .NET.
$script:NetworkPatterns = @(
    'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL',
    'ECONNREFUSED', 'ECONNABORTED', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET', 'EHOSTUNREACH', 'EHOSTDOWN', 'EPIPE',
    'EPROTO', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'socket hang up', 'network connectivity', 'getaddrinfo', 'Client network socket disconnected',
    'request to https?://\S+ failed', 'premature close', 'ERR_STREAM_PREMATURE_CLOSE', 'Socket timeout',
    'Tried to download\((408|429|5\d\d)\)', 'npm (error|ERR!) code E(408|429|500|502|503|504)\b',
    'The remote name could not be resolved', 'Unable to connect to the remote server', 'The operation has timed out',
    'The underlying connection was closed', 'The request was aborted', 'No such host is known',
    'A connection attempt failed', 'An existing connection was forcibly closed', 'actively refused',
    'An error occurred while sending the request', 'The SSL connection could not be established',
    'Could not resolve host', 'Failed to connect to', 'Connection timed out', 'Operation timed out',
    'Recv failure', 'transfer closed with', 'Empty reply from server'
)

function Test-NetworkText([string]$Text) {
    foreach ($p in $script:NetworkPatterns) { if ($Text -match $p) { return $true } }
    return $false
}

# What a failed npm run means, from its output. Returns @{ Kind = 'network'|'corrupt'|'locked'|'hard'|'unknown'; Why }.
function Get-NpmFailure([string]$Text) {
    $codes = @([regex]::Matches($Text, 'npm (?:error|ERR!) code (\S+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    $first = ''
    $errLines = @($Text -split "`r?`n" | Where-Object { $_ -match '^npm (error|ERR!) ' -and $_ -notmatch '^npm (error|ERR!) (A complete log|code |errno |syscall |path |command |cwd )' } | Select-Object -First 4)
    if ($errLines.Count) { $first = ($errLines -join ' / ') -replace '^npm (error|ERR!) ', '' }
    $codeText = if ($codes.Count) { 'npm error ' + ($codes -join ', ') + ': ' } else { '' }
    if ($Text -match 'ENOSPC') { return @{ Kind = 'hard'; Why = 'the disk is full (ENOSPC). Free some space and run the install again.' } }
    if ($Text -match 'SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT') {
        return @{ Kind = 'hard'; Why = 'HTTPS certificates are rejected: a proxy or antivirus is intercepting HTTPS. Point npm at its certificate (npm config set cafile <file>) and run the install again.' }
    }
    if (Test-NetworkText $Text) { return @{ Kind = 'network'; Why = $codeText + $first } }
    if ($Text -match 'EINTEGRITY|TAR_BAD_ARCHIVE|TAR_ENTRY_INVALID|Z_DATA_ERROR|Z_BUF_ERROR|unexpected end of file') {
        return @{ Kind = 'corrupt'; Why = 'a download arrived damaged (' + $codeText + $first + ')' }
    }
    if ($Text -match '\b(EBUSY|EPERM|EMFILE)\b') { return @{ Kind = 'locked'; Why = 'files were locked, usually by an antivirus scan (' + $codeText + $first + ')' } }
    if ($Text -match 'Tried to download\(404\)|No prebuilt binaries found') {
        return @{ Kind = 'hard'; Why = 'a native module has no prebuilt binary for this Node.js version. With Node.js 24 x64 this should not happen; see the npm log.' }
    }
    if ($Text -match 'gyp ERR!|find VS|Visual Studio|MSBuild') {
        return @{ Kind = 'hard'; Why = 'a native module had to be compiled, which needs Visual Studio Build Tools. With Node.js 24 x64 this should not happen; see the npm log.' }
    }
    if ($Text -match 'EBADENGINE|Unsupported engine') { return @{ Kind = 'hard'; Why = 'this Node.js version is not supported by n8n ' + $N8nVersion + '.' } }
    if ($Text -match 'ETARGET|E404|No matching version') { return @{ Kind = 'hard'; Why = 'n8n ' + $N8nVersion + ' was not found in the npm registry.' } }
    if (-not $first) { $first = 'see the npm log' }
    return @{ Kind = 'unknown'; Why = $codeText + $first }
}

# ---------------------------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------------------------
function Initialize-Paths {
    $root = $InstallRoot
    if (-not $root) { $root = Join-Path $env:LOCALAPPDATA 'n8n-sm' }
    $root = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
    $script:P = @{
        Root      = $root
        Node      = Join-Path $root 'node'
        App       = Join-Path $root 'app'
        Logs      = Join-Path $root 'logs'
        Downloads = Join-Path $root 'downloads'
        Info      = Join-Path $root 'install.json'
        Lock      = Join-Path $root 'install.lock'
    }
    foreach ($d in @($script:P.Root, $script:P.Logs, $script:P.Downloads)) {
        if (-not (Test-Path -LiteralPath $d)) { $null = New-Item -ItemType Directory -Path $d -Force }
    }
    $script:LogFile = Join-Path $root 'install.log'
}

# Path.Combine of several parts (Join-Path takes only two in Windows PowerShell).
function Join-Parts { return [System.IO.Path]::Combine([string[]]$args) }

function Remove-Dir([string]$Path) {
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

# Runs a program, returns @{ Code; Text } with stdout and stderr together. Windows PowerShell turns stderr lines
# into error records, so the error preference is relaxed here and every line is turned back into plain text.
function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments, [string]$LogPath = '', [switch]$Echo)
    $ErrorActionPreference = 'Continue'
    $lines = New-Object System.Collections.Generic.List[string]
    & $FilePath @Arguments 2>&1 | ForEach-Object {
        $s = "$_"
        $lines.Add($s)
        if ($Echo) { Write-Host $s }
    }
    $code = $LASTEXITCODE
    if ($LogPath) {
        try { [System.IO.File]::AppendAllText($LogPath, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding $false)) } catch { }
    }
    return @{ Code = $code; Text = ($lines -join "`n") }
}

# Hosts the install needs that do not answer right now (empty when all answer).
function Get-UnreachableUrls([string[]]$Urls) {
    $down = @()
    foreach ($u in $Urls) {
        $ok = $false
        for ($i = 0; $i -lt 2 -and -not $ok; $i++) {
            try {
                $null = Invoke-WebRequest -Uri $u -Method Head -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 5
                $ok = $true
            } catch {
                $status = 0
                try { $status = [int]$_.Exception.Response.StatusCode } catch { }
                # Any HTTP answer below 500 means the host is reachable.
                if ($status -gt 0 -and $status -lt 500) { $ok = $true } elseif ($i -eq 0) { Start-Sleep -Seconds 5 }
            }
        }
        if (-not $ok) { $down += ([uri]$u).Host }
    }
    return , $down
}

# Downloads a file. curl.exe (in Windows 10 1803 and later) resumes a partial file left by an earlier broken attempt;
# Invoke-WebRequest is the fallback.
function Save-Url {
    param([string]$Url, [string]$OutFile, [switch]$NoResume)
    if ($NoResume -and (Test-Path -LiteralPath $OutFile)) { Remove-Item -LiteralPath $OutFile -Force }
    $curl = ''
    if ($env:SystemRoot) { $curl = Join-Path $env:SystemRoot 'System32\curl.exe' }
    if ($curl -and (Test-Path -LiteralPath $curl)) {
        $curlArgs = @('-sS', '-L', '--fail', '--retry', '3', '--retry-delay', '10', '--connect-timeout', '30', '-o', $OutFile)
        if (-not $NoResume) { $curlArgs += @('-C', '-') }
        $r = Invoke-Native -FilePath $curl -Arguments ($curlArgs + @($Url))
        if ($r.Code -eq 0) { return }
        $text = ($r.Text -replace '\s+', ' ').Trim()
        if ($r.Code -eq 33 -or $r.Code -eq 36) {
            # the server refused to resume: start over next time
            Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
            Stop-Retry ('download of {0} could not resume; it starts over on the next try ({1})' -f $Url, $text)
        }
        if (@(5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 92) -contains $r.Code) { Stop-Retry ('download of {0} failed (curl {1}: {2})' -f $Url, $r.Code, $text) }
        if ($r.Code -eq 22 -and $text -match 'error: (408|429|5\d\d)') { Stop-Retry ('download of {0} failed: {1}' -f $Url, $text) }
        Stop-Hard ('download of {0} failed (curl {1}: {2})' -f $Url, $r.Code, $text)
    }
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 900
    } catch {
        $status = 0
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
        if ($status -ge 400 -and $status -lt 500 -and $status -ne 408 -and $status -ne 429) { Stop-Hard ('download of {0} failed: HTTP {1}' -f $Url, $status) }
        Stop-Retry ('download of {0} failed: {1}' -f $Url, $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------------------------------------------
# Node.js 24
# ---------------------------------------------------------------------------------------------------------------
# @{ Exe; Dir; Version; Major; Arch } for a node.exe, or $null when it does not run.
function Get-NodeInfo([string]$Exe) {
    if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { return $null }
    $r = Invoke-Native -FilePath $Exe -Arguments @('-p', "process.version+'|'+process.arch")
    if ($r.Code -ne 0) { return $null }
    $parts = $r.Text.Trim() -split '\|'
    if ($parts.Count -lt 2 -or $parts[0] -notmatch '^v(\d+)\.') { return $null }
    $major = [int]$Matches[1]
    return @{ Exe = $Exe; Dir = (Split-Path -Parent $Exe); Version = $parts[0]; Major = $major; Arch = $parts[1].Trim() }
}

function Test-NodeUsable($Info) {
    if (-not $Info) { return $false }
    if ($Info.Major -ne $script:NodeMajor -or $Info.Arch -ne 'x64') { return $false }
    return (Test-Path -LiteralPath (Join-Parts $Info.Dir 'node_modules' 'npm' 'bin' 'npm-cli.js'))
}

# n8n always runs on its own Node.js in the install folder. A node.exe on PATH (nodejs.org installer, nvm-windows,
# fnm, Volta) is not used: n8n's native modules are built for Node 24, and that Node can change under n8n later
# ("nvm use 22", an upgrade to Node 26), after which n8n would no longer start.
function Get-PrivateNodeExe { return (Join-Path $script:P.Node 'node.exe') }

function Get-Node {
    $private = Get-NodeInfo (Get-PrivateNodeExe)
    if (Test-NodeUsable $private) { Write-Log ('using Node.js {0} in {1}' -f $private.Version, $private.Dir); return $private }
    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { Write-Log ('n8n gets its own Node.js {0}; the node.exe on PATH ({1}) is not used and not changed' -f $script:NodeMajor, $cmd.Path) }
    return (Install-PrivateNode)
}

function Install-PrivateNode {
    $base = '{0}latest-v{1}.x/' -f $script:NodeDistBase, $script:NodeMajor
    $sums = Join-Path $script:P.Downloads 'SHASUMS256.txt'
    Write-Log ('downloading the list of Node.js {0} files from {1}' -f $script:NodeMajor, $base)
    Save-Url -Url ($base + 'SHASUMS256.txt') -OutFile $sums -NoResume
    $pattern = '^([0-9a-f]{64})\s+(node-v' + $script:NodeMajor + '\.\d+\.\d+-win-x64\.zip)\s*$'
    $line = Get-Content -LiteralPath $sums | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $line -or $line -notmatch $pattern) { Stop-Hard ('no Windows x64 zip listed in {0}SHASUMS256.txt' -f $base) }
    $hash = $Matches[1]
    $name = $Matches[2]
    $zip = Join-Path $script:P.Downloads $name
    $have = (Test-Path -LiteralPath $zip) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -eq $hash)
    if (-not $have) {
        Write-Log ('downloading {0} (about 30 MB)' -f $name)
        Save-Url -Url ($base + $name) -OutFile $zip
        $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
        if ($got -ne $hash) {
            Remove-Item -LiteralPath $zip -Force
            Stop-Retry ('{0} arrived incomplete or damaged (SHA-256 does not match nodejs.org); it is downloaded again on the next try' -f $name)
        }
    }
    Write-Log ('unpacking {0} (SHA-256 checked)' -f $name)
    $unpack = Join-Path $script:P.Root 'node-unpack'
    Remove-Dir $unpack
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpack)
    } catch {
        Remove-Dir $unpack
        Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force
    }
    $inner = Join-Path $unpack ($name -replace '\.zip$', '')
    if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) { Stop-Hard ('unexpected layout inside {0}' -f $name) }
    Remove-Dir $script:P.Node
    Move-Item -LiteralPath $inner -Destination $script:P.Node
    Remove-Dir $unpack
    $info = Get-NodeInfo (Join-Path $script:P.Node 'node.exe')
    if (-not (Test-NodeUsable $info)) { Stop-Hard ('the unpacked Node.js in {0} does not run' -f $script:P.Node) }
    Write-Log ('Node.js {0} ready in {1}' -f $info.Version, $info.Dir)
    return $info
}

# ---------------------------------------------------------------------------------------------------------------
# n8n
# ---------------------------------------------------------------------------------------------------------------
function Get-N8nJs { return (Join-Parts $script:P.App 'node_modules' 'n8n' 'bin' 'n8n') }

# The n8n version that this node.exe + n8n entry script report, or '' when it does not run.
function Get-N8nVersion([string]$NodeExe, [string]$N8nJs) {
    if (-not (Test-Path -LiteralPath $NodeExe) -or -not (Test-Path -LiteralPath $N8nJs)) { return '' }
    $saved = $env:N8N_USER_FOLDER
    $env:N8N_USER_FOLDER = $script:P.Root   # keep n8n away from %USERPROFILE%\.n8n while checking
    try { $r = Invoke-Native -FilePath $NodeExe -Arguments @($N8nJs, '--version') } finally { $env:N8N_USER_FOLDER = $saved }
    if ($r.Code -ne 0) { return '' }
    $m = [regex]::Match($r.Text, '\b(\d+\.\d+\.\d+)\b')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Test-Installed {
    if (-not (Test-Path -LiteralPath $script:P.Info)) { return $false }
    try { $i = Get-Content -Raw -LiteralPath $script:P.Info | ConvertFrom-Json } catch { return $false }
    if ($i.n8nVersion -ne $N8nVersion) { return $false }
    if ($i.nodeExe -ne (Get-PrivateNodeExe)) {
        # installed by an earlier version of this script on the Node.js from PATH: install again on n8n's own Node
        Write-Log ('n8n {0} was installed on the Node.js in {1}; it is installed again on its own Node.js' -f $i.n8nVersion, $i.nodeDir)
        return $false
    }
    return ((Get-N8nVersion $i.nodeExe $i.n8nJs) -eq $N8nVersion)
}

function Assert-Prerequisites {
    $v = [Environment]::OSVersion.Version
    if ($v.Major -lt 10) { Stop-Hard ('Node.js {0} needs Windows 10 or newer (this is Windows {1})' -f $script:NodeMajor, $v) }
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    if ($arch -ne 'AMD64' -and $arch -ne 'ARM64') { Stop-Hard ('n8n needs 64-bit Windows (this is {0})' -f $arch) }
    if ($arch -eq 'ARM64') { Write-Log 'ARM64 Windows: the x64 Node.js runs under emulation (n8n''s native modules ship x64 binaries only)' 'WARN' }
    $drive = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($script:P.Root))
    if ($drive.AvailableFreeSpace -lt 3GB) { Stop-Hard ('only {0:N1} GB free on {1}; n8n needs about 3 GB' -f ($drive.AvailableFreeSpace / 1GB), $drive.Name) }
}

function Get-NewestNpmLog {
    $f = Get-ChildItem -LiteralPath $script:P.Logs -Filter '*-debug-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $f) { return '' }
    return ((Get-Content -LiteralPath $f.FullName -Tail 400 -ErrorAction SilentlyContinue) -join "`n")
}

function Install-N8n($Node, [string]$AttemptLog) {
    $npmCli = Join-Parts $Node.Dir 'node_modules' 'npm' 'bin' 'npm-cli.js'
    # Install scripts (prebuilt binaries for sqlite3 and the Kafka client) run "node" from PATH: it must be this one.
    $env:PATH = $Node.Dir + ';' + $script:P.App + ';' + $env:PATH
    $env:npm_config_update_notifier = 'false'
    $env:SCARF_ANALYTICS = 'false'
    $npmArgs = @(
        $npmCli, 'install', '--global', ('n8n@' + $N8nVersion), '--prefix', $script:P.App,
        '--no-audit', '--no-fund', '--prefer-offline', '--foreground-scripts',
        '--fetch-retries', '5', '--fetch-retry-mintimeout', '20000', '--fetch-retry-maxtimeout', '120000', '--fetch-timeout', '600000',
        '--logs-dir', $script:P.Logs
    )
    Write-Log ('npm install --global n8n@{0} --prefix "{1}" (several minutes; output also in {2})' -f $N8nVersion, $script:P.App, $AttemptLog)
    $r = Invoke-Native -FilePath $Node.Exe -Arguments $npmArgs -LogPath $AttemptLog -Echo
    if ($r.Code -eq 0) { return }
    $failure = Get-NpmFailure ($r.Text + "`n" + (Get-NewestNpmLog))
    switch ($failure.Kind) {
        'network' { Stop-Retry ('npm could not download everything: ' + $failure.Why) }
        'locked' { Stop-Retry $failure.Why }
        'corrupt' {
            $null = Invoke-Native -FilePath $Node.Exe -Arguments @($npmCli, 'cache', 'verify') -LogPath $AttemptLog
            Stop-Retry ($failure.Why + '; the npm cache was checked and the damaged file dropped')
        }
        'hard' { Stop-Hard ($failure.Why + ' npm output: ' + $AttemptLog) }
        default {
            $down = Get-UnreachableUrls $script:ProbeUrls
            if ($down.Count) { Stop-Retry ('npm failed while {0} did not answer ({1})' -f ($down -join ', '), $failure.Why) }
            Stop-Hard ('npm install failed with exit code {0}: {1}. npm output: {2}' -f $r.Code, $failure.Why, $AttemptLog)
        }
    }
}

function Save-InstallInfo($Node) {
    $info = [ordered]@{
        n8nVersion  = $N8nVersion
        nodeExe     = $Node.Exe
        nodeDir     = $Node.Dir
        nodeVersion = $Node.Version
        appDir      = $script:P.App
        n8nJs       = (Get-N8nJs)
        installedAt = (Get-Date).ToString('s')
    }
    Write-Utf8NoBom $script:P.Info (($info | ConvertTo-Json) + "`r`n")
}

# One install attempt. Returns 'ok', 'retry' or 'stop'.
function Invoke-Attempt {
    $attemptLog = Join-Path $script:P.Logs ('npm-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        if (Test-Installed) { Write-Log ('n8n {0} is already installed in {1}' -f $N8nVersion, $script:P.App); return 'ok' }
        Write-Log ('installing n8n {0} into {1}' -f $N8nVersion, $script:P.Root)
        Assert-Prerequisites
        $down = Get-UnreachableUrls $script:ProbeUrls
        if ($down.Count) { Stop-Retry ('no connection to {0}' -f ($down -join ', ')) }
        $node = Get-Node
        Install-N8n $node $attemptLog
        $got = Get-N8nVersion $node.Exe (Get-N8nJs)
        if ($got -ne $N8nVersion) { Stop-Hard ('npm finished but n8n does not start or reports "{0}" instead of {1}. npm output: {2}' -f $got, $N8nVersion, $attemptLog) }
        Save-InstallInfo $node
        Write-Log ('n8n {0} installed. Start it with windows\start-n8n.cmd (fill in windows\n8n.env first).' -f $N8nVersion)
        return 'ok'
    } catch {
        $msg = $_.Exception.Message
        if ($msg.StartsWith('RETRY: ')) { Write-Log $msg.Substring(7) 'WARN'; return 'retry' }
        if ($msg.StartsWith('STOP: ')) { Write-Log $msg.Substring(6) 'ERROR'; return 'stop' }
        # Unexpected error: retry when it looks like the network, or the network is down right now.
        if ((Test-NetworkText $msg) -or ((Get-UnreachableUrls $script:ProbeUrls).Count -gt 0)) { Write-Log ('network problem: ' + $msg) 'WARN'; return 'retry' }
        Write-Log ('stopped on an unexpected error: {0} ({1})' -f $msg, ($_.InvocationInfo.PositionMessage -replace '\s+', ' ')) 'ERROR'
        return 'stop'
    } finally {
        # keep the last 20 attempt logs
        Get-ChildItem -LiteralPath $script:P.Logs -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 | Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------------------------------------------
# Hourly retry task
# ---------------------------------------------------------------------------------------------------------------
function Register-RetryTask {
    try {
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $taskArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Once -InstallRoot "{1}" -N8nVersion {2} -RetryMinutes {3} -RetryDays {4}' -f $PSCommandPath, $script:P.Root, $N8nVersion, $RetryMinutes, $RetryDays
        $action = New-ScheduledTaskAction -Execute $ps -Argument $taskArgs -WorkingDirectory $script:P.Root
        $start = (Get-Date).AddMinutes($RetryMinutes)
        $trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes $RetryMinutes) -RepetitionDuration (New-TimeSpan -Days $RetryDays)
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $null = Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force `
            -Description 'Retries the n8n install (stock-market setup) every hour until it succeeds, then removes itself. Log: install.log in the install folder.'
        Write-Log ('scheduled task "{0}" registered: next try at {1:HH:mm}, then every {2} min for up to {3} days; it removes itself once n8n is installed' -f $script:TaskName, $start, $RetryMinutes, $RetryDays)
        return $true
    } catch {
        Write-Log ('could not register the scheduled task: ' + $_.Exception.Message) 'WARN'
        return $false
    }
}

function Unregister-RetryTask {
    try {
        $t = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        if ($t) {
            Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
            Write-Log ('scheduled task "{0}" removed' -f $script:TaskName)
        }
    } catch {
        Write-Log ('could not remove the scheduled task "{0}": {1}' -f $script:TaskName, $_.Exception.Message) 'WARN'
    }
}

# ---------------------------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------------------------
function Invoke-Main {
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }   # npm and node write UTF-8
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    Initialize-Paths
    if ($Unregister) { Unregister-RetryTask; return 0 }
    if ($RegisterTask) { if (Register-RetryTask) { return 0 } else { return 2 } }

    # One run at a time (a manual run and the hourly task must not install over each other).
    try {
        $lock = [System.IO.File]::Open($script:P.Lock, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch {
        Write-Log ('another install run is busy (see {0}); this one stops' -f $script:LogFile) 'WARN'
        return 3
    }
    try {
        $deadline = (Get-Date).AddDays($RetryDays)
        $inWindow = [bool]$Loop
        while ($true) {
            $result = Invoke-Attempt
            if ($result -eq 'ok') { Unregister-RetryTask; return 0 }
            if ($result -eq 'stop') {
                Unregister-RetryTask
                Write-Log ('install stopped; fix the problem above and run windows\install-n8n.cmd again. Log: {0}' -f $script:LogFile) 'ERROR'
                return 2
            }
            # network problem
            if ($Once) { Write-Log ('the hourly task tries again in {0} minutes' -f $RetryMinutes); return 1 }
            if (-not $inWindow) {
                if (Register-RetryTask) {
                    Write-Log 'you can close this window: the install carries on in the background every hour (also after a restart)'
                    return 1
                }
                $inWindow = $true
            }
            if ((Get-Date) -gt $deadline) { Write-Log ('gave up after {0} days of retries' -f $RetryDays) 'ERROR'; return 1 }
            Write-Log ('retrying in {0} minutes; keep this window open (Ctrl+C stops)' -f $RetryMinutes)
            Start-Sleep -Seconds ($RetryMinutes * 60)
        }
    } finally {
        $lock.Dispose()
        Remove-Item -LiteralPath $script:P.Lock -Force -ErrorAction SilentlyContinue
    }
}

# Dot-sourcing (". .\install-n8n.ps1") only loads the functions, for tests.
if ($MyInvocation.InvocationName -ne '.') {
    $exitCode = Invoke-Main | Select-Object -Last 1
    exit ([int]$exitCode)
}
