#ps1_sysnative

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072

function Write-Log {
  param([string]$Message)
  $timestamp = (Get-Date).ToString("s")
  $line = "[$timestamp][peerbit-gh-runner] $Message"
  Write-Host $line
  try {
    Add-Content -Path "C:\\peerbit-gh-runner-bootstrap.log" -Value $line
  } catch {
    # best-effort logging
  }
}

$RunnerVersion = "{{RUNNER_VERSION}}"
$RepoUrl = "{{REPO_URL}}"
$RunnerToken = "{{RUNNER_TOKEN}}"
$RunnerName = "{{RUNNER_NAME}}"
$RunnerLabels = "{{RUNNER_LABELS}}"
$RunnerEphemeral = "{{RUNNER_EPHEMERAL}}"
$RunnerReconfigure = "{{RUNNER_RECONFIGURE}}"

$EnableSsh = "{{ENABLE_SSH}}"
$SshAuthorizedKey = "{{SSH_AUTHORIZED_KEY}}"
$SshRemoteAddress = "{{SSH_REMOTE_ADDRESS}}"

$EnableWinrm = "{{ENABLE_WINRM}}"
$WinrmRemoteAddress = "{{WINRM_REMOTE_ADDRESS}}"

$SkipDependencies = "{{SKIP_DEPENDENCIES}}"
$SkipHeavyDependencies = "{{SKIP_HEAVY_DEPENDENCIES}}"

$RunnerRoot = $env:RUNNER_DIR
if ([string]::IsNullOrWhiteSpace($RunnerRoot)) {
  $RunnerRoot = "C:\\actions-runner"
}

function Ensure-OpenSSH {
  if ($EnableSsh -ne "1") {
    Write-Log "SSH disabled; skipping OpenSSH setup."
    return
  }

  if ([string]::IsNullOrWhiteSpace($SshAuthorizedKey) -or $SshAuthorizedKey -like "{{SSH_AUTHORIZED_KEY}}") {
    Write-Log "No SSH authorized key provided; skipping OpenSSH setup."
    return
  }

  try {
    $cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like "OpenSSH.Server*" } | Select-Object -First 1
    if ($cap -and $cap.State -eq "Installed") {
      Write-Log "OpenSSH Server already installed."
    } else {
      Write-Log "Installing OpenSSH Server..."
      Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
    }

    Write-Log "Starting sshd..."
    Set-Service -Name "sshd" -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service -Name "sshd" -ErrorAction SilentlyContinue

    $keysPath = "C:\\ProgramData\\ssh\\administrators_authorized_keys"
    Write-Log "Writing administrators_authorized_keys..."
    New-Item -ItemType File -Force -Path $keysPath | Out-Null
    $existing = $false
    try {
      $existing = Select-String -Path $keysPath -Pattern ([regex]::Escape($SshAuthorizedKey)) -Quiet -ErrorAction SilentlyContinue
    } catch {
      $existing = $false
    }
    if (-not $existing) {
      Add-Content -Path $keysPath -Value $SshAuthorizedKey
    }
    & icacls $keysPath /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null

    $remote = $SshRemoteAddress
    if ([string]::IsNullOrWhiteSpace($remote) -or $remote -like "{{SSH_REMOTE_ADDRESS}}") {
      Write-Log "SSH remote address not set; leaving default firewall rules for port 22 unchanged."
      return
    }

    $ruleName = "peerbit-sshd"
    try {
      Remove-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Out-Null
    } catch {
      # ignore
    }
    Write-Log "Opening firewall port 22 (remote=$remote)..."
    New-NetFirewallRule -Name $ruleName -DisplayName "Peerbit SSHD" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress $remote | Out-Null

    try {
      Disable-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue | Out-Null
    } catch {
      # ignore
    }
  } catch {
    Write-Log "OpenSSH setup failed: $($_.Exception.Message)"
  }
}

