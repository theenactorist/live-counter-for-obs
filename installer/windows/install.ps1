# Live Counter for OBS: Windows installer (T4).
#
# Run it with OBS closed, any of these ways:
#   irm <install page>/install.ps1 | iex      (in PowerShell)
#   double-click "Install Live Counter.bat" in the unzipped release folder
#   powershell -ExecutionPolicy Bypass -File installer\windows\install.ps1
#
# What it does, in the order proven in docs/installer-spike.md (T1), the same
# steps as installer/mac/install.sh (T3):
#   1. Checks, changing nothing: OBS 31 or later is installed (the uninstall
#      registry entry first, then C:\Program Files\obs-studio), OBS is not in
#      portable mode, OBS was opened once (%APPDATA%\obs-studio\user.ini
#      exists), OBS is not running (asks the operator to quit it, never
#      forces it).
#   2. Copies the Live Counter files into %APPDATA%\obs-studio\live-counter\
#      (built beside it, then swapped in), so the dock, overlay and script
#      paths never change.
#   3. Saves a copy of each OBS file it may change, next to it, as
#      <file>.live-counter-backup-<yyyyMMdd-HHmmss>. Copies of files that end
#      up unchanged are removed again at the end.
#   4. obs-websocket config.json: server on, authentication on, the existing
#      password kept (a 16-character one is made only if there is none).
#   5. live-counter\live-counter-config.js, the dock's connection file (format
#      in src/dock/installer-config.ts), readable by this Windows user only.
#   6. Every scene collection: adds counter-hotkeys.lua, or repoints an
#      existing entry for it and keeps its saved keys, leaving one entry.
#   7. user.ini: adds the "Live Counter" dock, or repoints the existing one
#      and keeps its uuid.
#   8. Reads every changed file back. Any failure, or Ctrl+C, puts every copy
#      back.
#
# The WebSocket password is never printed.
#
# Where the Live Counter files come from, first match wins:
#   LC_ZIP=<path to a release zip>     (tests, and the real-OBS install walk)
#   the release folder this script sits in (installer\windows\ inside it)
#   a download of LC_ZIP_URL, by default the latest GitHub release.
#
# Overrides for tests only; an operator never sets these:
#   LC_OBS_CONFIG_DIR   the OBS settings folder
#   LC_OBS_EXE          the obs64.exe to read the version from
#   LC_OBS_REGISTRY     a registry key to search for the OBS uninstall entry
#                       instead of the real Uninstall keys
#   LC_OBS_PROCESS      the process name that means OBS is running
#   LC_ZIP_URL          the download address
#   LC_TEST_FAIL_AFTER  stop with a failure after a step: files, websocket,
#                       collections or dock
#   LC_TEST_DETAILS     print the error behind an unexpected failure
#
# Windows PowerShell 5.1, no admin rights. Rules that keep it working there:
#   - Plain ASCII only: 5.1 reads a .ps1 without a BOM in the ANSI code page,
#     so menu paths are written "Tools > Scripts".
#   - Everything runs inside one script block, so `irm | iex` leaves nothing
#     in the operator's session and a download cut short does not parse and
#     runs nothing. Nothing calls exit: under iex it would close the
#     operator's PowerShell window. A failure prints its fix and returns.
#   - JSON goes through ConvertTo-Json -Depth 100 (the default depth of 2
#     flattens deeper levels) with -InputObject (a pipeline unrolls one-item
#     arrays); files are read with [IO.File]::ReadAllText and written as
#     UTF-8 through one helper, never Out-File, > or Set-Content.

