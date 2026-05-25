param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("seed", "join")]
  [string] $Role,
  [string] $Machine = "windows",
  [Parameter(Mandatory = $true)]
  [string] $AddressFile,
  [string] $Expected = "",
  [int] $TimeoutSeconds = 2100
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

$TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$Adapter = Join-Path $TempRoot "peerbit-shared-fs-native-$Machine.exe"
$State = Join-Path $TempRoot "pbfs-native-interop-$Machine-state"
$Stdout = Join-Path $TempRoot "pbfs-native-interop-$Machine.out.log"
$Stderr = Join-Path $TempRoot "pbfs-native-interop-$Machine.err.log"

function Get-FreeMountDrive {
  foreach ($Letter in @("P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z")) {
    $Root = "$Letter`:\"
    if (-not (Test-Path $Root)) {
      return $Letter
    }
  }
  throw "No free drive letter found for WinFsp native interop mount."
}

$MountDrive = Get-FreeMountDrive
$Mountpoint = "$MountDrive`:"
$MountRoot = "$MountDrive`:\"
$LocalFile = "$MountRoot$Machine.txt"
$LocalContents = "hello from $Machine via native mount"

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
  if ($null -ne $Process -and -not $Process.HasExited) {
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

if ($Role -eq "seed") {
  $Address = (node packages/shared-fs/cli/lib/esm/bin.js create --directory $State).Trim()
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AddressFile) | Out-Null
  Set-Content -NoNewline -Path $AddressFile -Value $Address
} else {
  $Address = (Get-Content -Raw -Path $AddressFile).Trim()
}

$Args = @(
  "packages/shared-fs/cli/lib/esm/bin.js",
  "mount",
  $Address,
  $Mountpoint,
  "--directory",
  $State,
  "--machine",
  $Machine,
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

  Set-Content -NoNewline -Path $LocalFile -Value $LocalContents
  $ReadBack = Get-Content -Raw -Path $LocalFile
  if ($ReadBack -ne $LocalContents) {
    throw "unexpected local file contents: $ReadBack"
  }

  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  foreach ($ExpectedMachine in ($Expected -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $ExpectedFile = Join-Path $MountRoot "$ExpectedMachine.txt"
    $ExpectedContents = "hello from $ExpectedMachine via native mount"
    while ($true) {
      if ((Test-Path $ExpectedFile) -and ((Get-Content -Raw -Path $ExpectedFile) -eq $ExpectedContents)) {
        break
      }
      if ((Get-Date) -ge $Deadline) {
        Get-ChildItem -Force -ErrorAction SilentlyContinue $MountRoot
        throw "Timed out waiting for $ExpectedFile"
      }
      Start-Sleep -Seconds 2
    }
  }

  Write-Host "native mount interop complete for $Machine"
} catch {
  Stop-MountProcess
  Write-MountLogs
  throw
} finally {
  Stop-MountProcess
}
