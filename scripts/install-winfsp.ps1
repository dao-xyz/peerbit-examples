# Installs WinFsp from its GitHub release MSI. The calling workflow step pins
# the version, the MSI's URL and the release asset's size and digest; msiexec
# runs only an MSI that matches both. Windows PowerShell 5.1 or later.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][long]$Size,
  # As the GitHub API gives it: sha256:<64 hex digits>.
  [Parameter(Mandatory = $true)][string]$Digest
)

$ErrorActionPreference = "Stop"
# Windows PowerShell redraws its progress bar for every chunk it downloads.
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$MsiName = "winfsp-$Version.msi"
if (-not $Url.EndsWith("/$MsiName")) {
  throw "The WinFsp MSI URL does not end in /$MsiName for version ${Version}: $Url"
}
if ($Digest -notmatch '^sha256:[0-9a-f]{64}$') {
  throw "The WinFsp MSI digest is not sha256: and 64 hex digits, as the GitHub API gives it: $Digest"
}
$Sha256 = $Digest.Substring("sha256:".Length).ToLowerInvariant()

$TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$Msi = Join-Path $TempRoot $MsiName
$Log = Join-Path $TempRoot "winfsp-$Version-install.log"

# Retries the failures that can pass: those without an HTTP response (DNS,
# connect, reset, timeout), 408, 429 and 5xx, after 10, 20, 40 and 80 seconds.
$MaxAttempts = 5
$DelaySeconds = 10
for ($Attempt = 1; $Attempt -le $MaxAttempts; $Attempt++) {
  Remove-Item -LiteralPath $Msi -Force -ErrorAction SilentlyContinue
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Msi -UseBasicParsing
    break
  } catch {
    $Failure = $_.Exception.Message
    $Status = $null
    if ($_.Exception.Response) {
      $Status = [int]$_.Exception.Response.StatusCode
    }
    $Transient = ($null -eq $Status) -or ($Status -ge 500) -or ($Status -eq 408) -or ($Status -eq 429)
    if (-not $Transient) {
      throw "Downloading $Url failed with HTTP $Status, which a retry cannot fix: $Failure"
    }
    if ($Attempt -ge $MaxAttempts) {
      throw "Downloading $Url failed $MaxAttempts times. The last attempt: $Failure"
    }
    Write-Host "Download attempt $Attempt of $MaxAttempts failed: $Failure Retrying in $DelaySeconds seconds."
    Start-Sleep -Seconds $DelaySeconds
    $DelaySeconds *= 2
  }
}

$Length = (Get-Item -LiteralPath $Msi).Length
if ($Length -ne $Size) {
  throw "$MsiName from $Url is $Length bytes, but the workflow pins $Size (the release asset's size in the GitHub API). Not installing it."
}
$Hash = (Get-FileHash -LiteralPath $Msi -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Hash -ne $Sha256) {
  throw "$MsiName from $Url has SHA-256 $Hash, but the workflow pins $Sha256 (the release asset's digest in the GitHub API). Not installing it."
}
Write-Host "Downloaded $MsiName ($Length bytes, sha256:$Hash)."

# The Chocolatey winfsp package's arguments, plus a verbose log.
# INSTALLLEVEL=1000 installs every feature; the adapter, built without cgo,
# needs only Core (the DLL it loads, the driver and the launcher), not
# Developer, Kernel Developer or FUSE for Cygwin.
$MsiArgs = "/i `"$Msi`" /qn /norestart INSTALLLEVEL=1000 /l*v `"$Log`""
$Process = Start-Process -FilePath "msiexec.exe" -ArgumentList $MsiArgs -Wait -PassThru
$ExitCode = $Process.ExitCode
if ($ExitCode -eq 3010) {
  Write-Host "msiexec exited with 3010 (a restart is required); continuing without one."
} elseif ($ExitCode -ne 0) {
  # A verbose log ends with every property's value; leave those lines out.
  Write-Host "The last 80 lines of $Log, without its property values:"
  Get-Content -LiteralPath $Log -ErrorAction SilentlyContinue |
    Where-Object { $_ -notlike "Property(*" } |
    Select-Object -Last 80 |
    ForEach-Object { Write-Host $_ }
  throw "msiexec /i $MsiName failed with exit code $ExitCode. Its log is $Log"
}
Write-Host "Installed WinFsp $Version."
