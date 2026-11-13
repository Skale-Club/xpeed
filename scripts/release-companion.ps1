# Publishes Xpeed Companion. CI runs it (the `release` job of .github/workflows/xpeed-sim.yml) on a push to main, after the
# tests and the installer build passed. Docs: docs/platform/RELEASES.md.
#
#   pwsh scripts/release-companion.ps1 -Installer xpeed-sim/dist/xpeed-companion-setup-0.5.0.exe -Signed false
#   pwsh scripts/release-companion.ps1 -Installer <file> -DryRun     # writes the files, prints every gh command, publishes nothing
#
# What it does:
#   1. Writes SHA256SUMS.txt and latest.json next to a copy of the installer (folder -OutDir).
#   2. Creates the immutable release companion-v<version> if it does not exist. If it exists, it is never changed: when it holds a
#      different build, a notice says the version was not bumped, and ITS files are what the rolling release gets below.
#   3. Updates the rolling release companion-latest (marked as the latest release) only when its version is newer than what the
#      rolling release holds: new files first, latest.json last, then stale files removed, then the notes.
# Uses the gh CLI with GH_TOKEN (the workflow's GITHUB_TOKEN). Nothing else is needed.
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [string]$OutDir = 'release-out',
    # 'true' when CI signed the program and the installer; anything else is an unsigned build.
    [string]$Signed = 'false',
    # The oldest version that may keep running. Raise it only for an update that must not be skipped.
    [string]$MinVersion = '0.4.0',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$repo = if ($env:GITHUB_REPOSITORY) { $env:GITHUB_REPOSITORY } else { 'Skale-Club/xpeed' }
$isSigned = ($Signed -eq 'true')
$rolling = 'companion-latest'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Text([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, $utf8) }
function Notice([string]$Text) { Write-Host "::notice::$Text" }

# A read: never throws, says whether it worked. In a dry run nothing is read, so every release looks absent.
function Read-Gh([string[]]$GhArgs) {
    if ($DryRun) { Write-Host "[dry-run] would read: gh $($GhArgs -join ' ')"; return @{ Ok = $false; Out = '' } }
    $out = & gh @GhArgs 2>$null
    return @{ Ok = ($LASTEXITCODE -eq 0); Out = (($out | Out-String).Trim()) }
}
# A write: printed instead of run in a dry run; throws when gh fails.
function Write-Gh([string[]]$GhArgs) {
    if ($DryRun) { Write-Host "[dry-run] gh $($GhArgs -join ' ')"; return }
    & gh @GhArgs
    if ($LASTEXITCODE -ne 0) { throw "gh $($GhArgs[0..1] -join ' ') failed (exit $LASTEXITCODE)" }
}
function Read-Manifest([string]$Path) {
    try { return (Get-Content -Raw -Path $Path | ConvertFrom-Json) } catch { return $null }
}
function Parse-Version([string]$Text) {
    try { return [Version]$Text } catch { return $null }
}

# ---- 1. The files of this build
$cargoToml = Join-Path $repoRoot 'xpeed-sim/Cargo.toml'
$version = (Select-String -Path $cargoToml -Pattern '^version\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
$sha = (& git -C $repoRoot rev-parse HEAD).Trim()
$build = (& git -C $repoRoot rev-parse --short=7 HEAD).Trim()
$file = Split-Path $Installer -Leaf
if ($file -ne "xpeed-companion-setup-$version.exe") { throw "Expected the installer xpeed-companion-setup-$version.exe (the version in Cargo.toml), got $file" }
if (-not (Test-Path $Installer)) { throw "Installer not found: $Installer" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$built = Join-Path $OutDir 'built'
New-Item -ItemType Directory -Force -Path $built | Out-Null
Copy-Item -Force $Installer (Join-Path $built $file)
$hash = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $built $file)).Hash.ToLowerInvariant()
$size = (Get-Item (Join-Path $built $file)).Length
$releasedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)

# sha256sum format (hash, two spaces, name), so `sha256sum -c SHA256SUMS.txt` works.
Write-Text (Join-Path $built 'SHA256SUMS.txt') "$hash  $file`n"
$manifest = [ordered]@{
    version = $version; build = $build; file = $file; sha256 = $hash; size = [int64]$size; releasedAt = $releasedAt
    minVersion = $MinVersion; notes = ''; signed = $isSigned
}
Write-Text (Join-Path $built 'latest.json') ((($manifest | ConvertTo-Json) -replace "`r`n", "`n") + "`n")
Write-Host "Xpeed Companion $version (build $build), sha256 $hash, $size bytes, $(if ($isSigned) { 'signed' } else { 'unsigned' })"

# ---- 2. The immutable release companion-v<version>
$tag = "companion-v$version"
$set = $built       # the files the rolling release will get
$setManifest = $manifest
$existing = Read-Gh @('release', 'view', $tag, '--json', 'tagName')
if ($existing.Ok) {
    # A released version is never touched. Its own files are the canonical ones for that version.
    $canonical = Join-Path $OutDir 'canonical'
    New-Item -ItemType Directory -Force -Path $canonical | Out-Null
    Write-Gh @('release', 'download', $tag, '--dir', $canonical, '--clobber')
    $old = Read-Manifest (Join-Path $canonical 'latest.json')
    if ($null -eq $old) { throw "$tag exists but its latest.json cannot be read. Bump the version in xpeed-sim/Cargo.toml." }
    if ($old.build -ne $build) {
        Notice "The version was not bumped: $version was already released (build $($old.build)), so this build ($build) was not published. Bump 'version' in xpeed-sim/Cargo.toml to release it."
    } else {
        Write-Host "$tag already holds this build; nothing to create."
    }
    $set = $canonical
    $setManifest = $old
} else {
    Write-Gh @('release', 'create', $tag, (Join-Path $built $file), (Join-Path $built 'SHA256SUMS.txt'), (Join-Path $built 'latest.json'),
        '--title', "Xpeed Companion v$version", '--notes', "Xpeed Companion $version (build $build). $(if ($isSigned) { 'Signed build.' } else { 'Unsigned build.' }) SHA-256: $hash", '--target', $sha, '--latest=false')
}