function Ensure-WinRM {
  if ($EnableWinrm -ne "1") {
    Write-Log "WinRM disabled; skipping WinRM setup."
    return
  }

  try {
    Write-Log "Enabling WinRM..."
    winrm quickconfig -quiet

    # Allow Basic auth over HTTP for quick bootstrap/debugging. Scope inbound access via firewall.
    Set-Item -Path WSMan:\\localhost\\Service\\AllowUnencrypted -Value $true
    Set-Item -Path WSMan:\\localhost\\Service\\Auth\\Basic -Value $true

    Set-Service -Name WinRM -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service -Name WinRM -ErrorAction SilentlyContinue

    $ruleName = "peerbit-winrm-http"
    try {
      Remove-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Out-Null
    } catch {
      # ignore
    }
    $remote = $WinrmRemoteAddress
    if ([string]::IsNullOrWhiteSpace($remote) -or $remote -like "{{WINRM_REMOTE_ADDRESS}}") {
      Write-Log "WinRM remote address not set; skipping firewall rule for port 5985."
      return
    }
    Write-Log "Opening firewall port 5985 (remote=$remote)..."
    New-NetFirewallRule -Name $ruleName -DisplayName "Peerbit WinRM HTTP" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 5985 -RemoteAddress $remote | Out-Null
  } catch {
    Write-Log "WinRM setup failed: $($_.Exception.Message)"
  }
}

Write-Log "Runner root: $RunnerRoot"
New-Item -ItemType Directory -Force -Path $RunnerRoot | Out-Null
Set-Location $RunnerRoot

function Ensure-Command {
  param([string]$Name)
  return (Get-Command $Name -ErrorAction SilentlyContinue) -ne $null
}

function Resolve-Choco {
  if (Ensure-Command "choco.exe") {
    return "choco.exe"
  }

  $candidate = "C:\\ProgramData\\chocolatey\\bin\\choco.exe"
  if (Test-Path $candidate) {
    return $candidate
  }

  return $null
}

function Ensure-Chocolatey {
  $choco = Resolve-Choco
  if ($null -ne $choco) {
    Write-Log "Chocolatey already installed."
    return
  }

  Write-Log "Installing Chocolatey..."
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
  Invoke-Expression ((New-Object System.Net.WebClient).DownloadString("https://community.chocolatey.org/install.ps1"))
}

function Ensure-Git {
  if (Ensure-Command "git.exe") {
    Write-Log "Git already installed."
    return
  }

  Write-Log "Installing Git..."
  $choco = Resolve-Choco
  if ($null -eq $choco) {
    throw "Chocolatey not available; cannot install Git."
  }
  & $choco install git -y --no-progress
}

function Ensure-VSBuildTools {
  $vcVarsAll = "${env:ProgramFiles(x86)}\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat"
  if (Test-Path $vcVarsAll) {
    Write-Log "Visual Studio Build Tools already installed."
    return
  }

  Write-Log "Installing Visual Studio 2022 Build Tools (C++ workload)..."
  $choco = Resolve-Choco
  if ($null -eq $choco) {
    throw "Chocolatey not available; cannot install Visual Studio Build Tools."
  }
  & $choco install visualstudio2022buildtools -y --no-progress
  & $choco install visualstudio2022-workload-vctools -y --no-progress
}

function Ensure-Rustup {
  if (Ensure-Command "rustup.exe") {
    Write-Log "rustup already installed."
    return
  }

  Write-Log "Installing rustup..."
  $rustupExe = Join-Path $env:TEMP "rustup-init.exe"
  Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustupExe -UseBasicParsing
  Start-Process -FilePath $rustupExe -ArgumentList "-y", "--profile", "minimal", "--default-toolchain", "stable" -Wait -NoNewWindow
  Remove-Item -Force $rustupExe
}

function Ensure-CargoOnMachinePath {
  $cargoBin = Join-Path $env:USERPROFILE ".cargo\\bin"
  if (-not (Test-Path $cargoBin)) {
    return
  }

  $cargoHome = Join-Path $env:USERPROFILE ".cargo"
  $rustupHome = Join-Path $env:USERPROFILE ".rustup"

  $existingCargoHome = [Environment]::GetEnvironmentVariable("CARGO_HOME", "Machine")
  if ([string]::IsNullOrWhiteSpace($existingCargoHome) -and (Test-Path $cargoHome)) {
    [Environment]::SetEnvironmentVariable("CARGO_HOME", $cargoHome, "Machine")
  }

  $existingRustupHome = [Environment]::GetEnvironmentVariable("RUSTUP_HOME", "Machine")
  if ([string]::IsNullOrWhiteSpace($existingRustupHome) -and (Test-Path $rustupHome)) {
    [Environment]::SetEnvironmentVariable("RUSTUP_HOME", $rustupHome, "Machine")
  }

  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  if ($machinePath -like "*$cargoBin*") {
    return
  }
  [Environment]::SetEnvironmentVariable("Path", "$machinePath;$cargoBin", "Machine")
}

