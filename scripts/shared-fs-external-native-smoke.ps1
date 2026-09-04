$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

$TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$Adapter = Join-Path $TempRoot "peerbit-shared-fs-native.exe"
$State = Join-Path $TempRoot "pbfs-state"
$Stdout = Join-Path $TempRoot "pbfs-mount.out.log"
$Stderr = Join-Path $TempRoot "pbfs-mount.err.log"
$ReadableFirstStdout = Join-Path $TempRoot "pbfs-readable-first.out.log"
$ReadableFirstStderr = Join-Path $TempRoot "pbfs-readable-first.err.log"
$ReadableFirstProcess = $null
$ReadableFirstMountRoot = $null

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
$AdapterBuildTags = "native_mount"

function ConvertTo-ImplementationDetailValue {
  param([object]$Value)
  $Text = ([string]$Value) -replace "[\r\n]+", " "
  $Text = $Text.Trim()
  if (-not $Text) {
    return "unknown"
  }
  if ($Text.Length -gt 256) {
    return $Text.Substring(0, 256)
  }
  return $Text
}

function ConvertTo-StartProcessArgument {
  param([string]$Value)
  if ($Value.Contains('"')) {
    throw "Cannot safely pass a quoted value to Start-Process: $Value"
  }
  if ($Value -match "\s") {
    return '"' + $Value + '"'
  }
  return $Value
}

$WinFspBin = @("C:\Program Files\WinFsp\bin", "C:\Program Files (x86)\WinFsp\bin") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($WinFspBin) {
  $env:Path = "$WinFspBin;$env:Path"
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $State, $Stdout, $Stderr, $ReadableFirstStdout, $ReadableFirstStderr
New-Item -ItemType Directory -Force -Path $State | Out-Null

function Write-MountLogs {
  Get-Content -ErrorAction SilentlyContinue $Stdout, $Stderr
}

function Write-ReadableFirstLogs {
  Get-Content -ErrorAction SilentlyContinue $ReadableFirstStdout, $ReadableFirstStderr
}

function Stop-MountProcess {
  $Process.Refresh()
  if (-not $Process.HasExited) {
    # The CLI owns a separately spawned Go adapter. Terminate the whole tree so
    # a forced Windows fallback cannot orphan the WinFsp mount.
    & taskkill.exe /PID $($Process.Id) /T /F 2>$null | Out-Null
    Wait-Process -Id $Process.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Test-Path -LiteralPath $MountRoot)) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "WinFsp mount remained attached after process-tree teardown: $MountRoot"
}

function Stop-ReadableFirstProcess {
  if ($null -ne $ReadableFirstProcess) {
    $ReadableFirstProcess.Refresh()
    if (-not $ReadableFirstProcess.HasExited) {
      # Keep ownership of the adapter subprocess on timeout or cancellation.
      & taskkill.exe /PID $($ReadableFirstProcess.Id) /T /F 2>$null | Out-Null
      Wait-Process -Id $ReadableFirstProcess.Id -Timeout 10 -ErrorAction SilentlyContinue
    }
  }
  if (-not $ReadableFirstMountRoot) {
    return
  }
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Test-Path -LiteralPath $ReadableFirstMountRoot)) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Readable-first WinFsp mount remained attached after process-tree teardown: $ReadableFirstMountRoot"
}

Push-Location "packages/shared-fs/native"
try {
  go build -tags $AdapterBuildTags -o $Adapter .
} finally {
  Pop-Location
}

$GoVersion = ConvertTo-ImplementationDetailValue ((& go version 2>$null | Out-String).Trim())
$WinFspVersion = @(
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
) | ForEach-Object {
  Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue
} | Where-Object {
  $_.DisplayName -like "WinFsp*" -and $_.DisplayVersion
} | Select-Object -ExpandProperty DisplayVersion -First 1
if (-not $WinFspVersion -and $WinFspBin) {
  $WinFspDll = Join-Path $WinFspBin "winfsp-x64.dll"
  if (Test-Path -LiteralPath $WinFspDll) {
    $WinFspVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($WinFspDll).ProductVersion
  }
}
$WinFspVersion = ConvertTo-ImplementationDetailValue $WinFspVersion
$MountRuntime = ConvertTo-ImplementationDetailValue "WinFsp $WinFspVersion"

$Address = (node packages/shared-fs/cli/lib/esm/bin.js create --directory $State).Trim()
$Args = @(
  "packages/shared-fs/cli/lib/esm/bin.js",
  "mount",
  $Address,
  $Mountpoint,
  "--directory",
  $State,
  "--native-adapter",
  $Adapter
) | ForEach-Object { ConvertTo-StartProcessArgument $_ }