# ---- 3. The rolling release companion-latest, only when this version is newer
$setVersion = Parse-Version $setManifest.version
$current = $null
$rollingView = Read-Gh @('release', 'view', $rolling, '--json', 'tagName')
if ($rollingView.Ok) {
    $probe = Join-Path $OutDir 'rolling-current'
    New-Item -ItemType Directory -Force -Path $probe | Out-Null
    $read = Read-Gh @('release', 'download', $rolling, '--pattern', 'latest.json', '--dir', $probe, '--clobber')
    if ($read.Ok) { $current = Read-Manifest (Join-Path $probe 'latest.json') }
}
$update = $true
if ($null -ne $current) {
    $currentVersion = Parse-Version $current.version
    if ($null -ne $currentVersion -and $null -ne $setVersion) {
        if ($setVersion -gt $currentVersion) { $update = $true }
        elseif ($setVersion -eq $currentVersion -and $current.sha256 -eq $setManifest.sha256) { $update = $true }   # a re-run: finish what was left undone
        else {
            $update = $false
            Notice "The rolling release ($rolling) already has version $($current.version); version $($setManifest.version) is not newer, so it was left alone."
        }
    }
}
if (-not $update) { Write-Host 'Rolling release not changed.'; exit 0 }

# The notes: signed or not, the checksum, and the commit subjects since the previous version tag.
$prevTag = $null
$tags = @(& git -C $repoRoot tag --list 'companion-v*')
$best = $null
foreach ($candidate in $tags) {
    $v = Parse-Version ($candidate -replace '^companion-v', '')
    if ($null -ne $v -and $v -lt $setVersion -and ($null -eq $best -or $v -gt $best)) { $best = $v; $prevTag = $candidate }
}
$tip = $setManifest.build
$logArgs = @('log', '--no-merges', '--format=- %s (%h)')
if ($prevTag) { $logArgs += "$prevTag..$tip" } else { $logArgs += @('-n', '15', $tip) }
# The program is called Xpeed Companion; the old internal name must not show in public notes: the usual spellings are
# renamed, and a subject that still has it (a path, a rename note) is left out.
$subjects = @(& git -C $repoRoot @logArgs -- xpeed-sim 2>$null |
    ForEach-Object { $_ -replace 'Xpeed Sim\b', 'Xpeed Companion' -replace '\(sim\)', '(companion)' } |
    Where-Object { $_ -notmatch '(?i)\bsim\b' })
if ($subjects.Count -gt 40) { $subjects = @($subjects[0..39]) + @("- ...and $($subjects.Count - 40) more") }
$state = if ($setManifest.signed -eq $true) { 'Signed build.' } else { 'Unsigned build: Windows SmartScreen may warn about an unknown publisher (More info, then Run anyway). Check the file against SHA256SUMS.txt.' }
$lines = @(
    "Xpeed Companion $($setManifest.version) (build $($setManifest.build)).",
    $state,
    '',
    "SHA-256: $($setManifest.sha256)",
    "Download: https://github.com/$repo/releases/download/$rolling/$($setManifest.file)",
    ''
)
$lines += if ($prevTag) { "Changes since ${prevTag}:" } else { 'Recent changes:' }
$lines += if ($subjects.Count) { $subjects } else { '- (no commits to list)' }
$notesFile = Join-Path $OutDir 'notes.md'
Write-Text $notesFile (($lines -join "`n") + "`n")

$installerFile = Join-Path $set $setManifest.file
$sums = Join-Path $set 'SHA256SUMS.txt'
$latestJson = Join-Path $set 'latest.json'
$title = 'Xpeed Companion (latest)'
if (-not $rollingView.Ok) {
    Write-Gh @('release', 'create', $rolling, $installerFile, $sums, $latestJson, '--title', $title, '--notes-file', $notesFile, '--target', $sha, '--latest')
} else {
    # Files first, latest.json last: the file it names is always there. Then the old files go, then the notes change.
    Write-Gh @('release', 'upload', $rolling, $installerFile, '--clobber')
    Write-Gh @('release', 'upload', $rolling, $sums, '--clobber')
    Write-Gh @('release', 'upload', $rolling, $latestJson, '--clobber')
    $keep = @($setManifest.file, 'SHA256SUMS.txt', 'latest.json')
    $assets = Read-Gh @('release', 'view', $rolling, '--json', 'assets', '--jq', '.assets[].name')
    foreach ($name in ($assets.Out -split "`r?`n" | Where-Object { $_ })) {
        if ($keep -notcontains $name) { Write-Host "Removing stale asset $name"; Write-Gh @('release', 'delete-asset', $rolling, $name, '--yes') }
    }
    Write-Gh @('release', 'edit', $rolling, '--title', $title, '--notes-file', $notesFile, '--latest', '--prerelease=false')
}
Write-Host "Done: $rolling now holds $($setManifest.file)."
if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "Released Xpeed Companion $($setManifest.version) ($(if ($setManifest.signed -eq $true) { 'signed' } else { 'unsigned' })): https://github.com/$repo/releases/download/$rolling/$($setManifest.file)"
}
