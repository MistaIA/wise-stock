# Tests for windows/start-n8n.ps1: the env file rules, then a real start (setup + n8n) with the Node and n8n given,
# and a second start while the first one runs. PowerShell 7 on Linux (Docker) or Windows.
#   pwsh -NoProfile -File tests/windows/start-n8n.tests.ps1 -NodeExe <node> -N8nJs <node_modules/n8n/bin/n8n>
# On Linux the repo builds an image with both (see tests/windows/README.md).
param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$N8nJs
)
$ErrorActionPreference = 'Stop'
$failures = 0
function Check([bool]$Condition, [string]$Name) {
    if ($Condition) { Write-Host "ok    $Name" } else { Write-Host "FAIL  $Name" -ForegroundColor Red; $script:failures++ }
}
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$startScript = [System.IO.Path]::Combine($repo, 'windows', 'start-n8n.ps1')
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('n8n-sm-start-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$root = Join-Path $work 'install'
$null = New-Item -ItemType Directory -Path $root -Force
$envFile = Join-Path $work 'n8n.env'

# ---------------- env file rules ----------------
[System.IO.File]::WriteAllText($envFile, @"
# comment
TELEGRAM_BOT_TOKEN=123:abc
  OPENAI_API_KEY = sk-test
FMP_API_KEY="fmp test"
BRIEF_SECRET='s3cret#1'
export TELEGRAM_CHAT_ID=4242
CHART_IMG_API_KEY=
not a line
9BAD=x
SM_TEST_EQUALS=a=b=c
N8N_PORT=5711
"@)
$env:CHART_IMG_API_KEY = 'was-set'
. $startScript -InstallRoot $root -EnvFile $envFile
$n = Import-EnvFile $envFile
Check ($n -eq 8) "Import-EnvFile counts the 8 valid lines (got $n)"
Check ($env:TELEGRAM_BOT_TOKEN -eq '123:abc' -and $env:OPENAI_API_KEY -eq 'sk-test') 'KEY=VALUE, spaces around = are trimmed'
Check ($env:FMP_API_KEY -eq 'fmp test' -and $env:BRIEF_SECRET -eq 's3cret#1') 'quotes are removed, # inside a value is kept'
Check ($env:TELEGRAM_CHAT_ID -eq '4242') '"export KEY=VALUE" works'
Check (-not $env:CHART_IMG_API_KEY) 'an empty value removes the variable'
Check ($env:SM_TEST_EQUALS -eq 'a=b=c') 'only the first = splits'
Set-Default 'N8N_PORT' '5678'
Check ($env:N8N_PORT -eq '5711') 'Set-Default keeps a value from the env file'
Set-Default 'SM_TEST_DEFAULT' 'x'
Check ($env:SM_TEST_DEFAULT -eq 'x') 'Set-Default fills a missing value'
foreach ($k in 'TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY', 'FMP_API_KEY', 'BRIEF_SECRET', 'TELEGRAM_CHAT_ID', 'SM_TEST_EQUALS', 'N8N_PORT', 'SM_TEST_DEFAULT') { Remove-Item "env:$k" }

# ---------------- missing install ----------------
$pwsh = (Get-Process -Id $PID).Path
$out = & $pwsh -NoProfile -File $startScript -InstallRoot $root -EnvFile $envFile 2>&1 | Out-String
Check ($LASTEXITCODE -eq 2 -and $out -match 'not installed yet') 'without install.json: exit 2 and says to run install-n8n.cmd'

# ---------------- a real start ----------------
$info = [ordered]@{ n8nVersion = '2.46.6'; nodeExe = $NodeExe; nodeDir = (Split-Path -Parent $NodeExe); nodeVersion = 'test'; appDir = (Join-Path $work 'app'); n8nJs = $N8nJs; installedAt = 'test' }
[System.IO.File]::WriteAllText((Join-Path $root 'install.json'), ($info | ConvertTo-Json))
[System.IO.File]::WriteAllText($envFile, "TELEGRAM_BOT_TOKEN=123:abc`nOPENAI_API_KEY=sk-test`nFMP_API_KEY=fmp-test`nBRIEF_SECRET=secret`nTELEGRAM_CHAT_ID=4242`nN8N_PORT=5799`nN8N_DIAGNOSTICS_ENABLED=false`n")
$log = Join-Path $work 'start.log'
$p = Start-Process -FilePath $pwsh -PassThru -RedirectStandardOutput $log -RedirectStandardError ($log + '.err') -ArgumentList @('-NoProfile', '-File', $startScript, '-InstallRoot', $root, '-EnvFile', $envFile)
$up = $false
for ($i = 0; $i -lt 120 -and -not $up; $i++) {
    Start-Sleep -Seconds 2
    try { $up = (Invoke-WebRequest -Uri 'http://127.0.0.1:5799/healthz' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
    if ($p.HasExited) { break }
}
Check $up 'n8n answers /healthz on the port from the env file'
$text = Get-Content -Raw $log
Check ($text -match 'loaded 7 settings') 'the env file is loaded'
Check ($text -match 'imported 6 workflow') 'the setup imported the workflows'
Check ($text -match 'published "SM-01' -and $text -match 'published "SM-04') 'the setup published SM-01 to SM-04 (keys from the env file)'
Check ($text -match 'not published "WF-11.1: Stock Market Analyst": missing key: chart-img API key') 'WF-11.1 waits for its key'
Check (Test-Path ([System.IO.Path]::Combine($root, '.n8n', 'database.sqlite'))) 'n8n keeps its data in <install folder>\.n8n'
Check ($text -match 'starting n8n 2\.46\.6') 'start message'
Check ($text -match 'not on its own copy\. Run windows\\install-n8n\.cmd once more') 'n8n on a Node outside the install folder: the start says to run the install once more'

$own = Join-Path $root 'node'   # as install-n8n.ps1 leaves it: n8n on its own Node in <install folder>\node
$null = New-Item -ItemType Directory -Path $own -Force
$null = New-Item -ItemType SymbolicLink -Path (Join-Path $own 'node.exe') -Target $NodeExe
$info.nodeExe = Join-Path $own 'node.exe'
$info.nodeDir = $own
[System.IO.File]::WriteAllText((Join-Path $root 'install.json'), ($info | ConvertTo-Json))

$out2 = & $pwsh -NoProfile -File $startScript -InstallRoot $root -EnvFile $envFile 2>&1 | Out-String
Check ($LASTEXITCODE -eq 1 -and $out2 -match 'already answers on port 5799') 'a second start while n8n runs: exit 1, no setup run'
Check ($out2 -notmatch 'stock-market setup') 'the second start did not run the setup against the running n8n'
Check ($out2 -notmatch 'not on its own copy') 'n8n on its own Node: no such note'

Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $NodeExe } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
if ($failures) { Write-Host "`n$failures failed" -ForegroundColor Red; Write-Host $text; exit 1 }
Write-Host "`nall passed"
