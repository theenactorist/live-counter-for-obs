# Live Counter for OBS: Windows uninstaller (T4).
#
# Run it with OBS closed, any of these ways:
#   irm <install page>/uninstall.ps1 | iex     (in PowerShell)
#   double-click "Uninstall Live Counter.bat" in the release folder
#   powershell -ExecutionPolicy Bypass -File installer\windows\uninstall.ps1
#
# It removes only what install.ps1 added, like installer/mac/uninstall.sh:
#   - every Custom Browser Dock whose address points into the install folder
#     (the "Live Counter" dock), from user.ini;
#   - every script entry, in every scene collection, whose path points into
#     the install folder (a copy loaded by hand from elsewhere stays);
#   - the install folder, %APPDATA%\obs-studio\live-counter\.
# It leaves the WebSocket server on and every Browser Source alone, and says
# so. Before changing a file it saves a copy next to it, as
# <file>.live-counter-backup-<yyyyMMdd-HHmmss>; any failure, or Ctrl+C, puts
# the copies back.
#
# Test-only overrides, as in install.ps1: LC_OBS_CONFIG_DIR, LC_OBS_PROCESS,
# LC_TEST_FAIL_AFTER (collections or dock), LC_TEST_DETAILS.
#
# Windows PowerShell 5.1, no admin rights, plain ASCII, one script block and
# no exit, for the reasons in install.ps1's header.

