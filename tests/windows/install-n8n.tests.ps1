# Tests for windows/install-n8n.ps1 without touching the real internet: a fake npm, a fake Node download served
# from 127.0.0.1, and the real decision code of the script. Runs in PowerShell 7 on Linux (Docker) or Windows.
#   pwsh -NoProfile -File tests/windows/install-n8n.tests.ps1 -NodeExe /path/to/node
# On Linux: docker run --rm -v "$PWD:/w" -v /path/to/node-binary-dir:/n mcr.microsoft.com/powershell:lts-7.4-alpine-3.20 \
#             pwsh -NoProfile -File /w/tests/windows/install-n8n.tests.ps1 -NodeExe /n/node
param([Parameter(Mandatory = $true)][string]$NodeExe)

$ErrorActionPreference = 'Stop'
$failures = 0
function Check([bool]$Condition, [string]$Name) {
    if ($Condition) { Write-Host "ok    $Name" } else { Write-Host "FAIL  $Name" -ForegroundColor Red; $script:failures++ }
}
function Throws([scriptblock]$Block, [string]$Prefix) {
    try { & $Block; return '' } catch { $m = $_.Exception.Message; if ($m.StartsWith($Prefix)) { return $m } return "unexpected: $m" }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('n8n-sm-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$null = New-Item -ItemType Directory -Path $work
$root = Join-Path $work 'install'
$script = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'windows/install-n8n.ps1'

. $script -InstallRoot $root
$script:NodeMajor = [int]((& $NodeExe -p 'process.versions.node.split(".")[0]').Trim())   # test with the Node we have
$script:ProbeUrls = @()                                                                   # no real internet in tests
if (-not $IsWindows) { function Assert-Prerequisites { } }                                  # Windows-only checks
Initialize-Paths
Check (Test-Path $script:P.Logs) 'Initialize-Paths creates the folders'

# ---------------- failure classification ----------------
$cases = @(
    @('network', "npm error code ECONNRESET`nnpm error network request to https://registry.npmjs.org/n8n failed, reason: read ECONNRESET`nnpm error network This is a problem related to network connectivity."),
    @('network', "npm error code ETIMEDOUT`nnpm error errno ETIMEDOUT`nnpm error network request to https://registry.npmjs.org/@n8n%2fconfig failed, reason: connect ETIMEDOUT 104.16.1.35:443"),
    @('network', "npm error code EAI_AGAIN`nnpm error syscall getaddrinfo`nnpm error errno EAI_AGAIN`nnpm error request to https://registry.npmjs.org/n8n failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org"),
    @('network', "node-pre-gyp WARN Pre-built binaries not installable for @confluentinc/kafka-javascript@1.9.1 and node@24.22.2 (node-v137 ABI, unknown) (falling back to source compile with node-gyp)`nnode-pre-gyp WARN Hit error request to https://github.com/confluentinc/confluent-kafka-javascript/releases/download/v1.9.1/x.tar.gz failed, reason: connect ETIMEDOUT 140.82.121.4:443`ngyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use`nnpm error code 1"),
    @('network', "prebuild-install warn install getaddrinfo ENOTFOUND github.com`ngyp ERR! find Python`nnpm error code 1"),
    @('network', "npm error code E503`nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/n8n"),
    @('hard', "node-pre-gyp WARN Tried to download(404): https://github.com/confluentinc/confluent-kafka-javascript/releases/download/v1.9.1/confluent-kafka-javascript-v1.9.1-node-v147-win32-unknown-x64.tar.gz`ngyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use`nnpm error code 1"),
    @('hard', "gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use`nnpm error code 1`nnpm error path C:\x\node_modules\isolated-vm"),
    @('hard', "npm error code SELF_SIGNED_CERT_IN_CHAIN`nnpm error errno SELF_SIGNED_CERT_IN_CHAIN`nnpm error request to https://registry.npmjs.org/n8n failed, reason: self-signed certificate in certificate chain"),
    @('hard', "npm error code ENOSPC`nnpm error syscall write`nnpm error errno -28"),
    @('hard', "npm error code ETARGET`nnpm error notarget No matching version found for n8n@2.46.6."),
    @('corrupt', "npm error code EINTEGRITY`nnpm error sha512-AAAA integrity checksum failed when using sha512"),
    @('locked', "npm error code EPERM`nnpm error syscall rename`nnpm error Error: EPERM: operation not permitted, rename 'C:\x\a' -> 'C:\x\b'"),
    @('locked', "npm error code EBUSY`nnpm error syscall unlink`nnpm error Error: EBUSY: resource busy or locked, unlink 'C:\x\node.dll'"),
    @('unknown', "npm error code EWEIRD`nnpm error something nobody has seen")
)
foreach ($c in $cases) {
    $f = Get-NpmFailure $c[1]
    Check ($f.Kind -eq $c[0]) ("Get-NpmFailure -> {0}: {1}" -f $c[0], ($c[1].Substring(0, [Math]::Min(60, $c[1].Length)) -replace "`n", ' '))
}
Check ((Get-NpmFailure "npm error code EWEIRD`nnpm error something nobody has seen").Why -match 'EWEIRD: something nobody has seen') 'unknown failure keeps npm''s own words'

# ---------------- running programs ----------------
$r = Invoke-Native -FilePath $NodeExe -Arguments @('-e', 'console.log("out line"); console.error("err line"); process.exit(3)')
Check ($r.Code -eq 3) 'Invoke-Native returns the exit code'
Check (($r.Text -match 'out line') -and ($r.Text -match 'err line')) 'Invoke-Native keeps stdout and stderr (no error thrown for stderr)'
$info = Get-NodeInfo $NodeExe
Check ($info.Major -eq $script:NodeMajor -and $info.Arch -eq 'x64' -and $info.Version -match '^v\d+\.') "Get-NodeInfo reads $($info.Version) $($info.Arch)"
Check (-not (Test-NodeUsable $info)) 'a Node without npm next to it is not used'
Check ($null -eq (Get-NodeInfo (Join-Path $work 'missing-node.exe'))) 'Get-NodeInfo of a missing file is $null'

# ---------------- a fake private Node with a fake npm ----------------
$nodeDir = $script:P.Node
$null = New-Item -ItemType Directory -Path (Join-Parts $nodeDir 'node_modules' 'npm' 'bin') -Force
$null = New-Item -ItemType SymbolicLink -Path (Join-Path $nodeDir 'node.exe') -Target $NodeExe
$fakeNpm = @'
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), mode = process.env.FAKE_NPM || 'ok';
if (args[0] === 'cache') { console.log('Cache verified and compressed'); process.exit(0); }
const prefix = args[args.indexOf('--prefix') + 1];
const out = {
  econnreset: 'npm error code ECONNRESET\nnpm error network request to https://registry.npmjs.org/n8n failed, reason: read ECONNRESET',
  etarget: 'npm error code ETARGET\nnpm error notarget No matching version found for n8n@2.46.6.',
  eintegrity: 'npm error code EINTEGRITY\nnpm error sha512-AAAA integrity checksum failed',
  weird: 'npm error code EWEIRD\nnpm error something nobody has seen',
}[mode];
if (out) { console.error(out); process.exit(1); }
const bin = path.join(prefix, 'node_modules', 'n8n', 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'n8n'), mode === 'oldversion' ? 'console.log("1.0.0")' : 'console.log("' + (process.env.FAKE_N8N_VERSION || '2.46.6') + '")');
console.log('added 2298 packages in 3m');
'@
[System.IO.File]::WriteAllText((Join-Parts $nodeDir 'node_modules' 'npm' 'bin' 'npm-cli.js'), $fakeNpm)
Check (Test-NodeUsable (Get-NodeInfo (Join-Path $nodeDir 'node.exe'))) 'the private Node with npm next to it is used'