$Process = Start-Process -FilePath "node" -ArgumentList $Args -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru -WindowStyle Hidden

function Assert-MountReady {
  $Process.Refresh()
  if ($Process.HasExited) {
    throw "mount process exited before filesystem operations with code $($Process.ExitCode)"
  }
  if (-not (Test-Path -LiteralPath $MountRoot)) {
    throw "expected an active WinFsp mount at $MountRoot"
  }
}

$PrimaryFailure = $null
$CleanupFailures = @()
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
  Assert-MountReady

  $ReadableFirstMountDrive = Get-FreeMountDrive
  $ReadableFirstMountpoint = "$ReadableFirstMountDrive`:"
  $ReadableFirstMountRoot = "$ReadableFirstMountDrive`:\"
  $ReadableFirstArgs = @(
    "scripts/shared-fs-readable-first-native-smoke.mjs",
    "--adapter",
    $Adapter,
    "--mountpoint",
    $ReadableFirstMountpoint
  ) | ForEach-Object { ConvertTo-StartProcessArgument $_ }
  $ReadableFirstProcess = Start-Process -FilePath "node" -ArgumentList $ReadableFirstArgs -RedirectStandardOutput $ReadableFirstStdout -RedirectStandardError $ReadableFirstStderr -PassThru -WindowStyle Hidden
  $ReadableFirstCompleted = $false
  for ($i = 0; $i -lt 360; $i++) {
    $ReadableFirstProcess.Refresh()
    if ($ReadableFirstProcess.HasExited) {
      $ReadableFirstCompleted = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ReadableFirstCompleted) {
    throw "readable-first native smoke did not exit within 90 seconds"
  }
  if ($ReadableFirstProcess.ExitCode -ne 0) {
    throw "readable-first native smoke failed with exit code $($ReadableFirstProcess.ExitCode)"
  }
  Write-ReadableFirstLogs
  Stop-ReadableFirstProcess
  Assert-MountReady

  New-Item -ItemType Directory -Force -Path (Join-Path $MountRoot "docs") | Out-Null
  $MetadataPath = Join-Path $MountRoot "docs\hello.txt"
  Set-Content -NoNewline -Path $MetadataPath -Value "hello external native"
  $Value = Get-Content -Raw -Path $MetadataPath
  if ($Value -ne "hello external native") {
    throw "unexpected file contents: $Value"
  }

  # WinFsp maps Node open("w") replacement of an existing file to
  # Open(O_WRONLY), followed by a separate handle-based truncate. Use a shorter
  # replacement so the content assertion also proves that truncation happened.
  $NodeReplacement = "rewrite"
  $NodeRewrite = "const fs = require('node:fs'); const fd = fs.openSync(process.argv[1], 'w'); try { fs.writeFileSync(fd, 'rewrite'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }"
  & node -e $NodeRewrite $MetadataPath
  if ($LASTEXITCODE -ne 0) {
    throw "Node replacement write failed with exit code $LASTEXITCODE"
  }
  $Rewritten = Get-Content -Raw -Path $MetadataPath
  if ($Rewritten -ne $NodeReplacement) {
    throw "unexpected rewritten file contents: $Rewritten"
  }
  $RewrittenLength = (Get-Item -LiteralPath $MetadataPath).Length
  if ($RewrittenLength -ne 7) {
    throw "replacement write did not truncate the file: length is $RewrittenLength"
  }
  $LastWriteBefore = (Get-Item -LiteralPath $MetadataPath).LastWriteTimeUtc
  $TimestampMutationFailed = $false
  try {
    [System.IO.File]::SetLastWriteTimeUtc($MetadataPath, [DateTime]::Parse("2000-01-01T00:00:00Z").ToUniversalTime())
  } catch {
    $TimestampMutationFailed = $true
  }
  if (-not $TimestampMutationFailed) {
    throw "explicit timestamp update unexpectedly succeeded for synthetic Shared FS metadata"
  }
  $LastWriteAfter = (Get-Item -LiteralPath $MetadataPath).LastWriteTimeUtc
  if ($LastWriteAfter -ne $LastWriteBefore) {
    throw "failed timestamp update changed Shared FS metadata from $LastWriteBefore to $LastWriteAfter"
  }

  Rename-Item -Path (Join-Path $MountRoot "docs\hello.txt") -NewName "renamed.txt"
  $Renamed = Get-Content -Raw -Path (Join-Path $MountRoot "docs\renamed.txt")
  if ($Renamed -ne $NodeReplacement) {
    throw "unexpected renamed file contents: $Renamed"
  }
  $RenamedPath = Join-Path $MountRoot "docs\renamed.txt"
  Remove-Item -Force -Path $RenamedPath
  if (Test-Path -LiteralPath $RenamedPath) {
    throw "renamed file still exists after removal"
  }
  $DocsPath = Join-Path $MountRoot "docs"
  Remove-Item -Force -Path $DocsPath
  if (Test-Path -LiteralPath $DocsPath) {
    throw "docs directory still exists after removal"
  }

  # Opt-in, report-only filesystem-path benchmarks. Each owns and removes only
  # a unique child directory below the supplied path.
  if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT -or $env:PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT) {
    if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT -and $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT -eq $env:PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT) {
      throw "mounted and control benchmark outputs must be different files"
    }
    $BenchmarkSamples = if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_SAMPLES) { $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_SAMPLES } else { "30" }
    $BenchmarkWarmups = if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_WARMUPS) { $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_WARMUPS } else { "3" }
    $BenchmarkTimeoutMs = if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_TIMEOUT_MS) { $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_TIMEOUT_MS } else { "600000" }
    $BenchmarkCommonArgs = @(
      "--samples",
      $BenchmarkSamples,
      "--warmups",
      $BenchmarkWarmups,
      "--timeout-ms",
      $BenchmarkTimeoutMs,
      "--implementation-detail",
      "adapter.buildTags=$AdapterBuildTags",
      "--implementation-detail",
      "adapter.goVersion=$GoVersion",
      "--implementation-detail",
      "mount.runtime=$MountRuntime",
      "--implementation-input",
      $Adapter,
      "--implementation-input",
      "packages/shared-fs/cli/lib/esm",
      "--implementation-input",
      "packages/shared-fs/library/lib/esm"
    )
  }

  if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT) {
    Assert-MountReady
    $BenchmarkArgs = @(
      "scripts/shared-fs-native-mount-benchmark.mjs",
      "--mount",
      $MountRoot,
      "--output",
      $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT,
      "--target-kind",
      "shared-fs-mount",
      "--target-label",
      "Shared FS mount (external WinFsp)",
      "--mount-option",
      "-s",
      "--mount-option",
      "-o",
      "--mount-option",
      "uid=-1,gid=-1"
    ) + $BenchmarkCommonArgs
    if ($env:PEERBIT_SHARED_FS_NATIVE_ADAPTER_DEBUG -eq "1") {
      $BenchmarkArgs += @("--mount-option", "-d")
    }
    & node @BenchmarkArgs
    if ($LASTEXITCODE -ne 0) {
      throw "native mounted-path benchmark failed with exit code $LASTEXITCODE"
    }
    Assert-MountReady
  }

  if ($env:PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT) {
    Assert-MountReady
    if (-not (Test-Path -LiteralPath $TempRoot -PathType Container)) {
      throw "local filesystem control root is not a directory: $TempRoot"
    }
    $ControlArgs = @(
      "scripts/shared-fs-native-mount-benchmark.mjs",
      "--mount",
      $TempRoot,
      "--output",
      $env:PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT,
      "--target-kind",
      "local-filesystem-control",
      "--target-label",
      "local filesystem control (Windows)"
    ) + $BenchmarkCommonArgs
    & node @ControlArgs
    if ($LASTEXITCODE -ne 0) {
      throw "local filesystem control benchmark failed with exit code $LASTEXITCODE"
    }
    Assert-MountReady
  }
} catch {
  $PrimaryFailure = $_
} finally {
  try {
    Stop-ReadableFirstProcess
  } catch {
    $CleanupFailures += $_
  }
  try {
    Stop-MountProcess
  } catch {
    $CleanupFailures += $_
  }
  if ($null -ne $PrimaryFailure -or $CleanupFailures.Count -gt 0) {
    Write-ReadableFirstLogs
    Write-MountLogs
  }
}

if ($null -ne $PrimaryFailure) {
  foreach ($CleanupFailure in $CleanupFailures) {
    Write-Warning "mount cleanup also failed: $($CleanupFailure.Exception.Message)"
  }
  throw $PrimaryFailure
}
if ($CleanupFailures.Count -gt 0) {
  for ($i = 1; $i -lt $CleanupFailures.Count; $i++) {
    Write-Warning "additional mount cleanup failure: $($CleanupFailures[$i].Exception.Message)"
  }
  throw $CleanupFailures[0]
}