function Ensure-RunnerInstalled {
  if (Test-Path (Join-Path $RunnerRoot "config.cmd")) {
    Write-Log "Runner directory already populated."
    return
  }

  $zipPath = Join-Path $RunnerRoot "actions-runner.zip"
  $runnerUrl = "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip"

  Write-Log "Downloading GitHub runner $RunnerVersion..."
  Invoke-WebRequest -Uri $runnerUrl -OutFile $zipPath -UseBasicParsing

  Write-Log "Extracting runner..."
  Expand-Archive -Path $zipPath -DestinationPath $RunnerRoot -Force
  Remove-Item -Force $zipPath
}

function Ensure-RunnerConfigured {
  $runnerMarker = Join-Path $RunnerRoot ".runner"
  if ((Test-Path $runnerMarker) -and $RunnerReconfigure -ne "1") {
    Write-Log "Runner already configured; skipping config."
    return
  }

  if (Test-Path $runnerMarker) {
    Write-Log "Runner already configured; reconfiguring."
    Stop-RunnerTask
    foreach ($file in @(".runner", ".credentials", ".credentials_rsaparams")) {
      $path = Join-Path $RunnerRoot $file
      if (Test-Path $path) {
        Remove-Item -Force -Recurse $path
      }
    }
  }

  Write-Log "Configuring runner: $RunnerName ($RunnerLabels)"
  $configArgs = @(
    "--unattended",
    "--replace",
    "--url", "$RepoUrl",
    "--token", "$RunnerToken",
    "--name", "$RunnerName",
    "--labels", "$RunnerLabels",
    "--work", "_work"
  )
  if ($RunnerEphemeral -eq "1") {
    $configArgs += "--ephemeral"
  }
  & (Join-Path $RunnerRoot "config.cmd") @configArgs
  if ($LASTEXITCODE -ne 0) {
    throw "config.cmd failed ($LASTEXITCODE)"
  }
}

function Ensure-RunnerTask {
  $taskName = "peerbit-github-runner"
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $task -and $RunnerReconfigure -eq "1") {
    Write-Log "Re-registering scheduled task: $taskName"
    try {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    } catch {
      # ignore
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
    $task = $null
  }

  if ($null -eq $task) {
    Write-Log "Registering scheduled task: $taskName"
    $cmd = "cd /d `"$RunnerRoot`" && `"$RunnerRoot\\run.cmd`""
    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $cmd"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -User "SYSTEM" -RunLevel Highest -Force | Out-Null
  } else {
    Write-Log "Scheduled task already exists; skipping."
  }

  Write-Log "Restarting scheduled task..."
  try {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
  } catch {
    # ignore
  }
  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $listener = Get-Process -Name "Runner.Listener" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $listener) {
      Write-Log "Runner listener started."
      return
    }
    Start-Sleep -Seconds 1
  }

  Write-Log "Scheduled task did not start Runner.Listener; starting detached runner process."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$RunnerRoot`" && `"$RunnerRoot\\run.cmd`"" -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $listener = Get-Process -Name "Runner.Listener" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $listener) {
      Write-Log "Runner listener started after detached fallback."
      return
    }
    Start-Sleep -Seconds 1
  }

  throw "Runner.Listener did not start."
}

function Stop-RunnerTask {
  $taskName = "peerbit-github-runner"
  try {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
  } catch {
    # ignore
  }

  try {
    Get-Process -Name "Runner.Listener" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  } catch {
    # ignore
  }
}

Ensure-OpenSSH
Ensure-WinRM

Ensure-RunnerInstalled
Ensure-RunnerConfigured

if ($SkipDependencies -eq "1") {
  Ensure-RunnerTask
  Write-Log "Skipping dependency installs (SKIP_DEPENDENCIES=1)."
  Write-Log "Bootstrap complete."
  exit 0
}

Write-Log "Stopping runner during dependency installs..."
Stop-RunnerTask

Ensure-Chocolatey
Ensure-Git

if ($SkipHeavyDependencies -eq "1") {
  Ensure-RunnerTask
  Write-Log "Skipping Visual Studio/Rust installs (SKIP_HEAVY_DEPENDENCIES=1)."
  Write-Log "Bootstrap complete."
  exit 0
}

Ensure-VSBuildTools
Ensure-Rustup
Ensure-CargoOnMachinePath

Ensure-RunnerTask

Write-Log "Bootstrap complete."
exit 0
