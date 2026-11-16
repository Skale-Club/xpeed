# Publishes Xpeed Companion. CI runs it (the `release` job of .github/workflows/xpeed-sim.yml) on a push to main, after the
# tests and the installer build passed. Docs: docs/platform/RELEASES.md.
#
#   pwsh scripts/release-companion.ps1 -Installer xpeed-sim/dist/xpeed-companion-setup-0.5.0.exe -Signed false
#   pwsh scripts/release-companion.ps1 -Installer <file> -DryRun     # writes the files, prints every gh command, publishes nothing
#
# Safety controls (they live in the rolling release's latest.json only; the immutable companion-v<version> releases are never touched):
#   -Rollout <0-100>      Percentage of computers that install this version BY THEMSELVES (each computer has a stable bucket from
#                         its device key; "Update now" in the program ignores it, and so does a forced update: a version below
#                         minVersion, or one on the blocked list). Default 100. 0 pauses a release.
#   -Blocked 0.8.2,0.8.3  Versions that must not stay installed. A computer running one installs the manifest's version even when
#                         it is OLDER (the only downgrade the program accepts), with the same size, SHA-256 and HTTPS checks.
#   -RollbackTo <version> Kill switch: makes the rolling release hold the already released companion-v<version> instead of the
#                         newest one, with -Blocked naming what to get rid of. No installer needed:
#                           pwsh scripts/release-companion.ps1 -RollbackTo 0.8.1 -Blocked 0.8.2
#   -PolicyOnly           Changes only -Rollout / -Blocked of what the rolling release holds now (for example to widen a rollout
#                         from 10 to 50 to 100), with no installer:  pwsh scripts/release-companion.ps1 -PolicyOnly -Rollout 50
# A re-run of the same version without -Rollout / -Blocked keeps what the rolling release already says (it never resets a
# staged rollout or forgets a blocked version).
#
# What it does:
#   1. Writes SHA256SUMS.txt and latest.json next to a copy of the installer (folder -OutDir).
#   2. Creates the immutable release companion-v<version> if it does not exist. If it exists, it is never changed: when it holds a
#      different build, a notice says the version was not bumped, and ITS files are what the rolling release gets below.
#   3. Updates the rolling release companion-latest (marked as the latest release) only when its version is newer than what the
#      rolling release holds: new files first, latest.json last, then stale files removed, then the notes.
# Uses the gh CLI with GH_TOKEN (the workflow's GITHUB_TOKEN). Nothing else is needed.
param(
    [string]$Installer = '',
    [string]$OutDir = 'release-out',
    # 'true' when CI signed the program and the installer; anything else is an unsigned build.
    [string]$Signed = 'false',
    # The oldest version that may keep running. Raise it only for an update that must not be skipped.
    [string]$MinVersion = '0.4.0',
    # 0-100: the share of computers that install by themselves. Default 100.
    [int]$Rollout = 100,
    # Versions to get rid of, comma separated (see the header).
    [string]$Blocked = '',
    # Republish an older, already released version as the rolling one (the kill switch).
    [string]$RollbackTo = '',
    # Change only the rollout / blocked list of the rolling release.
    [switch]$PolicyOnly,
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

# ---- The safety controls, checked before anything is read or written
if ($Rollout -lt 0 -or $Rollout -gt 100) { throw "-Rollout must be a whole number from 0 to 100, got $Rollout" }
$rolloutGiven = $PSBoundParameters.ContainsKey('Rollout')
$blockedGiven = $PSBoundParameters.ContainsKey('Blocked')
$blockedList = @($Blocked -split '[,\s]+' | Where-Object { $_ } | Select-Object -Unique)
foreach ($entry in $blockedList) { if ($entry -notmatch '^\d{1,4}\.\d{1,5}\.\d{1,6}$') { throw "-Blocked: '$entry' is not a version like 1.2.3" } }
if ($blockedList.Count -gt 50) { throw '-Blocked: at most 50 versions' }
if ($RollbackTo -and $RollbackTo -notmatch '^\d{1,4}\.\d{1,5}\.\d{1,6}$') { throw "-RollbackTo: '$RollbackTo' is not a version like 1.2.3" }
$republish = ($RollbackTo -ne '') -or $PolicyOnly.IsPresent
if (-not $republish -and -not $Installer) { throw 'Give -Installer <file>, or -RollbackTo <version>, or -PolicyOnly.' }

# The manifest the rolling release gets: the released one plus the safety controls. -Rollout / -Blocked when given; otherwise what
# the rolling release says now when it is the same version (a re-run never resets a staged rollout), otherwise 100 and none.
function New-RollingManifest($Released, $Current) {
    $sameVersion = ($null -ne $Current) -and ($Current.version -eq $Released.version)
    $rollout = $Rollout
    $blocked = $blockedList
    if ($sameVersion -and -not $rolloutGiven -and $null -ne $Current.rollout) { $rollout = [int]$Current.rollout }
    if ($sameVersion -and -not $blockedGiven -and $null -ne $Current.blocked) { $blocked = @($Current.blocked) }
    if ($blocked -contains $Released.version) { throw "The blocked list names $($Released.version), the version being published." }
    $min = [string]$Released.minVersion
    $parsedMin = Parse-Version $min
    $parsedVersion = Parse-Version $Released.version
    if ($null -ne $parsedMin -and $null -ne $parsedVersion -and $parsedMin -gt $parsedVersion) { $min = [string]$Released.version }   # a rollback below minVersion
    return [ordered]@{
        version = $Released.version; build = $Released.build; file = $Released.file; sha256 = $Released.sha256; size = [int64]$Released.size
        releasedAt = $Released.releasedAt; minVersion = $min; notes = [string]$Released.notes; signed = ($Released.signed -eq $true)
        rollout = $rollout; blocked = @($blocked)
    }
}

# Uploads a release's files to the rolling release: the installer and the sums first, latest.json last (the file it names is always
# there), then stale assets go and the notes change. Creates the rolling release when it does not exist.
function Publish-Rolling([string]$Dir, $Manifest, [string]$NotesFile, [bool]$Exists, [string]$Sha) {
    $dirOut = Join-Path $OutDir 'rolling'
    New-Item -ItemType Directory -Force -Path $dirOut | Out-Null
    $rollingJson = Join-Path $dirOut 'latest.json'
    Write-Text $rollingJson ((($Manifest | ConvertTo-Json) -replace "`r`n", "`n") + "`n")
    $installerFile = Join-Path $Dir $Manifest.file
    $sums = Join-Path $Dir 'SHA256SUMS.txt'
    $title = 'Xpeed Companion (latest)'
    if (-not $Exists) {
        Write-Gh @('release', 'create', $rolling, $installerFile, $sums, $rollingJson, '--title', $title, '--notes-file', $NotesFile, '--target', $Sha, '--latest')
    } else {
        Write-Gh @('release', 'upload', $rolling, $installerFile, '--clobber')
        Write-Gh @('release', 'upload', $rolling, $sums, '--clobber')
        Write-Gh @('release', 'upload', $rolling, $rollingJson, '--clobber')
        $keep = @($Manifest.file, 'SHA256SUMS.txt', 'latest.json')
        $assets = Read-Gh @('release', 'view', $rolling, '--json', 'assets', '--jq', '.assets[].name')
        foreach ($name in ($assets.Out -split "`r?`n" | Where-Object { $_ })) {
            if ($keep -notcontains $name) { Write-Host "Removing stale asset $name"; Write-Gh @('release', 'delete-asset', $rolling, $name, '--yes') }
        }
        Write-Gh @('release', 'edit', $rolling, '--title', $title, '--notes-file', $NotesFile, '--latest', '--prerelease=false')
    }
}

# ---- 0. The kill switch and the policy-only change: no new build, the files of an already released version
if ($republish) {
    $rollingView = Read-Gh @('release', 'view', $rolling, '--json', 'tagName')
    $current = $null
    if ($rollingView.Ok) {
        $probe = Join-Path $OutDir 'rolling-current'
        New-Item -ItemType Directory -Force -Path $probe | Out-Null
        if ((Read-Gh @('release', 'download', $rolling, '--pattern', 'latest.json', '--dir', $probe, '--clobber')).Ok) { $current = Read-Manifest (Join-Path $probe 'latest.json') }
    }
    if ($DryRun) {
        Write-Host "[dry-run] would republish $(if ($RollbackTo) { "companion-v$RollbackTo" } else { 'the version the rolling release holds' }) as $rolling with rollout $Rollout and blocked [$($blockedList -join ', ')]"
        exit 0
    }
    $target = if ($RollbackTo) { $RollbackTo } elseif ($null -ne $current) { [string]$current.version } else { '' }
    if (-not $target) { throw 'The rolling release holds no readable latest.json and no -RollbackTo was given.' }
    $tag = "companion-v$target"
    $canonical = Join-Path $OutDir 'canonical'
    New-Item -ItemType Directory -Force -Path $canonical | Out-Null
    Write-Gh @('release', 'download', $tag, '--dir', $canonical, '--clobber')
    $released = Read-Manifest (Join-Path $canonical 'latest.json')
    if ($null -eq $released -or $released.version -ne $target) { throw "$tag does not hold a readable latest.json for version $target." }
    $rollingManifest = New-RollingManifest $released $current
    $sha = (& git -C $repoRoot rev-parse HEAD).Trim()
    $what = if ($RollbackTo) { "Rolled back to $target." } else { 'Rollout / blocked list changed.' }
    $blockedText = if ($rollingManifest.blocked.Count) { $rollingManifest.blocked -join ', ' } else { 'none' }
    $notesFile = Join-Path $OutDir 'notes.md'
    Write-Text $notesFile ((@("Xpeed Companion $target (build $($released.build)). $what", '', "SHA-256: $($released.sha256)", "Rollout: $($rollingManifest.rollout)%. Blocked: $blockedText.") -join "`n") + "`n")
    Publish-Rolling $canonical $rollingManifest $notesFile $rollingView.Ok $sha
    Write-Host "Done: $rolling now holds $($rollingManifest.file) (rollout $($rollingManifest.rollout), blocked: $blockedText)."
    exit 0
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
    minVersion = $MinVersion; notes = ''; signed = $isSigned; rollout = $Rollout; blocked = @($blockedList)
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

$rollingManifest = New-RollingManifest $setManifest $current
Publish-Rolling $set $rollingManifest $notesFile $rollingView.Ok $sha
Write-Host "Rollout $($rollingManifest.rollout)%, blocked: $(if ($rollingManifest.blocked.Count) { $rollingManifest.blocked -join ', ' } else { 'none' })."
Write-Host "Done: $rolling now holds $($setManifest.file)."
if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "Released Xpeed Companion $($setManifest.version) ($(if ($setManifest.signed -eq $true) { 'signed' } else { 'unsigned' })): https://github.com/$repo/releases/download/$rolling/$($setManifest.file)"
}
