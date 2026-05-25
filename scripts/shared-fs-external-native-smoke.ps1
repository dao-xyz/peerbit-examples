$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

$TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$Adapter = Join-Path $TempRoot "peerbit-shared-fs-native.exe"
$State = Join-Path $TempRoot "pbfs-state"
$Stdout = Join-Path $TempRoot "pbfs-mount.out.log"
$Stderr = Join-Path $TempRoot "pbfs-mount.err.log"

function Get-FreeMountDrive {
  foreach ($Letter in @("P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z")) {
    $Root = "$Letter`:\"
    if (-not (Test-Path $Root)) {
      return $Letter
    }
  }
  throw "No free drive letter found for WinFsp smoke mount."
}

$MountDrive = Get-FreeMountDrive
$Mountpoint = "$MountDrive`:"
$MountRoot = "$MountDrive`:\"

$WinFspBin = @("C:\Program Files\WinFsp\bin", "C:\Program Files (x86)\WinFsp\bin") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($WinFspBin) {
  $env:Path = "$WinFspBin;$env:Path"
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $State, $Stdout, $Stderr
New-Item -ItemType Directory -Force -Path $State | Out-Null

function Write-MountLogs {
  Get-Content -ErrorAction SilentlyContinue $Stdout, $Stderr
}

function Stop-MountProcess {
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
}

Push-Location "packages/shared-fs/native"
try {
  go build -tags "native_mount" -o $Adapter .
} finally {
  Pop-Location
}

$Address = (node packages/shared-fs/cli/lib/esm/bin.js create --directory $State --no-replicate).Trim()
$Args = @(
  "packages/shared-fs/cli/lib/esm/bin.js",
  "mount",
  $Address,
  $Mountpoint,
  "--directory",
  $State,
  "--no-replicate",
  "--native-adapter",
  $Adapter
)

$Process = Start-Process -FilePath "node" -ArgumentList $Args -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru -WindowStyle Hidden

try {
  $Mounted = $false
  for ($i = 0; $i -lt 90; $i++) {
    if ((Test-Path $Stdout) -and (Select-String -Path $Stdout -Pattern "Mounted " -Quiet)) {
      $Mounted = $true
      break
    }
    if ($Process.HasExited) {
      Write-MountLogs
      throw "mount process exited with code $($Process.ExitCode)"
    }
    Start-Sleep -Seconds 1
  }
  if (-not $Mounted) {
    Write-MountLogs
    throw "mount did not become ready"
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $MountRoot "docs") | Out-Null
  Set-Content -NoNewline -Path (Join-Path $MountRoot "docs\hello.txt") -Value "hello external native"
  $Value = Get-Content -Raw -Path (Join-Path $MountRoot "docs\hello.txt")
  if ($Value -ne "hello external native") {
    throw "unexpected file contents: $Value"
  }
  Rename-Item -Path (Join-Path $MountRoot "docs\hello.txt") -NewName "renamed.txt"
  $Renamed = Get-Content -Raw -Path (Join-Path $MountRoot "docs\renamed.txt")
  if ($Renamed -ne "hello external native") {
    throw "unexpected renamed file contents: $Renamed"
  }
  Remove-Item -Force -Path (Join-Path $MountRoot "docs\renamed.txt")
} catch {
  Stop-MountProcess
  Write-MountLogs
  throw
} finally {
  Stop-MountProcess
}
