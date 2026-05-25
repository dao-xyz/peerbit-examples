$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

$TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$Adapter = Join-Path $TempRoot "peerbit-shared-fs-native.exe"
$State = Join-Path $TempRoot "pbfs-state"
$Mountpoint = Join-Path $TempRoot "pbfs-mount"
$Stdout = Join-Path $TempRoot "pbfs-mount.out.log"
$Stderr = Join-Path $TempRoot "pbfs-mount.err.log"

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $State, $Mountpoint, $Stdout, $Stderr
New-Item -ItemType Directory -Force -Path $State, $Mountpoint | Out-Null

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
      Get-Content -ErrorAction SilentlyContinue $Stdout, $Stderr
      throw "mount process exited with code $($Process.ExitCode)"
    }
    Start-Sleep -Seconds 1
  }
  if (-not $Mounted) {
    Get-Content -ErrorAction SilentlyContinue $Stdout, $Stderr
    throw "mount did not become ready"
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $Mountpoint "docs") | Out-Null
  Set-Content -NoNewline -Path (Join-Path $Mountpoint "docs\hello.txt") -Value "hello external native"
  $Value = Get-Content -Raw -Path (Join-Path $Mountpoint "docs\hello.txt")
  if ($Value -ne "hello external native") {
    throw "unexpected file contents: $Value"
  }
  Rename-Item -Path (Join-Path $Mountpoint "docs\hello.txt") -NewName "renamed.txt"
  $Renamed = Get-Content -Raw -Path (Join-Path $Mountpoint "docs\renamed.txt")
  if ($Renamed -ne "hello external native") {
    throw "unexpected renamed file contents: $Renamed"
  }
  Remove-Item -Force -Path (Join-Path $Mountpoint "docs\renamed.txt")
} finally {
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
}
