# Downloads the Companion panel design preview drawn by CI (workflow "Xpeed Sim", artifact
# companion-panel-preview) into xpeed-sim/target/panel-preview, for machines without Rust.
# Serve it with the "xpeed-sim-panel-preview" entry of .claude/launch.json (python http.server, port 5180);
# the page polls stamp.txt and reloads by itself when a newer download lands.
#
#   powershell -NoProfile -File xpeed-sim/tools/fetch-panel-preview.ps1                 # latest run of the current branch
#   powershell -NoProfile -File xpeed-sim/tools/fetch-panel-preview.ps1 -Branch main
#   powershell -NoProfile -File xpeed-sim/tools/fetch-panel-preview.ps1 -RunId 123 -Wait
param(
    [string]$Branch = (git rev-parse --abbrev-ref HEAD),
    [string]$RunId,
    [switch]$Wait
)
$ErrorActionPreference = 'Stop'
$root = git rev-parse --show-toplevel
$out = Join-Path $root 'xpeed-sim/target/panel-preview'

if (-not $RunId) {
    $RunId = gh run list --workflow xpeed-sim.yml --branch $Branch --limit 1 --json databaseId --jq '.[0].databaseId'
    if (-not $RunId) { throw "No Xpeed Sim run found for branch $Branch." }
}
if ($Wait) { gh run watch $RunId *> $null }

$tmp = Join-Path ([IO.Path]::GetTempPath()) "xpeed-panel-preview-$RunId"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
gh run download $RunId --name companion-panel-preview --dir $tmp
if (-not (Test-Path (Join-Path $tmp 'index.html'))) { throw "Run $RunId has no panel preview page." }

New-Item -ItemType Directory -Force -Path $out | Out-Null
# Pictures first, stamp.txt last: the open page reloads as soon as the stamp changes.
Get-ChildItem $tmp -File | Where-Object Name -ne 'stamp.txt' | Copy-Item -Destination $out -Force
Copy-Item (Join-Path $tmp 'stamp.txt') -Destination $out -Force
Remove-Item -Recurse -Force $tmp
"Panel preview of run $RunId -> $out"
