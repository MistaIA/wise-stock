# Tests for the Windows scripts

Both test files run in PowerShell 7 (`pwsh`), on Windows or in Docker on Linux. The scripts themselves target
Windows PowerShell 5.1 (the one in every Windows 10/11); the tests check their logic, not 5.1 itself.

```sh
# install-n8n.ps1: failure kinds, fake npm, SHA-256 checked Node download from a local server, lock, -Once,
# n8n always on its own Node (a Node 24 on PATH is left alone; an install made on one is redone)
cid=$(docker create n8nio/n8n:2.46.6); docker cp -L $cid:/usr/bin/node /tmp/psnode/node; docker rm $cid
docker run --rm -v "$PWD:/w:ro" -v /tmp/psnode:/n:ro mcr.microsoft.com/powershell:lts-7.4-alpine-3.20 \
  pwsh -NoProfile -File /w/tests/windows/install-n8n.tests.ps1 -NodeExe /n/node

# start-n8n.ps1: env file rules, then a real start (setup + n8n 2.46.6) and a second start while it runs,
# and the note when install.json names a Node outside the install folder
docker build -t stock-market-n8n:test .
printf 'FROM mcr.microsoft.com/powershell:lts-7.4-alpine-3.20\nCOPY --from=stock-market-n8n:test /usr/bin/node /usr/bin/node\nCOPY --from=stock-market-n8n:test /usr/local/lib/node_modules/n8n /usr/local/lib/node_modules/n8n\n' \
  | docker build -t sm-pwsh-n8n:test -
docker run --rm -v "$PWD:/w:ro" sm-pwsh-n8n:test pwsh -NoProfile -File /w/tests/windows/start-n8n.tests.ps1 \
  -NodeExe /usr/bin/node -N8nJs /usr/local/lib/node_modules/n8n/bin/n8n
```

On Windows: `pwsh -File tests\windows\install-n8n.tests.ps1 -NodeExe "C:\Program Files\nodejs\node.exe"`.