$env:FAKE_NPM = 'econnreset'
Check ((Invoke-Attempt) -eq 'retry') 'npm ECONNRESET -> retry'
$env:FAKE_NPM = 'eintegrity'
Check ((Invoke-Attempt) -eq 'retry') 'npm EINTEGRITY -> cache verify, retry'
Check ((Get-Content -Raw $script:LogFile) -match 'npm cache was checked') 'EINTEGRITY attempt is logged'
$env:FAKE_NPM = 'etarget'
Check ((Invoke-Attempt) -eq 'stop') 'npm ETARGET -> stop'
$env:FAKE_NPM = 'weird'
Check ((Invoke-Attempt) -eq 'stop') 'unknown npm error with the internet up -> stop'
$script:ProbeUrls = @('http://127.0.0.1:9/')   # nothing listens there: the internet looks down
Check ((Invoke-Attempt) -eq 'retry') 'unknown npm error while the probe fails -> retry'
$script:ProbeUrls = @()
$env:FAKE_NPM = 'oldversion'
Check ((Invoke-Attempt) -eq 'stop') 'npm succeeds but n8n reports another version -> stop'
$env:FAKE_NPM = 'ok'
Check ((Invoke-Attempt) -eq 'ok') 'npm succeeds -> ok'
$saved = Get-Content -Raw $script:P.Info | ConvertFrom-Json
Check ($saved.n8nVersion -eq '2.46.6' -and (Test-Path $saved.n8nJs) -and (Test-Path $saved.nodeExe)) 'install.json has the paths start-n8n.ps1 needs'
Check ([System.IO.File]::ReadAllBytes($script:P.Info)[0] -eq [byte][char]'{') 'install.json has no BOM'
$env:FAKE_NPM = 'econnreset'
Check ((Invoke-Attempt) -eq 'ok') 'already installed -> ok without running npm'
Check ((Get-Content -Raw $script:LogFile) -match 'is already installed') 'already installed is logged'
Check (@(Get-ChildItem $script:P.Logs -Filter 'npm-*.log').Count -ge 1) 'npm output of each attempt is kept in logs'
$saved.nodeExe = $NodeExe   # what an earlier version of the script wrote after using a Node 24 found on PATH
$saved.nodeDir = Split-Path -Parent $NodeExe
Write-Utf8NoBom $script:P.Info (($saved | ConvertTo-Json) + "`r`n")
Check (-not (Test-Installed)) 'an n8n installed on another Node.js (one on PATH) is not taken as installed'
$env:FAKE_NPM = 'ok'
Check ((Invoke-Attempt) -eq 'ok') 'it is installed again on n8n''s own Node'
Check ((Get-Content -Raw $script:P.Info | ConvertFrom-Json).nodeExe -eq (Join-Path $script:P.Node 'node.exe')) 'install.json then names n8n''s own Node'

