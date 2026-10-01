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

# Build the adapter the way releases do: cgofuse's pure-Go WinFsp binding. A
# host with a C compiler would otherwise build the cgo binding, which needs
# WinFsp's FUSE headers.
$PreviousCgoEnabled = $env:CGO_ENABLED
$env:CGO_ENABLED = "0"
Push-Location "packages/shared-fs/native"
try {
  go build -tags $AdapterBuildTags -o $Adapter .
  if ($LASTEXITCODE -ne 0) {
    throw "go build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
  $env:CGO_ENABLED = $PreviousCgoEnabled
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

$Address = node packages/shared-fs/cli/lib/esm/bin.js create --directory $State
if ($LASTEXITCODE -ne 0) {
  throw "peerbit-fs create failed with exit code $LASTEXITCODE"
}
$Address = ([string]$Address).Trim()
# Not $Args, which is a PowerShell automatic variable.
$MountArgs = @(
  "packages/shared-fs/cli/lib/esm/bin.js",
  "mount",
  $Address,
  $Mountpoint,
  "--directory",
  $State,
  "--native-adapter",
  $Adapter
)
# Opt-in mount profiling writes NDJSON files into a new directory. The forced
# process-tree teardown below cannot let the CLI or adapter write their final
# summary records, so Windows profiles are reported as incomplete sessions.
if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_PROFILE_DIR) {
  $MountArgs += @("--mount-profile", $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_PROFILE_DIR)
}

$Process = Start-Process -FilePath "node" -ArgumentList $MountArgs -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru -WindowStyle Hidden
# Holding the handle keeps ExitCode readable after the process exits.
$null = $Process.Handle

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
$CleanupFailure = $null
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
  $Y2K = [DateTime]::Parse("2000-01-01T00:00:00Z").ToUniversalTime()
  [System.IO.File]::SetLastWriteTimeUtc($MetadataPath, $Y2K)
  $LastWriteAfter = (Get-Item -LiteralPath $MetadataPath).LastWriteTimeUtc
  if ($LastWriteAfter -ne $Y2K) {
    throw "SetLastWriteTimeUtc stored $LastWriteAfter, expected $Y2K"
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

  # Symlinks and delete-on-close, inside docs so that its removal below also
  # proves nothing was left behind. CreateSymbolicLinkW creates the file and
  # then turns it into a link: WinFsp symlinks a hidden name and renames it
  # over the still-uncommitted new file. Delete-on-close unlinks a file whose
  # create has not committed either.
  $LinkRoot = Join-Path $MountRoot "docs\links"
  $LinkDir = Join-Path $LinkRoot "dir"
  $LinkTarget = Join-Path $LinkRoot "target.txt"
  $LinkInner = Join-Path $LinkDir "inner.txt"
  New-Item -ItemType Directory -Force -Path $LinkDir | Out-Null
  Set-Content -NoNewline -Path $LinkTarget -Value "link target"
  Set-Content -NoNewline -Path $LinkInner -Value "inner"
  $ReadLink = "process.stdout.write(require('node:fs').readlinkSync(process.argv[1]))"
  function Get-LinkTarget([string]$Link) {
    $Target = [string](& node -e $ReadLink $Link)
    if ($LASTEXITCODE -ne 0) {
      throw "readlink $Link failed with exit code $LASTEXITCODE"
    }
    return $Target
  }
  function Assert-FileLink([string]$Link, [string]$Target) {
    $Attributes = [System.IO.File]::GetAttributes($Link)
    if (-not $Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint) -or $Attributes.HasFlag([System.IO.FileAttributes]::Directory)) {
      throw "file link $Link has attributes $Attributes"
    }
    $Stored = Get-LinkTarget $Link
    if ($Stored -ne $Target) {
      throw "file link $Link points to '$Stored', expected '$Target'"
    }
    $Content = [System.IO.File]::ReadAllText($Link)
    if ($Content -ne "link target") {
      throw "reading through file link $Link gave '$Content'"
    }
  }

  $DeleteOnClose = Join-Path $LinkRoot "delete-on-close.tmp"
  $Stream = New-Object System.IO.FileStream($DeleteOnClose, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::DeleteOnClose)
  try {
    $Stream.Write([byte[]](1, 2, 3), 0, 3)
  } finally {
    $Stream.Dispose()
  }
  # The listing after the link checks below looks for it again.
  if (Test-Path -LiteralPath $DeleteOnClose) {
    throw "delete-on-close file still exists after its handle closed: $DeleteOnClose"
  }

  $FileLink = Join-Path $LinkRoot "file-link"
  & cmd.exe /c mklink $FileLink target.txt | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "mklink of a relative file link failed with exit code $LASTEXITCODE"
  }
  Assert-FileLink $FileLink "target.txt"

  # An absolute target on the mount is stored relative to the link.
  $AbsoluteLink = Join-Path $LinkRoot "absolute-link"
  New-Item -ItemType SymbolicLink -Path $AbsoluteLink -Target $LinkTarget | Out-Null
  Assert-FileLink $AbsoluteLink "target.txt"

  $DirLink = Join-Path $LinkRoot "dir-link"
  & cmd.exe /c mklink /D $DirLink dir | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "mklink /D of a relative directory link failed with exit code $LASTEXITCODE"
  }
  $Attributes = [System.IO.File]::GetAttributes($DirLink)
  if (-not $Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint) -or -not $Attributes.HasFlag([System.IO.FileAttributes]::Directory)) {
    throw "directory link $DirLink has attributes $Attributes"
  }
  $Stored = Get-LinkTarget $DirLink
  if ($Stored -ne "dir") {
    throw "directory link $DirLink points to '$Stored', expected 'dir'"
  }
  $Listed = @([System.IO.Directory]::GetFileSystemEntries($DirLink) | ForEach-Object { [System.IO.Path]::GetFileName($_) })
  if (($Listed -join "|") -ne "inner.txt") {
    throw "listing through directory link $DirLink gave '$($Listed -join ", ")'"
  }

  $Names = @(Get-ChildItem -LiteralPath $LinkRoot -Force | ForEach-Object { $_.Name })
  $Hidden = @($Names | Where-Object { $_ -like ".fuse_hidden*" })
  if ($Hidden.Count -gt 0) {
    throw "WinFsp link names were left behind: $($Hidden -join ", ")"
  }
  $ExpectedNames = @("absolute-link", "dir", "dir-link", "file-link", "target.txt")
  if ((@($Names | Sort-Object) -join "|") -ne (@($ExpectedNames | Sort-Object) -join "|")) {
    throw "unexpected entries in ${LinkRoot}: $($Names -join ", ")"
  }

  # Deleting a link leaves its target. A directory link is removed as a
  # directory, which needs its Directory attribute.
  [System.IO.File]::Delete($FileLink)
  [System.IO.File]::Delete($AbsoluteLink)
  [System.IO.Directory]::Delete($DirLink)
  if ((Get-Content -Raw -LiteralPath $LinkInner) -ne "inner") {
    throw "removing directory link $DirLink changed its target"
  }
  [System.IO.File]::Delete($LinkInner)
  [System.IO.Directory]::Delete($LinkDir)
  [System.IO.File]::Delete($LinkTarget)
  [System.IO.Directory]::Delete($LinkRoot)

  $DocsPath = Join-Path $MountRoot "docs"
  Remove-Item -Force -Path $DocsPath
  if (Test-Path -LiteralPath $DocsPath) {
    throw "docs directory still exists after removal"
  }

  # Report-only: WinFsp's FUSE layer supports neither junctions nor hard links
  # (see packages/shared-fs/native/README.md). cmd merges mklink's error into
  # its output, which a failure reports.
  try {
    $ReportRoot = Join-Path $MountRoot "link-report"
    New-Item -ItemType Directory -Force -Path (Join-Path $ReportRoot "dir") | Out-Null
    Set-Content -NoNewline -Path (Join-Path $ReportRoot "target.txt") -Value "link target"
    foreach ($Probe in @(@("junction", "/J", "junction", "dir"), @("hard link", "/H", "hard-link", "target.txt"))) {
      $Output = (& cmd.exe /c "mklink $($Probe[1]) $(Join-Path $ReportRoot $Probe[2]) $(Join-Path $ReportRoot $Probe[3]) 2>&1" | Out-String).Trim()
      $Outcome = if ($LASTEXITCODE -eq 0) { "created" } else { "failed: $Output" }
      Write-Host "link probe ($($Probe[0])): $Outcome"
      if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value "- link probe ($($Probe[0])): $Outcome"
      }
    }
  } catch {
    Write-Host "link probe could not run: $($_.Exception.Message)"
  }
  # A failed probe's mklink exit code must not become the step's, and a mount
  # that died during the probes fails here, with its logs.
  $global:LASTEXITCODE = 0
  Assert-MountReady

  # Opt-in, report-only filesystem-path benchmarks. Each owns and removes only
  # a unique child directory below the supplied path.
  if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT -or $env:PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT) {
    if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT -and $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT -eq $env:PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT) {
      throw "mounted and control benchmark outputs must be different files"
    }
    $BenchmarkSamples = if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_SAMPLES) { $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_SAMPLES } else { "30" }
    $BenchmarkWarmups = if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_WARMUPS) { $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_WARMUPS } else { "3" }
    # Opt-in developer-machine workload (git clone/status, editor save, JSONL
    # appends, SQLite) on both targets. It needs a longer default deadline.
    $DevWorkload = $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD
    if ($DevWorkload -and $DevWorkload -ne "1") {
      throw "PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD must be 1 or unset"
    }
    $BenchmarkTimeoutMs = if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_TIMEOUT_MS) { $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_TIMEOUT_MS } elseif ($DevWorkload -eq "1") { "1800000" } else { "600000" }
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
    if ($env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OVERWRITE_BASE_BYTES) {
      $BenchmarkCommonArgs += @("--overwrite-base-bytes", $env:PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OVERWRITE_BASE_BYTES)
    }
    # Without the variable the benchmark argv is unchanged.
    if ($DevWorkload -eq "1") {
      $BenchmarkCommonArgs += @("--dev-workload")
    }
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
    Stop-MountProcess
  } catch {
    $CleanupFailure = $_
  }
  if ($null -ne $PrimaryFailure -or $null -ne $CleanupFailure) {
    Write-MountLogs
  }
}

if ($null -ne $PrimaryFailure) {
  if ($null -ne $CleanupFailure) {
    Write-Warning "mount cleanup also failed: $($CleanupFailure.Exception.Message)"
  }
  throw $PrimaryFailure
}
if ($null -ne $CleanupFailure) {
  throw $CleanupFailure
}
