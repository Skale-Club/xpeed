# Builds the Xpeed Companion installer: the release program, its icon (the real Xpeed mark, drawn by the program itself),
# then Inno Setup. Output: xpeed-sim\dist\xpeed-sim-setup-<version>.exe
#
#   pwsh xpeed-sim/installer/build.ps1
#
# Needs Rust (MSVC) and Inno Setup 6 (ISCC.exe): on PATH, in INNO_SETUP_DIR, or in a usual folder.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$crate = Split-Path $here -Parent

$version = (Select-String -Path (Join-Path $crate 'Cargo.toml') -Pattern '^version\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
$build = 'unknown'
if (Get-Command git -ErrorAction SilentlyContinue) {
    $hash = (& git -C $crate rev-parse --short HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $hash) {
        $build = "$hash".Trim()
        if (& git -C $crate status --porcelain 2>$null) { $build += '-dirty' }
    }
}
Write-Host "Xpeed Companion $version (build $build)"
$previous = Join-Path $crate "dist\xpeed-sim-setup-$version.exe"
if (Test-Path $previous) {
    Write-Warning "!!! $previous already exists: version $version was already built. Bump 'version' in Cargo.toml (patch for fixes, minor for features) before this installer goes to anyone. !!!"
}

Push-Location $crate
try {
    cargo build --release --locked
    if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
} finally { Pop-Location }

$exe = Join-Path $crate 'target\release\xpeed-sim.exe'
# The program has no console of its own, so wait for it explicitly.
Start-Process -FilePath $exe -ArgumentList 'make-icon', (Join-Path $here 'xpeed-sim.ico') -Wait
if (-not (Test-Path (Join-Path $here 'xpeed-sim.ico'))) { throw 'the icon was not written' }

$candidates = @()
if ($env:INNO_SETUP_DIR) { $candidates += (Join-Path $env:INNO_SETUP_DIR 'ISCC.exe') }
$onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if ($onPath) { $candidates += $onPath.Source }
$candidates += @(
    "$env:USERPROFILE\Tools\InnoSetup\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
)
$iscc = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 (ISCC.exe) was not found' }

& $iscc "/DAppVersion=$version" (Join-Path $here 'xpeed-sim.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed' }
Write-Host "Done: $(Join-Path $crate "dist\xpeed-sim-setup-$version.exe") (version $version, build $build)"