# ---------------- main: lock and -Once ----------------
$lock = [System.IO.File]::Open($script:P.Lock, 'OpenOrCreate', 'ReadWrite', 'None')
Check ((Invoke-Main | Select-Object -Last 1) -eq 3) 'a second run while one is busy -> exit 3'
$lock.Dispose()
Remove-Item $script:P.Info
$Once = $true
$env:FAKE_NPM = 'econnreset'
Check ((Invoke-Main | Select-Object -Last 1) -eq 1) '-Once with a network failure -> exit 1 (the task tries again)'
$env:FAKE_NPM = 'ok'
Check ((Invoke-Main | Select-Object -Last 1) -eq 0) '-Once success -> exit 0'
$env:FAKE_NPM = 'etarget'
Remove-Item $script:P.Info
Check ((Invoke-Main | Select-Object -Last 1) -eq 2) '-Once with a hard failure -> exit 2'
$Once = $false

# ---------------- downloads and the private Node from a local nodejs.org ----------------
$site = Join-Path $work 'site'
$dist = Join-Parts $site 'dist' ("latest-v{0}.x" -f $script:NodeMajor)
$null = New-Item -ItemType Directory -Path $dist -Force
$pkg = Join-Path $work ('node-v{0}.1.2-win-x64' -f $script:NodeMajor)
$null = New-Item -ItemType Directory -Path (Join-Parts $pkg 'node_modules' 'npm' 'bin') -Force
[System.IO.File]::WriteAllText((Join-Path $pkg 'node.exe'), "#!/bin/sh`necho 'v$($script:NodeMajor).1.2|x64'`n")
[System.IO.File]::WriteAllText((Join-Parts $pkg 'node_modules' 'npm' 'bin' 'npm-cli.js'), '')
$zipName = 'node-v{0}.1.2-win-x64.zip' -f $script:NodeMajor
$zipPath = Join-Path $dist $zipName
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zs = [System.IO.File]::Open($zipPath, 'Create')
$za = New-Object System.IO.Compression.ZipArchive($zs, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($f in Get-ChildItem -Recurse -File $pkg) {
    $rel = (Split-Path -Leaf $pkg) + '/' + $f.FullName.Substring($pkg.Length + 1).Replace('\', '/')
    $e = $za.CreateEntry($rel)
    $e.ExternalAttributes = [int](0x81ED -shl 16)   # -rwxr-xr-x, so the fake node.exe can run after unzipping on Linux
    $w = $e.Open(); $b = [System.IO.File]::ReadAllBytes($f.FullName); $w.Write($b, 0, $b.Length); $w.Dispose()
}
$za.Dispose(); $zs.Dispose()
$hash = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
[System.IO.File]::WriteAllText((Join-Path $dist 'SHASUMS256.txt'), ("{0}  node-v{1}.1.2-win-arm64.zip`n{2}  {3}`n{0}  node-v{1}.1.2.tar.gz`n" -f ('0' * 64), $script:NodeMajor, $hash, $zipName))
$port = 18000 + (Get-Random -Maximum 1000)
$serverJs = Join-Path $work 'server.js'
[System.IO.File]::WriteAllText($serverJs, "const [root, port] = process.argv.slice(2); require('http').createServer((q, s) => { require('fs').readFile(require('path').join(root, decodeURIComponent(q.url)), (e, d) => { if (e) { s.writeHead(404); s.end('no'); } else { s.writeHead(200); s.end(d); } }); }).listen(Number(port), '127.0.0.1');")
# Start-Process joins its arguments with spaces and quotes nothing, so only space-free arguments here.
$server = Start-Process -FilePath $NodeExe -PassThru -ArgumentList @($serverJs, $site, $port)
Start-Sleep -Seconds 1
try {
    $out = Join-Path $work 'dl.txt'
    Save-Url -Url "http://127.0.0.1:$port/dist/latest-v$($script:NodeMajor).x/SHASUMS256.txt" -OutFile $out -NoResume
    Check ((Get-Content -Raw $out) -match $zipName) 'Save-Url downloads a file'
    Check ((Throws { Save-Url -Url "http://127.0.0.1:$port/missing.txt" -OutFile $out } 'STOP: ') -like 'STOP: *') 'Save-Url HTTP 404 -> stop'
    Check ((Throws { Save-Url -Url 'http://127.0.0.1:9/x' -OutFile $out } 'RETRY: ') -like 'RETRY: *') 'Save-Url connection refused -> retry'

    Remove-Dir $script:P.Node
    $script:NodeDistBase = "http://127.0.0.1:$port/dist/"
    $n = Install-PrivateNode
    Check ($n.Version -eq "v$($script:NodeMajor).1.2" -and (Test-Path (Join-Path $script:P.Node 'node.exe'))) 'Install-PrivateNode picks the win-x64 zip, checks SHA-256 and unpacks it'
    Check (-not (Test-Path (Join-Path $script:P.Root 'node-unpack'))) 'the unpack folder is removed'
    Check ((Get-Node).Version -eq "v$($script:NodeMajor).1.2") 'Get-Node then prefers the private Node'
    # A usable Node 24 on PATH (nodejs.org installer, nvm-windows, fnm) is left alone: n8n gets its own.
    $mine = Join-Path $work 'my-node'
    $null = New-Item -ItemType Directory -Path (Join-Parts $mine 'node_modules' 'npm' 'bin') -Force
    $null = New-Item -ItemType SymbolicLink -Path (Join-Path $mine 'node.exe') -Target $NodeExe
    [System.IO.File]::WriteAllText((Join-Parts $mine 'node_modules' 'npm' 'bin' 'npm-cli.js'), '')
    Check (Test-NodeUsable (Get-NodeInfo (Join-Path $mine 'node.exe'))) 'the Node on PATH would be usable'
    Remove-Dir $script:P.Node
    $pathBefore = $env:PATH
    $env:PATH = $mine + [System.IO.Path]::PathSeparator + $env:PATH
    try { $n = Get-Node } finally { $env:PATH = $pathBefore }
    Check ($n.Version -eq "v$($script:NodeMajor).1.2" -and $n.Dir -eq $script:P.Node) 'a Node 24 on PATH is not used: n8n gets its own Node'
    Check ((Get-Content -Raw $script:LogFile) -match 'the node\.exe on PATH \(.*my-node.*\) is not used and not changed') 'the log says the Node on PATH is left alone'
    # a damaged zip in the downloads folder is downloaded again; a damaged download is refused
    [System.IO.File]::WriteAllText((Join-Path $script:P.Downloads $zipName), 'broken')
    $n = Install-PrivateNode
    Check ($n.Version -eq "v$($script:NodeMajor).1.2") 'a damaged cached zip is downloaded again'
    [System.IO.File]::WriteAllText((Join-Path $dist 'SHASUMS256.txt'), ("{0}  {1}`n" -f ('1' * 64), $zipName))
    Check ((Throws { Install-PrivateNode } 'RETRY: ') -match 'SHA-256 does not match') 'a download with the wrong SHA-256 -> retry'
    Check (-not (Test-Path (Join-Path $script:P.Downloads $zipName))) 'the wrong download is deleted'
    [System.IO.File]::WriteAllText((Join-Path $dist 'SHASUMS256.txt'), ("{0}  node-v{1}.1.2.tar.gz`n" -f $hash, $script:NodeMajor))
    Check ((Throws { Install-PrivateNode } 'STOP: ') -match 'no Windows x64 zip') 'no win-x64 zip listed -> stop'
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}

Remove-Item -Recurse -Force $work
if ($failures) { Write-Host "`n$failures failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed"