& {
  Set-StrictMode -Version 2
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $S = @{
    Cfg = ''; InstallDir = ''; Ts = ''
    BackedUp = New-Object System.Collections.ArrayList
  }

  function Say([string]$Text) { Write-Host $Text }

  function Fail([string]$Message) {
    $err = New-Object System.Exception $Message
    $err.Data['LiveCounter'] = $true
    throw $err
  }

  function Get-Setting([string]$Name, [string]$Default) {
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrEmpty($v)) { return $Default }
    return $v
  }

  function Test-FaultPoint([string]$Step) {
    if ((Get-Setting 'LC_TEST_FAIL_AFTER' '') -eq $Step) {
      Fail "Test stop after the $Step step (LC_TEST_FAIL_AFTER). Run this again without it."
    }
  }

  function Test-JsonObject($Value) { return $Value -is [System.Management.Automation.PSCustomObject] }

  function Read-Text([string]$Path) {
    return [IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding $false))
  }

  function Test-Bom([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    return ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  }

  function Write-Text([string]$Path, [string]$Text, [bool]$Bom) {
    $encoding = New-Object System.Text.UTF8Encoding $Bom
    [IO.File]::WriteAllText($Path, $Text, $encoding)
  }

  # A JSON string the way JSON.stringify writes it, for the ExtraBrowserDocks line.
  function ConvertTo-JsonString([string]$Text) {
    $sb = New-Object System.Text.StringBuilder
    $null = $sb.Append('"')
    foreach ($ch in $Text.ToCharArray()) {
      $code = [int]$ch
      if ($ch -eq '"') { $null = $sb.Append('\"') }
      elseif ($ch -eq '\') { $null = $sb.Append('\\') }
      elseif ($code -eq 8) { $null = $sb.Append('\b') }
      elseif ($code -eq 9) { $null = $sb.Append('\t') }
      elseif ($code -eq 10) { $null = $sb.Append('\n') }
      elseif ($code -eq 12) { $null = $sb.Append('\f') }
      elseif ($code -eq 13) { $null = $sb.Append('\r') }
      elseif ($code -lt 32) { $null = $sb.Append(('\u{0:x4}' -f $code)) }
      else { $null = $sb.Append($ch) }
    }
    $null = $sb.Append('"')
    return $sb.ToString()
  }

  function ConvertTo-JsonValue($Value) {
    if ($Value -is [string]) { return (ConvertTo-JsonString $Value) }
    return (ConvertTo-Json -InputObject $Value -Depth 100 -Compress)
  }

  function ConvertTo-DocksText($List) {
    $items = New-Object System.Collections.ArrayList
    foreach ($entry in $List) {
      if (Test-JsonObject $entry) {
        $pairs = New-Object System.Collections.ArrayList
        foreach ($p in $entry.PSObject.Properties) {
          $null = $pairs.Add((ConvertTo-JsonString $p.Name) + ': ' + (ConvertTo-JsonValue $p.Value))
        }
        $null = $items.Add('{' + ($pairs -join ', ') + '}')
      } else {
        $null = $items.Add((ConvertTo-JsonValue $entry))
      }
    }
    return '[' + ($items -join ', ') + ']'
  }

  function Get-Collections {
    $dir = Join-Path $S.Cfg 'basic\scenes'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return @() }
    $files = @(Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.Name.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase) } | Sort-Object Name)
    return $files
  }

  # True when Path is inside the install folder. Windows paths ignore case,
  # and OBS stores script paths with forward slashes.
  function Test-Inside($Path) {
    if ($Path -isnot [string]) { return $false }
    $folder = ($S.InstallDir -replace '\\', '/').TrimEnd('/') + '/'
    return ($Path -replace '\\', '/').StartsWith($folder, [StringComparison]::OrdinalIgnoreCase)
  }

  function Wait-ObsClosed {
    $name = Get-Setting 'LC_OBS_PROCESS' 'obs64'
    while (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) {
      if ([Console]::IsInputRedirected) {
        Fail 'OBS is open. Please quit OBS, then run this again.'
      }
      Say 'Please quit OBS, then press Enter.'
      $null = Read-Host
    }
  }

  function Select-Timestamp {
    while ($true) {
      $S.Ts = Get-Date -Format 'yyyyMMdd-HHmmss'
      $taken = $false
      foreach ($dir in @($S.Cfg, (Join-Path $S.Cfg 'basic\scenes'))) {
        if ((Test-Path -LiteralPath $dir -PathType Container) -and @(Get-ChildItem -LiteralPath $dir -Filter "*.live-counter-backup-$($S.Ts)").Count -gt 0) { $taken = $true }
      }
      if (-not $taken) { break }
      Start-Sleep -Seconds 1
    }
  }

  function Save-Backup([string]$Path) {
    try { [IO.File]::Copy($Path, "$Path.live-counter-backup-$($S.Ts)") } catch {
      Fail "Could not save a copy of $Path. Check the free disk space, then run this again."
    }
    $null = $S.BackedUp.Add($Path)
  }

  # Drops script entries inside the install folder.
  function Remove-FromCollection([string]$Path) {
    $j = ConvertFrom-Json -InputObject (Read-Text $Path)
    if (-not (Test-JsonObject $j)) { throw 'not an object' }
    $mp = $j.PSObject.Properties['modules']
    if ($null -eq $mp -or -not (Test-JsonObject $mp.Value)) { return }
    $lp = $mp.Value.PSObject.Properties['scripts-tool']
    if ($null -eq $lp -or $lp.Value -isnot [System.Array]) { return }
    $kept = New-Object System.Collections.ArrayList
    foreach ($e in $lp.Value) {
      $inside = $false
      if (Test-JsonObject $e) {
        $pp = $e.PSObject.Properties['path']
        if ($null -ne $pp) { $inside = Test-Inside $pp.Value }
      }
      if (-not $inside) { $null = $kept.Add($e) }
    }
    if ($kept.Count -eq $lp.Value.Count) { return }
    $lp.Value = $kept.ToArray()
    $after = ConvertTo-Json -InputObject $j -Depth 100
    $null = ConvertFrom-Json -InputObject $after
    Write-Text $Path $after (Test-Bom $Path)
  }

  function Remove-Scripts {
    foreach ($f in (Get-Collections)) {
      Save-Backup $f.FullName
      try { Remove-FromCollection $f.FullName } catch {
        Fail "Could not read the scene collection $($f.Name). Open OBS, choose that collection in the Scene Collection menu so OBS saves it again, quit OBS, then run this again."
      }
    }
    Say 'Removed the hotkey script from every scene collection.'
  }

  # Drops docks whose address is inside the install folder. Edits only the
  # ExtraBrowserDocks line inside [BasicWindow].
  function Remove-FromUserIni([string]$Path) {
    $folderUrl = ([System.Uri]($S.InstallDir.TrimEnd('\') + '\')).AbsoluteUri
    $bom = Test-Bom $Path
    $text = Read-Text $Path
    $nl = "`n"
    if ($text.Contains("`r`n")) { $nl = "`r`n" }
    $lines = New-Object System.Collections.ArrayList
    foreach ($line in [regex]::Split($text, '\r?\n')) { $null = $lines.Add($line) }
    $section = $false; $at = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match '^\s*\[') { $section = ($lines[$i].Trim() -eq '[BasicWindow]') }
      elseif ($section -and $lines[$i].StartsWith('ExtraBrowserDocks=')) { $at = $i; break }
    }
    if ($at -lt 0) { return }
    $value = $lines[$at].Substring('ExtraBrowserDocks='.Length).Trim()
    if ($value -eq '') { return }
    if (-not $value.StartsWith('[')) { throw 'ExtraBrowserDocks is not a list' }
    $parsed = ConvertFrom-Json -InputObject $value
    $all = @($parsed)
    $kept = New-Object System.Collections.ArrayList
    foreach ($o in $all) {
      $ours = $false
      if (Test-JsonObject $o) {
        $up = $o.PSObject.Properties['url']
        if ($null -ne $up -and $up.Value -is [string]) { $ours = $up.Value.StartsWith($folderUrl, [StringComparison]::OrdinalIgnoreCase) }
      }
      if (-not $ours) { $null = $kept.Add($o) }
    }
    if ($kept.Count -eq $all.Count) { return }
    $lines[$at] = 'ExtraBrowserDocks=' + (ConvertTo-DocksText $kept)
    Write-Text $Path ($lines -join $nl) $bom
  }

  function Remove-Dock {
    $path = Join-Path $S.Cfg 'user.ini'
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Save-Backup $path
      try { Remove-FromUserIni $path } catch {
        Fail "Could not read the Custom Browser Docks list in $path. Open OBS, open Docks > Custom Browser Docks, click Apply, quit OBS, then run this again."
      }
    }
    Say 'Removed the Live Counter panel from OBS.'
  }

  function Test-SameFile([string]$A, [string]$B) {
    $x = [IO.File]::ReadAllBytes($A)
    $y = [IO.File]::ReadAllBytes($B)
    if ($x.Length -ne $y.Length) { return $false }
    for ($i = 0; $i -lt $x.Length; $i++) { if ($x[$i] -ne $y[$i]) { return $false } }
    return $true
  }

  function Complete-Uninstall {
    foreach ($f in $S.BackedUp) {
      $b = "$f.live-counter-backup-$($S.Ts)"
      if ((Test-Path -LiteralPath $b) -and (Test-SameFile $f $b)) { Remove-Item -LiteralPath $b -Force }
    }
    if (Test-Path -LiteralPath $S.InstallDir) {
      try { Remove-Item -LiteralPath $S.InstallDir -Recurse -Force } catch {
        Fail "Could not remove $($S.InstallDir). Close any window that shows that folder, then run this again."
      }
    }
    Say 'Removed the Live Counter files.'
  }

  function Undo-Uninstall {
    foreach ($f in $S.BackedUp) {
      $b = "$f.live-counter-backup-$($S.Ts)"
      try { if (Test-Path -LiteralPath $b) { [IO.File]::Copy($b, $f, $true); [IO.File]::Delete($b) } } catch { }
    }
  }

  function Invoke-Uninstall {
    Say 'Live Counter for OBS: uninstaller'
    $done = $false
    $nothing = $false
    $message = 'Stopped before the end.'
    try {
      if ($env:OS -ne 'Windows_NT') { Fail 'This uninstaller is for Windows. On a Mac, use Uninstall Live Counter.command.' }
      $S.Cfg = Get-Setting 'LC_OBS_CONFIG_DIR' (Join-Path $env:APPDATA 'obs-studio')
      $S.InstallDir = Join-Path $S.Cfg 'live-counter'
      if (-not (Test-Path -LiteralPath $S.Cfg -PathType Container)) {
        $nothing = $true
      } else {
        Wait-ObsClosed
        Select-Timestamp
        Say 'Saving copies of the OBS settings it changes, then removing Live Counter...'
        Remove-Scripts
        Test-FaultPoint 'collections'
        Remove-Dock
        Test-FaultPoint 'dock'
        Complete-Uninstall
      }
      $done = $true
    } catch {
      $ex = $_.Exception
      if ($ex.Data['LiveCounter']) {
        $message = $ex.Message
      } elseif ($null -ne $ex.InnerException -and $ex.InnerException.Data['LiveCounter']) {
        $message = $ex.InnerException.Message
      } else {
        $message = 'Something went wrong. Run this again; if it happens again, ask for help and show this window.'
        if ((Get-Setting 'LC_TEST_DETAILS' '') -ne '') {
          $message += ' (' + $ex.Message + ' at line ' + $_.InvocationInfo.ScriptLineNumber + ')'
        }
      }
    } finally {
      if (-not $done) {
        Write-Host ''
        Write-Host $message
        Undo-Uninstall
        Write-Host 'Nothing was changed: your OBS settings are as they were.'
      }
    }
    if ($done -and $nothing) {
      Say 'OBS has no settings folder on this PC, so there is nothing to remove.'
      Say 'Done.'
    } elseif ($done) {
      Say ''
      Say 'The WebSocket server stays on. Turn it off in Tools > WebSocket Server Settings if nothing else uses it.'
      Say 'Delete the Live Counter Overlay source in OBS if you no longer need it.'
      Say 'Done. Open OBS.'
    }
  }

  Invoke-Uninstall
}