& {
  Set-StrictMode -Version 2
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $LcTitle = 'Live Counter'
  $LcDefaultZipUrl = 'https://github.com/theenactorist/live-counter-for-obs/releases/latest/download/live-counter-for-obs.zip'
  $LcRequiredFiles = @('dock.html', 'overlay.html', 'counter-hotkeys.lua')
  $LcOptionalFiles = @('setup.html', 'inter-OFL-LICENSE.txt', 'oswald-OFL-LICENSE.txt')
  $LcPortableMarkers = @('portable_mode', 'obs_portable_mode', 'portable_mode.txt', 'obs_portable_mode.txt')
  $LcScript = 'counter-hotkeys.lua'

  # Empty under irm | iex, the script's folder under -File.
  $LcHere = ''
  $scriptRoot = Get-Variable -Name PSScriptRoot -ValueOnly -ErrorAction SilentlyContinue
  if ($scriptRoot) { $LcHere = [string]$scriptRoot }

  # Everything this run changed, so a failure can put it back.
  $S = @{
    Cfg = ''; InstallDir = ''; NewDir = ''; OldDir = ''; Work = ''; Src = ''
    Ts = ''; Revision = ''; Placed = $false; MovedOld = $false
    BackedUp = New-Object System.Collections.ArrayList
    Created = New-Object System.Collections.ArrayList
    CreatedDirs = New-Object System.Collections.ArrayList
  }

  function Say([string]$Text) { Write-Host $Text }

  # Stops the run with a message that names the fix.
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

  # Strict mode refuses a missing property, so optional keys go through these.
  # Get-Prop is for single values: a function's output unrolls an array.
  function Get-Prop($Object, [string]$Name) {
    if ($null -eq $Object -or $Object -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
  }

  function Test-Prop($Object, [string]$Name) {
    return ($Object -is [System.Management.Automation.PSCustomObject]) -and ($null -ne $Object.PSObject.Properties[$Name])
  }

  function Set-Prop($Object, [string]$Name, $Value) {
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) {
      Add-Member -InputObject $Object -MemberType NoteProperty -Name $Name -Value $Value
    } else {
      $p.Value = $Value
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

  # The one place files are written: UTF-8, with a BOM only when asked.
  function Write-Text([string]$Path, [string]$Text, [bool]$Bom) {
    $encoding = New-Object System.Text.UTF8Encoding $Bom
    [IO.File]::WriteAllText($Path, $Text, $encoding)
  }

  function ConvertTo-LcJson($Value) {
    return (ConvertTo-Json -InputObject $Value -Depth 100)
  }

  # A JSON string the way JSON.stringify writes it (ConvertTo-Json would also
  # turn & < > ' into \u escapes, and this line belongs to OBS).
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

  # OBS's own spacing for the ExtraBrowserDocks line, built by hand so a
  # one-item list stays a list.
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

  # The [BasicWindow] ExtraBrowserDocks line of user.ini: where it is and its list.
  function Find-Docks($Lines) {
    $start = -1; $end = $Lines.Count; $at = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
      if ($Lines[$i].Trim() -eq '[BasicWindow]') { $start = $i; break }
    }
    $list = New-Object System.Collections.ArrayList
    if ($start -lt 0) { return @{ Start = -1; End = -1; At = -1; List = $list } }
    for ($end = $start + 1; $end -lt $Lines.Count; $end++) {
      if ($Lines[$end] -match '^\s*\[') { break }
    }
    for ($i = $start + 1; $i -lt $end; $i++) {
      if ($Lines[$i].StartsWith('ExtraBrowserDocks=')) { $at = $i; break }
    }
    if ($at -ge 0) {
      $value = $Lines[$at].Substring('ExtraBrowserDocks='.Length).Trim()
      if ($value -ne '') {
        if (-not $value.StartsWith('[')) { throw 'ExtraBrowserDocks is not a list' }
        $parsed = ConvertFrom-Json -InputObject $value
        foreach ($entry in @($parsed)) { $null = $list.Add($entry) }
      }
    }
    return @{ Start = $start; End = $end; At = $at; List = $list }
  }

  function Split-Lines([string]$Text) {
    $lines = New-Object System.Collections.ArrayList
    foreach ($line in [regex]::Split($Text, '\r?\n')) { $null = $lines.Add($line) }
    return , $lines
  }

  function Get-NewLine([string]$Text) {
    if ($Text.Contains("`r`n")) { return "`r`n" }
    return "`n"
  }

  function Get-FileName([string]$Path) {
    $parts = $Path -split '[\\/]'
    return $parts[$parts.Count - 1]
  }

  function Get-Collections {
    $dir = Join-Path $S.Cfg 'basic\scenes'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return @() }
    # Only *.json: never the .bak and .v1 copies OBS keeps beside them.
    $files = @(Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.Name.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase) } | Sort-Object Name)
    return $files
  }

  function Get-Value($Item, [string]$Name) {
    $p = $Item.PSObject.Properties[$Name]
    if ($null -eq $p) { return '' }
    return [string]$p.Value
  }

  # The OBS install root from one uninstall registry entry, or ''.
  function Get-RootFromEntry($Item) {
    $loc = (Get-Value $Item 'InstallLocation').Trim('"', ' ')
    if ($loc -ne '') { return $loc }
    $icon = (Get-Value $Item 'DisplayIcon') -replace ',\s*-?\d+$', ''
    $icon = $icon.Trim('"', ' ')
    if ($icon -match 'obs64\.exe$') { return (Split-Path (Split-Path (Split-Path $icon))) }
    $un = (Get-Value $Item 'UninstallString').Trim('"', ' ')
    if ($un -ne '') { return (Split-Path $un) }
    return ''
  }

  function Find-ObsExe {
    $override = Get-Setting 'LC_OBS_EXE' ''
    if ($override -ne '') { return $override }
    $roots = New-Object System.Collections.ArrayList
    $testKey = Get-Setting 'LC_OBS_REGISTRY' ''
    if ($testKey -ne '') {
      $keys = @("$testKey\*")
    } else {
      # OBS's installer writes HKLM, 32-bit view (frontend/updater/updater.cpp).
      $keys = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
      )
    }
    foreach ($key in $keys) {
      foreach ($item in @(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue)) {
        if ((Get-Value $item 'DisplayName') -like 'OBS Studio*') {
          $root = Get-RootFromEntry $item
          if ($root -ne '') { $null = $roots.Add($root) }
        }
      }
    }
    if ($testKey -eq '') {
      $null = $roots.Add((Join-Path $env:ProgramFiles 'obs-studio'))
    }
    foreach ($root in $roots) {
      # Every OBS build runs from bin\64bit, the ARM64 one too (the updater
      # starts bin\64bit\obs64.exe on every machine).
      $exe = Join-Path $root 'bin\64bit\obs64.exe'
      if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
    }
    return ''
  }

  function Test-Obs {
    $exe = Find-ObsExe
    if ($exe -eq '' -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) {
      Fail 'OBS is not installed on this PC. Install OBS Studio 31 or later from https://obsproject.com, open it once, quit it, then run this again.'
    }
    $info = (Get-Item -LiteralPath $exe).VersionInfo
    $major = $info.FileMajorPart
    if ($major -le 0) {
      Fail "Could not read the OBS version in $exe. Reinstall OBS Studio from https://obsproject.com, then run this again."
    }
    $version = '{0}.{1}.{2}' -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart
    if ($major -lt 31) {
      Fail "This PC has OBS $version. Live Counter needs OBS 31 or later. Update OBS from https://obsproject.com, open it once, quit it, then run this again."
    }
    # Portable OBS keeps its settings beside the program, two levels above
    # obs64.exe, instead of in %APPDATA%.
    $root = Split-Path (Split-Path (Split-Path $exe))
    foreach ($marker in $LcPortableMarkers) {
      if (Test-Path -LiteralPath (Join-Path $root $marker)) {
        Fail "OBS on this PC is a portable copy, so its settings are not where this installer looks. Set up Live Counter by hand with setup.html instead."
      }
    }
    Say "Found OBS $version."
  }

  function Test-SettingsFolder {
    if (-not (Test-Path -LiteralPath $S.Cfg -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $S.Cfg 'user.ini') -PathType Leaf)) {
      Fail 'OBS has not saved its settings yet. Open OBS once, quit it, then run this again.'
    }
  }

  function Wait-ObsClosed {
    $name = Get-Setting 'LC_OBS_PROCESS' 'obs64'
    while (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) {
      # No console to answer on (a test, or a redirected run): stop instead of waiting.
      if ([Console]::IsInputRedirected) {
        Fail 'OBS is open. Please quit OBS, then run this again.'
      }
      Say 'Please quit OBS, then press Enter.'
      $null = Read-Host
    }
  }

  function Test-BackupTaken([string]$Ts) {
    foreach ($dir in @($S.Cfg, (Join-Path $S.Cfg 'plugin_config\obs-websocket'), (Join-Path $S.Cfg 'basic\scenes'))) {
      if (Test-Path -LiteralPath $dir -PathType Container) {
        if (@(Get-ChildItem -LiteralPath $dir -Filter "*.live-counter-backup-$Ts" -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
      }
    }
    return $false
  }

  # A timestamp no earlier backup uses, so a quick second run never
  # overwrites the first run's copies.
  function Select-Timestamp {
    while ($true) {
      $S.Ts = Get-Date -Format 'yyyyMMdd-HHmmss'
      if (-not (Test-BackupTaken $S.Ts)) { break }
      Start-Sleep -Seconds 1
    }
    # Invariant culture: some cultures write the time separator as a dot.
    $S.Revision = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
  }

  function Expand-Release([string]$Zip) {
    $out = Join-Path $S.Work 'unzipped'
    try {
      Expand-Archive -LiteralPath $Zip -DestinationPath $out -Force
    } catch {
      Fail 'Could not open the Live Counter download. Download it again, then run this again.'
    }
    $dock = @(Get-ChildItem -LiteralPath $out -Recurse -File -Filter 'dock.html' | Sort-Object { $_.FullName.Length })
    if ($dock.Count -eq 0) {
      Fail 'The Live Counter download has no dock.html. Download it again, then run this again.'
    }
    $S.Src = $dock[0].DirectoryName
  }

  function Find-Source {
    $zip = Get-Setting 'LC_ZIP' ''
    if ($zip -ne '') {
      Say "Using the Live Counter files in $zip."
      # Expand-Archive in 5.1 only opens a file whose name ends in .zip.
      $copy = Join-Path $S.Work 'live-counter-for-obs.zip'
      try { Copy-Item -LiteralPath $zip -Destination $copy } catch {
        Fail "Could not open $zip. Download Live Counter again, then run this again."
      }
      Expand-Release $copy
      return
    }
    if ($LcHere -ne '') {
      $top = [IO.Path]::GetFullPath((Join-Path $LcHere '..\..'))
      if (Test-Path -LiteralPath (Join-Path $top 'dock.html') -PathType Leaf) {
        $S.Src = $top
        Say 'Using the Live Counter files in this folder.'
        return
      }
    }
    $url = Get-Setting 'LC_ZIP_URL' $LcDefaultZipUrl
    Say 'Downloading Live Counter...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $dest = Join-Path $S.Work 'live-counter-for-obs.zip'
    try {
      Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    } catch {
      Fail 'Could not download Live Counter. Check the internet connection, then run this again.'
    }
    Expand-Release $dest
  }

  function Test-Source {
    foreach ($f in $LcRequiredFiles) {
      if (-not (Test-Path -LiteralPath (Join-Path $S.Src $f) -PathType Leaf)) {
        Fail "The Live Counter files are incomplete ($f is missing). Download them again, then run this again."
      }
    }
  }

  function Install-Files {
    Say 'Copying the Live Counter files into the OBS settings folder...'
    $S.NewDir = Join-Path $S.Cfg 'live-counter.new'
    $S.OldDir = Join-Path $S.Cfg 'live-counter.old'
    foreach ($d in @($S.NewDir, $S.OldDir)) {
      if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
    }
    try { $null = New-Item -ItemType Directory -Path $S.NewDir } catch {
      Fail "Could not write to $($S.Cfg). Check that your Windows account can change that folder, then run this again."
    }
    # An allowlist: a live-counter-config.js in a download is never copied.
    foreach ($f in ($LcRequiredFiles + $LcOptionalFiles)) {
      $from = Join-Path $S.Src $f
      if (Test-Path -LiteralPath $from -PathType Leaf) {
        try { Copy-Item -LiteralPath $from -Destination (Join-Path $S.NewDir $f) } catch {
          Fail "Could not copy $f into $($S.Cfg). Check the free disk space, then run this again."
        }
      }
    }
    if (Test-Path -LiteralPath $S.InstallDir) {
      try { Move-Item -LiteralPath $S.InstallDir -Destination $S.OldDir } catch {
        Fail "Could not update $($S.InstallDir). Close any window that shows that folder, then run this again."
      }
      $S.MovedOld = $true
    }
    try { Move-Item -LiteralPath $S.NewDir -Destination $S.InstallDir } catch {
      Fail "Could not create $($S.InstallDir). Run this again."
    }
    $S.NewDir = ''
    $S.Placed = $true
  }

  function Save-Backup([string]$Path) {
    try { [IO.File]::Copy($Path, "$Path.live-counter-backup-$($S.Ts)") } catch {
      Fail "Could not save a copy of $Path. Check the free disk space, then run this again."
    }
    $null = $S.BackedUp.Add($Path)
  }

  function Backup-ObsFiles {
    Say 'Saving copies of the OBS settings it changes...'
    Save-Backup (Join-Path $S.Cfg 'user.ini')
    $ws = Join-Path $S.Cfg 'plugin_config\obs-websocket\config.json'
    if (Test-Path -LiteralPath $ws -PathType Leaf) { Save-Backup $ws }
    foreach ($f in (Get-Collections)) { Save-Backup $f.FullName }
  }

  function New-Password {
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $out = New-Object System.Text.StringBuilder
    $byte = New-Object byte[] 1
    while ($out.Length -lt 16) {
      $rng.GetBytes($byte)
      # 248 is the largest multiple of 62 below 256, so every character is equally likely.
      if ($byte[0] -lt 248) { $null = $out.Append($chars[$byte[0] % 62]) }
    }
    return $out.ToString()
  }

  function Test-Port($Port) {
    if ($Port -is [int] -or $Port -is [long]) { return ($Port -ge 1 -and $Port -le 65535) }
    return $false
  }

  # Limits the connection file to this Windows user, where Windows allows it.
  function Protect-File([string]$Path) {
    try {
      $acl = New-Object System.Security.AccessControl.FileSecurity
      $acl.SetAccessRuleProtection($true, $false)
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList $me, 'FullControl', 'Allow'
      $acl.AddAccessRule($rule)
      [IO.File]::SetAccessControl($Path, $acl)
    } catch {
      # Some file systems have no permissions to set; the file still works.
    }
  }

  function Set-WebSocket {
    $dir = Join-Path $S.Cfg 'plugin_config\obs-websocket'
    $path = Join-Path $dir 'config.json'
    $fix = "Could not read the OBS WebSocket settings ($path). Open OBS, open Tools > WebSocket Server Settings, click OK, quit OBS, then run this again."
    foreach ($d in @((Join-Path $S.Cfg 'plugin_config'), $dir)) {
      if (-not (Test-Path -LiteralPath $d)) {
        $null = New-Item -ItemType Directory -Path $d
        $null = $S.CreatedDirs.Insert(0, $d)
      }
    }
    $outcome = 'kept'
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      try { $cfg = ConvertFrom-Json -InputObject (Read-Text $path) } catch { Fail $fix }
      if (-not (Test-JsonObject $cfg)) { Fail $fix }
    } else {
      $null = $S.Created.Add($path)
      $cfg = [pscustomobject]@{}
      Set-Prop $cfg 'alerts_enabled' $false
      Set-Prop $cfg 'auth_required' $true
      Set-Prop $cfg 'first_load' $false
      Set-Prop $cfg 'server_enabled' $true
      Set-Prop $cfg 'server_port' 4455
      $outcome = 'created'
    }
    $before = ConvertTo-LcJson $cfg
    $enabled = Get-Prop $cfg 'server_enabled'
    if ($outcome -eq 'kept' -and $enabled -is [bool] -and $enabled) { $outcome = 'already-on' }
    Set-Prop $cfg 'server_enabled' $true
    Set-Prop $cfg 'auth_required' $true
    if (-not (Test-Port (Get-Prop $cfg 'server_port'))) { Set-Prop $cfg 'server_port' 4455 }
    $password = Get-Prop $cfg 'server_password'
    if ($password -isnot [string] -or $password -eq '') {
      Set-Prop $cfg 'server_password' (New-Password)
      if ($outcome -eq 'kept' -or $outcome -eq 'already-on') { $outcome = 'generated' }
    }
    $after = ConvertTo-LcJson $cfg
    if ($outcome -eq 'created' -or $after -ne $before) {
      try { Write-Text $path ($after + "`n") $false } catch { Fail $fix }
    }

    # The connection file: created empty, limited to this user, then filled.
    $conn = Join-Path $S.InstallDir 'live-counter-config.js'
    try {
      Write-Text $conn '' $false
      Protect-File $conn
      $port = [int](Get-Prop $cfg 'server_port')
      $pw = ConvertTo-Json -InputObject ([string](Get-Prop $cfg 'server_password')) -Depth 100 -Compress
      $rev = ConvertTo-Json -InputObject ([string]$S.Revision) -Depth 100 -Compress
      Write-Text $conn ('window.LIVE_COUNTER_CONFIG = { port: ' + $port + ', password: ' + $pw + ', revision: ' + $rev + " };`n") $false
    } catch {
      Fail "Could not write $conn. Run this again."
    }
    switch ($outcome) {
      'created' { Say 'Turned on the OBS WebSocket server with a new password.' }
      'generated' { Say 'Turned on the OBS WebSocket server and made a password for it.' }
      'already-on' { Say 'The OBS WebSocket server is on (password kept).' }
      default { Say 'Turned on the OBS WebSocket server (password kept).' }
    }
    Say 'Connected the Live Counter panel to OBS.'
  }

  function Test-OurScript($Entry, [string]$Lua) {
    if (-not (Test-JsonObject $Entry)) { return $false }
    $p = Get-Prop $Entry 'path'
    return ($p -is [string]) -and ((Get-FileName $p) -eq (Get-FileName $Lua))
  }

  # Adds the script, or repoints the existing entry (keeping the one with
  # saved keys) and leaves one. Returns changed or unchanged.
  function Update-Collection([string]$Path, [string]$Lua) {
    $j = ConvertFrom-Json -InputObject (Read-Text $Path)
    if (-not (Test-JsonObject $j)) { throw 'not an object' }
    $before = ConvertTo-LcJson $j
    if (-not (Test-Prop $j 'modules')) { Set-Prop $j 'modules' ([pscustomobject]@{}) }
    $modules = Get-Prop $j 'modules'
    if (-not (Test-JsonObject $modules)) { throw 'modules is not an object' }
    $list = @()
    if (Test-Prop $modules 'scripts-tool') {
      $list = $modules.PSObject.Properties['scripts-tool'].Value
      if ($list -isnot [System.Array]) { throw 'scripts-tool is not a list' }
    }
    $first = -1; $keep = -1
    for ($i = 0; $i -lt $list.Count; $i++) {
      if (-not (Test-OurScript $list[$i] $Lua)) { continue }
      if ($first -lt 0) { $first = $i }
      $settings = Get-Prop $list[$i] 'settings'
      if ($keep -lt 0 -and (Test-JsonObject $settings) -and @($settings.PSObject.Properties).Count -gt 0) { $keep = $i }
    }
    $result = New-Object System.Collections.ArrayList
    if ($first -lt 0) {
      foreach ($e in $list) { $null = $result.Add($e) }
      $entry = [pscustomobject]@{}
      Set-Prop $entry 'path' $Lua
      Set-Prop $entry 'settings' ([pscustomobject]@{})
      $null = $result.Add($entry)
    } else {
      if ($keep -lt 0) { $keep = $first }
      $entry = $list[$keep]
      Set-Prop $entry 'path' $Lua
      if (-not (Test-JsonObject (Get-Prop $entry 'settings'))) { Set-Prop $entry 'settings' ([pscustomobject]@{}) }
      for ($i = 0; $i -lt $list.Count; $i++) {
        if (-not (Test-OurScript $list[$i] $Lua)) { $null = $result.Add($list[$i]) }
        elseif ($i -eq $first) { $null = $result.Add($entry) }
      }
    }
    Set-Prop $modules 'scripts-tool' $result.ToArray()
    $after = ConvertTo-LcJson $j
    if ($after -eq $before) { return 'unchanged' }
    # Parse-check before replacing the file.
    $null = ConvertFrom-Json -InputObject $after
    Write-Text $Path $after (Test-Bom $Path)
    return 'changed'
  }

  function Add-ScriptToCollections {
    # OBS stores script paths with forward slashes (they come from a Qt file dialog).
    $lua = (Join-Path $S.InstallDir $LcScript) -replace '\\', '/'
    $changed = 0
    foreach ($f in (Get-Collections)) {
      try { $r = Update-Collection $f.FullName $lua } catch {
        Fail "Could not read the scene collection $($f.Name). Open OBS, choose that collection in the Scene Collection menu so OBS saves it again, quit OBS, then run this again."
      }
      if ($r -eq 'changed') { $changed++ }
    }
    if ($changed -eq 0) { Say 'The hotkey script is in every scene collection.' }
    elseif ($changed -eq 1) { Say 'Added the hotkey script to 1 scene collection.' }
    else { Say "Added the hotkey script to $changed scene collections." }
  }

  # Adds the dock or repoints the one with that title, keeping its uuid.
  # Edits only the ExtraBrowserDocks line inside [BasicWindow].
  function Update-UserIni([string]$Path, [string]$Url, [string]$Title) {
    $bom = Test-Bom $Path
    $text = Read-Text $Path
    $nl = Get-NewLine $text
    $lines = Split-Lines $text
    $d = Find-Docks $lines
    $found = $null
    foreach ($o in $d.List) {
      if ((Test-JsonObject $o) -and ((Get-Prop $o 'title') -ceq $Title)) { $found = $o; break }
    }
    if ($null -ne $found) {
      $uuid = Get-Prop $found 'uuid'
      if (((Get-Prop $found 'url') -ceq $Url) -and ($uuid -is [string]) -and $uuid -ne '') { return 'unchanged' }
      Set-Prop $found 'url' $Url
      if ($uuid -isnot [string] -or $uuid -eq '') { Set-Prop $found 'uuid' ([guid]::NewGuid().ToString('N')) }
    } else {
      $entry = [pscustomobject]@{}
      Set-Prop $entry 'title' $Title
      Set-Prop $entry 'url' $Url
      Set-Prop $entry 'uuid' ([guid]::NewGuid().ToString('N'))
      $null = $d.List.Add($entry)
    }
    $line = 'ExtraBrowserDocks=' + (ConvertTo-DocksText $d.List)
    if ($d.At -ge 0) {
      $lines[$d.At] = $line
    } elseif ($d.Start -ge 0) {
      $at = $d.End
      while ($at - 1 -gt $d.Start -and $lines[$at - 1].Trim() -eq '') { $at-- }
      $lines.Insert($at, $line)
    } else {
      while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
      $null = $lines.Add('')
      $null = $lines.Add('[BasicWindow]')
      $null = $lines.Add($line)
      $null = $lines.Add('')
    }
    Write-Text $Path ($lines -join $nl) $bom
    return 'changed'
  }

  function Add-Dock {
    $path = Join-Path $S.Cfg 'user.ini'
    $url = ([System.Uri](Join-Path $S.InstallDir 'dock.html')).AbsoluteUri
    try { $r = Update-UserIni $path $url $LcTitle } catch {
      Fail "Could not read the Custom Browser Docks list in $path. Open OBS, open Docks > Custom Browser Docks, click Apply, quit OBS, then run this again."
    }
    if ($r -eq 'unchanged') { Say 'The Live Counter panel is in OBS.' }
    else { Say 'Added the Live Counter panel to OBS.' }
  }

  function Test-WebSocketSaved {
    $cfg = ConvertFrom-Json -InputObject (Read-Text (Join-Path $S.Cfg 'plugin_config\obs-websocket\config.json'))
    if ((Get-Prop $cfg 'server_enabled') -ne $true -or (Get-Prop $cfg 'auth_required') -ne $true) { return $false }
    $pw = Get-Prop $cfg 'server_password'
    if ($pw -isnot [string] -or $pw -eq '') { return $false }
    $conn = Read-Text (Join-Path $S.InstallDir 'live-counter-config.js')
    $m = [regex]::Match($conn, '^window\.LIVE_COUNTER_CONFIG = \{ port: (\d+), password: ("(?:[^"\\]|\\.)*"), revision: ("[^"]+") \};\n$')
    if (-not $m.Success) { return $false }
    if ([int]$m.Groups[1].Value -ne [int](Get-Prop $cfg 'server_port')) { return $false }
    return ((ConvertFrom-Json -InputObject $m.Groups[2].Value) -ceq $pw)
  }

  function Test-DockSaved {
    $url = ([System.Uri](Join-Path $S.InstallDir 'dock.html')).AbsoluteUri
    $d = Find-Docks (Split-Lines (Read-Text (Join-Path $S.Cfg 'user.ini')))
    $mine = @($d.List | Where-Object { (Test-JsonObject $_) -and ((Get-Prop $_ 'title') -ceq $LcTitle) })
    return ($mine.Count -eq 1 -and (Get-Prop $mine[0] 'url') -ceq $url)
  }

  function Test-CollectionSaved([string]$Path) {
    $lua = (Join-Path $S.InstallDir $LcScript) -replace '\\', '/'
    $j = ConvertFrom-Json -InputObject (Read-Text $Path)
    $list = @(Get-Prop (Get-Prop $j 'modules') 'scripts-tool')
    $mine = @($list | Where-Object { Test-OurScript $_ $lua })
    return ($mine.Count -eq 1 -and (Get-Prop $mine[0] 'path') -ceq $lua)
  }

  function Test-Changes {
    Say 'Checking the changes...'
    $ok = $false
    try { $ok = Test-WebSocketSaved } catch { $ok = $false }
    if (-not $ok) { Fail 'The OBS WebSocket settings did not save correctly. Run this again.' }
    try { $ok = Test-DockSaved } catch { $ok = $false }
    if (-not $ok) { Fail "The Live Counter panel did not save correctly in $(Join-Path $S.Cfg 'user.ini'). Run this again." }
    foreach ($f in (Get-Collections)) {
      try { $ok = Test-CollectionSaved $f.FullName } catch { $ok = $false }
      if (-not $ok) { Fail "The scene collection $($f.Name) did not save correctly. Run this again." }
    }
  }

  function Test-SameFile([string]$A, [string]$B) {
    $x = [IO.File]::ReadAllBytes($A)
    $y = [IO.File]::ReadAllBytes($B)
    if ($x.Length -ne $y.Length) { return $false }
    for ($i = 0; $i -lt $x.Length; $i++) { if ($x[$i] -ne $y[$i]) { return $false } }
    return $true
  }

  # Keeps a backup only when its file really changed.
  function Complete-Install {
    foreach ($f in $S.BackedUp) {
      $b = "$f.live-counter-backup-$($S.Ts)"
      if ((Test-Path -LiteralPath $b) -and (Test-SameFile $f $b)) { Remove-Item -LiteralPath $b -Force }
    }
    if ($S.MovedOld -and (Test-Path -LiteralPath $S.OldDir)) { Remove-Item -LiteralPath $S.OldDir -Recurse -Force }
  }

  # Puts back everything this run changed. Each step is tried on its own, so
  # one that fails does not stop the rest.
  function Undo-Install {
    foreach ($f in $S.BackedUp) {
      $b = "$f.live-counter-backup-$($S.Ts)"
      try { if (Test-Path -LiteralPath $b) { [IO.File]::Copy($b, $f, $true); [IO.File]::Delete($b) } } catch { }
    }
    foreach ($f in $S.Created) { try { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } } catch { } }
    foreach ($d in $S.CreatedDirs) {
      try { if (@(Get-ChildItem -LiteralPath $d -Force).Count -eq 0) { Remove-Item -LiteralPath $d -Force } } catch { }
    }
    if ($S.Placed) { try { Remove-Item -LiteralPath $S.InstallDir -Recurse -Force } catch { } }
    if ($S.MovedOld) { try { if (Test-Path -LiteralPath $S.OldDir) { Move-Item -LiteralPath $S.OldDir -Destination $S.InstallDir } } catch { } }
    if ($S.NewDir -ne '') { try { if (Test-Path -LiteralPath $S.NewDir) { Remove-Item -LiteralPath $S.NewDir -Recurse -Force } } catch { } }
  }

  function Remove-Work {
    if ($S.Work -ne '' -and (Test-Path -LiteralPath $S.Work)) {
      try { Remove-Item -LiteralPath $S.Work -Recurse -Force } catch { }
    }
  }

  function Invoke-Install {
    Say 'Live Counter for OBS: installer'
    Say 'Checking this PC...'
    $done = $false
    $message = 'Stopped before the end.'
    try {
      if ($env:OS -ne 'Windows_NT') { Fail 'This installer is for Windows. On a Mac, use Install Live Counter.command.' }
      $S.Cfg = Get-Setting 'LC_OBS_CONFIG_DIR' (Join-Path $env:APPDATA 'obs-studio')
      $S.InstallDir = Join-Path $S.Cfg 'live-counter'
      Test-Obs
      Test-SettingsFolder
      Wait-ObsClosed
      $S.Work = Join-Path ([IO.Path]::GetTempPath()) ('live-counter-' + [guid]::NewGuid().ToString('N'))
      try { $null = New-Item -ItemType Directory -Path $S.Work } catch {
        Fail 'Could not make a temporary folder. Restart the PC, then run this again.'
      }
      Find-Source
      Test-Source
      Select-Timestamp

      Install-Files
      Test-FaultPoint 'files'
      Backup-ObsFiles
      Set-WebSocket
      Test-FaultPoint 'websocket'
      Add-ScriptToCollections
      Test-FaultPoint 'collections'
      Add-Dock
      Test-FaultPoint 'dock'
      Test-Changes
      Complete-Install
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
      # Runs on Ctrl+C too, where the catch above does not.
      if (-not $done) {
        Write-Host ''
        Write-Host $message
        Undo-Install
        Write-Host 'Nothing was changed: your OBS settings are as they were.'
      }
      Remove-Work
    }
    if ($done) {
      Say ''
      Say 'In OBS, the Live Counter panel opens and connects by itself.'
      Say 'Keys: Ctrl+Alt with = adds one, - takes one away, Z undoes, P pauses, H shows or hides.'
      Say 'To show the counter, pick your scene in OBS, then click Add overlay to my scene in the panel.'
      Say 'Done. Open OBS.'
    }
  }

  Invoke-Install
}
