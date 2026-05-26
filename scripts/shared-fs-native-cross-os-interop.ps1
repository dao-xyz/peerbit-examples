param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("seed", "join")]
  [string] $Role,
  [string] $Machine = "windows",
  [Parameter(Mandatory = $true)]
  [string] $AddressFile,
  [string] $Expected = "",
  [string] $ExpectedAcks = "",
  [string] $MetricsFile = "",
  [int] $TimeoutSeconds = 2100
)

$ErrorActionPreference = "Stop"
$ScriptStatus = 0

function Get-NowMs {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Set-FileText {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    [string] $Value
  )

  $Parent = Split-Path -Parent $Path
  if ($Parent -and -not (Test-Path -LiteralPath $Parent)) {
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Value, $Utf8NoBom)
}

$Metrics = [ordered]@{
  schema = 1
  machine = $Machine
  role = $Role
  status = 0
  startedAtMs = $(Get-NowMs)
  endedAtMs = $null
  durationMs = $null
  phases = [ordered]@{}
  observations = @()
}

function Add-Phase {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [Parameter(Mandatory = $true)]
    [long] $StartMs,
    [Parameter(Mandatory = $true)]
    [long] $EndMs
  )

  $Metrics.phases[$Name] = $EndMs - $StartMs
}

function Write-TimingMetrics {
  if (-not $MetricsFile) {
    return
  }

  $Metrics.status = $ScriptStatus
  $Metrics.endedAtMs = Get-NowMs
  $Metrics.durationMs = $Metrics.endedAtMs - $Metrics.startedAtMs
  $MetricsDirectory = Split-Path -Parent $MetricsFile
  if ($MetricsDirectory) {
    New-Item -ItemType Directory -Force -Path $MetricsDirectory | Out-Null
  }
  $Metrics | ConvertTo-Json -Depth 6 | Set-Content -Path $MetricsFile -Encoding utf8
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

$TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$Adapter = Join-Path $TempRoot "peerbit-shared-fs-native-$Machine.exe"
$State = Join-Path $TempRoot "pbfs-native-interop-$Machine-state"
$Stdout = Join-Path $TempRoot "pbfs-native-interop-$Machine.out.log"
$Stderr = Join-Path $TempRoot "pbfs-native-interop-$Machine.err.log"
$Process = $null

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
$AckFile = "$MountRoot$Machine-ack.txt"
$AckContents = "acked by $Machine via native mount"

$WinFspBin = @("C:\Program Files\WinFsp\bin", "C:\Program Files (x86)\WinFsp\bin") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($WinFspBin) {
  $env:Path = "$WinFspBin;$env:Path"
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $State, $Stdout, $Stderr
New-Item -ItemType Directory -Force -Path $State | Out-Null

function Write-MountLogs {
  Get-Content -ErrorAction SilentlyContinue $Stdout, $Stderr
}

function Get-MountLogsText {
  return ((Get-Content -Raw -ErrorAction SilentlyContinue $Stdout, $Stderr) -join "`n")
}

function Test-RetryableMountResolveFailure {
  $Logs = Get-MountLogsText
  return $Logs -match "Failed to resolve program with address"
}

function Stop-MountProcess {
  $CleanupStartMs = Get-NowMs
  if ($null -ne $Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
  $CleanupEndMs = Get-NowMs
  Add-Phase -Name "cleanup" -StartMs $CleanupStartMs -EndMs $CleanupEndMs
}

$AdapterBuildStartMs = Get-NowMs
Push-Location "packages/shared-fs/native"
try {
  go build -tags "native_mount" -o $Adapter .
} finally {
  Pop-Location
}
$AdapterBuildEndMs = Get-NowMs
Add-Phase -Name "adapterBuild" -StartMs $AdapterBuildStartMs -EndMs $AdapterBuildEndMs

$AddressStartMs = Get-NowMs
if ($Role -eq "seed") {
  $Address = (node packages/shared-fs/cli/lib/esm/bin.js create --directory $State).Trim()
  Set-FileText -Path $AddressFile -Value $Address
} else {
  $Address = (Get-Content -Raw -Path $AddressFile).Trim()
}
$AddressEndMs = Get-NowMs
Add-Phase -Name "address" -StartMs $AddressStartMs -EndMs $AddressEndMs

$MountArgs = @(
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

function Start-MountProcess {
  Remove-Item -Force -ErrorAction SilentlyContinue $Stdout, $Stderr
  return Start-Process -FilePath "node" -ArgumentList $MountArgs -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru -WindowStyle Hidden
}

function Wait-MountReady {
  for ($i = 0; $i -lt 90; $i++) {
    if ((Test-Path $Stdout) -and (Select-String -Path $Stdout -Pattern "Mounted " -Quiet)) {
      return "mounted"
    }
    if ($Process.HasExited) {
      return "exited"
    }
    Start-Sleep -Seconds 1
  }
  return "timeout"
}

$MountStartMs = Get-NowMs
$MountResolveAttempts = if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_RESOLVE_ATTEMPTS) {
  [Math]::Max(1, [int]$env:PEERBIT_SHARED_FS_NATIVE_MOUNT_RESOLVE_ATTEMPTS)
} else {
  6
}

try {
  for ($Attempt = 1; $Attempt -le $MountResolveAttempts; $Attempt++) {
    $Process = Start-MountProcess
    $MountStatus = Wait-MountReady
    if ($MountStatus -eq "mounted") {
      break
    }

    if ($MountStatus -eq "exited" -and (Test-RetryableMountResolveFailure) -and $Attempt -lt $MountResolveAttempts) {
      Write-MountLogs
      Write-Host "Mount could not resolve the shared filesystem address; retrying ($Attempt/$MountResolveAttempts)..."
      Start-Sleep -Seconds 10
      continue
    }

    Write-MountLogs
    if ($MountStatus -eq "exited") {
      throw "mount process exited with code $($Process.ExitCode)"
    }
    throw "mount did not become ready"
  }

  if ($null -eq $Process -or $Process.HasExited) {
    Write-MountLogs
    throw "mount process did not stay running"
  }
  $MountReadyMs = Get-NowMs
  Add-Phase -Name "mountReady" -StartMs $MountStartMs -EndMs $MountReadyMs

  $LocalWriteStartMs = Get-NowMs
  Set-FileText -Path $LocalFile -Value $LocalContents
  $ReadBack = Get-Content -Raw -Path $LocalFile
  if ($ReadBack -ne $LocalContents) {
    throw "unexpected local file contents: $ReadBack"
  }
  $LocalWriteEndMs = Get-NowMs
  Add-Phase -Name "localWriteReadback" -StartMs $LocalWriteStartMs -EndMs $LocalWriteEndMs

  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  function Wait-FileContents {
    param(
      [Parameter(Mandatory = $true)]
      [string] $Kind,
      [Parameter(Mandatory = $true)]
      [string] $Machine,
      [Parameter(Mandatory = $true)]
      [string] $Path,
      [Parameter(Mandatory = $true)]
      [string] $Contents
    )

    $WaitStartMs = Get-NowMs
    while ($true) {
      if ((Test-Path $Path) -and ((Get-Content -Raw -Path $Path) -eq $Contents)) {
        $WaitEndMs = Get-NowMs
        $Metrics.observations += [ordered]@{
          kind = $Kind
          machine = $Machine
          waitMs = $WaitEndMs - $WaitStartMs
        }
        break
      }
      if ((Get-Date) -ge $Deadline) {
        Get-ChildItem -Force -ErrorAction SilentlyContinue $MountRoot
        throw "Timed out waiting for $Path"
      }
      Start-Sleep -Seconds 2
    }
  }

  foreach ($ExpectedMachine in ($Expected -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $ExpectedFile = Join-Path $MountRoot "$ExpectedMachine.txt"
    $ExpectedContents = "hello from $ExpectedMachine via native mount"
    Wait-FileContents -Kind "fileVisible" -Machine $ExpectedMachine -Path $ExpectedFile -Contents $ExpectedContents
  }

  $AckWriteStartMs = Get-NowMs
  Set-FileText -Path $AckFile -Value $AckContents
  $AckReadBack = Get-Content -Raw -Path $AckFile
  if ($AckReadBack -ne $AckContents) {
    throw "unexpected ack file contents: $AckReadBack"
  }
  $AckWriteEndMs = Get-NowMs
  Add-Phase -Name "ackWriteReadback" -StartMs $AckWriteStartMs -EndMs $AckWriteEndMs

  foreach ($ExpectedMachine in ($ExpectedAcks -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $ExpectedFile = Join-Path $MountRoot "$ExpectedMachine-ack.txt"
    $ExpectedContents = "acked by $ExpectedMachine via native mount"
    Wait-FileContents -Kind "ackVisible" -Machine $ExpectedMachine -Path $ExpectedFile -Contents $ExpectedContents
  }

  Write-Host "native mount interop complete for $Machine"
} catch {
  $ScriptStatus = 1
  Write-MountLogs
  throw
} finally {
  Stop-MountProcess
  Write-TimingMetrics
}
