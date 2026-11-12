# Puts a Coolify API token into the GitHub secret COOLIFY_TOKEN of this repository and starts the deploy.
#
# The deploy workflow (.github/workflows/deploy.yml) needs a token with the "deploy" and "read" permissions.
# Create it at https://coolify.skale.club/security/api-tokens with "Expires: never", copy it, run this script
# and paste it when asked (it does not show on screen and is never printed or saved to disk).
#
# Run from the repository root:  & .\scripts\sync-coolify-secret.ps1

$ErrorActionPreference = 'Stop'
$repo    = 'Skale-Club/xpeed'
$appUuid = 'zcofe6duhppnyg7a7l7gadxe'
$base    = 'https://coolify.skale.club'

function Test-Token([string]$token) {
    if ($token.Length -lt 20) { return 'too short' }
    try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri "$base/api/v1/applications/$appUuid" -Headers @{ Authorization = "Bearer $token" } | Out-Null
        return 'ok'
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 401 -or $code -eq 403) { return "refused by Coolify ($code)" }
        throw "Could not reach Coolify ($base): $($_.Exception.Message)"
    }
}

while ($true) {
    $secure = Read-Host 'Paste the Coolify token (it does not show) and press Enter' -AsSecureString
    $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
    $state = Test-Token $token
    if ($state -eq 'ok') { break }
    Write-Host "That token is $state. Try again (Ctrl+C to stop)." -ForegroundColor Red
}
Write-Host 'Coolify accepts the token.' -ForegroundColor Green

$token | gh secret set COOLIFY_TOKEN -R $repo
if ($LASTEXITCODE -ne 0) { throw 'gh secret set failed.' }
Write-Host "GitHub secret COOLIFY_TOKEN updated on $repo." -ForegroundColor Green

gh workflow run deploy.yml -R $repo --ref main
if ($LASTEXITCODE -ne 0) { throw 'Could not start the deploy workflow.' }
Write-Host 'Deploy started. You can close this tab; Claude follows it from here.' -ForegroundColor Green
