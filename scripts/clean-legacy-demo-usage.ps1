param([Parameter(Mandatory=$true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$locked = New-Object System.Collections.Generic.List[object]
$modified = New-Object System.Collections.Generic.List[object]
$backupRoot = $null

function Assert-PlainPath([string]$Value, [bool]$Directory) {
  $full = [IO.Path]::GetFullPath($Value)
  if ($full -notmatch '^[A-Za-z]:\\' -or $full.Substring(2).Contains(':')) { throw 'Only local drive paths are supported' }
  $cursor = $full
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked or redirected paths are not supported' }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  $target = Get-Item -LiteralPath $full -Force
  if ($target.PSIsContainer -ne $Directory) { throw 'Expected a regular file or directory' }
  return $full.TrimEnd('\')
}
function Get-Hash([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Read-Locked($Stream) {
  if ($Stream.Length -gt 67108864) { throw 'Usage file exceeds the 64 MiB limit' }
  [byte[]]$bytes = New-Object byte[] ([int]$Stream.Length)
  $Stream.Position = 0; $offset = 0
  while ($offset -lt $bytes.Length) { $read = $Stream.Read($bytes, $offset, $bytes.Length - $offset); if ($read -le 0) { throw 'Usage file read was incomplete' }; $offset += $read }
  return ,$bytes
}
function Write-Locked($Stream, [byte[]]$Bytes) {
  $Stream.Position = 0
  $Stream.SetLength(0)
  $Stream.Write($Bytes, 0, $Bytes.Length)
  $Stream.Flush($true)
}
function Write-NewFile([string]$File, [byte[]]$Bytes) {
  $stream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

try {
  $planFile = Assert-PlainPath $PlanPath $false
  $plan = [IO.File]::ReadAllText($planFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($plan.schemaVersion -ne 1 -or $plan.fingerprint -ne 'seed-demo-7b192e8-v1' -or @($plan.files).Count -lt 1 -or @($plan.files).Count -gt 1000) { throw 'Unsupported cleanup plan' }
  $dataRoot = Assert-PlainPath ([string]$plan.dataDir) $true
  $usageRoot = Assert-PlainPath (Join-Path $dataRoot 'usage') $true
  if (-not [String]::Equals($usageRoot, [IO.Path]::GetFullPath([string]$plan.usageDir).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Usage directory does not belong to the explicit data directory' }
  $backupRoot = [IO.Path]::GetFullPath([string]$plan.backupDir).TrimEnd('\')
  if ($backupRoot.Equals($dataRoot, [StringComparison]::OrdinalIgnoreCase) -or $backupRoot.StartsWith($dataRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup must be outside the application data directory' }
  $null = Assert-PlainPath ([IO.Path]::GetDirectoryName($backupRoot)) $true
  if (Test-Path -LiteralPath $backupRoot) { throw 'Backup destination already exists' }
  $seen = @{}; $today = (Get-Date).ToString('yyyy-MM-dd'); $totalBytes = 0

  # Acquire every target before any write. FileShare.Read rejects other writers and deletion.
  foreach ($entry in @($plan.files | Sort-Object name)) {
    $name = [string]$entry.name
    if ($name -notmatch '^\d{4}-\d{2}-\d{2}\.jsonl$' -or $seen.ContainsKey($name)) { throw 'Invalid or duplicated usage filename' }
    $date = [DateTime]::ParseExact($name.Substring(0,10), 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    if ($date.ToString('yyyy-MM-dd') -ge $today) { throw 'Refusing today or future usage files' }
    $seen[$name] = $true
    $file = Assert-PlainPath (Join-Path $usageRoot $name) $false
    if ($entry.beforeSha256 -notmatch '^[a-f0-9]{64}$' -or $entry.afterSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid expected file digest' }
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    $item = @{ name=$name; file=$file; stream=$stream; before=$null; after=$null; entry=$entry }
    $locked.Add($item)
    $before = Read-Locked $stream
    if ($before.Length -ne $entry.beforeLength -or (Get-Hash $before) -ne $entry.beforeSha256) { throw ('Usage changed after preview; retained current file: ' + $name) }
    $item.before = $before; $totalBytes += $before.Length
    if ($totalBytes -gt 268435456) { throw 'Cleanup exceeds the 256 MiB transaction limit' }
    $output = New-Object IO.MemoryStream
    try {
      $position = 0; $ranges = @($entry.removeRanges)
      if ($ranges.Count -ne $entry.removed -or $ranges.Count -lt 6) { throw 'Invalid deletion ranges' }
      foreach ($range in $ranges) {
        if ($range.start -ne [Math]::Floor($range.start) -or $range.end -ne [Math]::Floor($range.end) -or $range.start -lt $position -or $range.end -le $range.start -or $range.end -gt $before.Length) { throw 'Deletion range escapes the usage bytes' }
        if (($range.start -gt 0 -and $before[$range.start - 1] -ne 10) -or $before[$range.end - 1] -ne 10) { throw 'Deletion range must contain complete lines' }
        $output.Write($before, $position, $range.start - $position); $position = [int]$range.end
      }
      $output.Write($before, $position, $before.Length - $position)
      [byte[]]$after = $output.ToArray()
      if ($after.Length -ne $entry.afterLength -or (Get-Hash $after) -ne $entry.afterSha256) { throw 'Retained-byte verification failed' }
      $item.after = $after
    } finally { $output.Dispose() }
  }

  # All originals are locked and validated. Save only usage bytes, never settings or credentials.
  $null = New-Item -ItemType Directory -Path $backupRoot -ErrorAction Stop
  $null = Assert-PlainPath $backupRoot $true
  foreach ($item in $locked) { Write-NewFile (Join-Path $backupRoot $item.name) $item.before }
  $manifest = @{ schemaVersion=1; fingerprint=$plan.fingerprint; dataDir=$dataRoot; createdAt=[DateTime]::UtcNow.ToString('o'); files=@($locked | ForEach-Object { @{name=$_.name; beforeSha256=$_.entry.beforeSha256; afterSha256=$_.entry.afterSha256; removed=$_.entry.removed; beforeLength=$_.before.Length; afterLength=$_.after.Length} }) }
  Write-NewFile (Join-Path $backupRoot 'manifest.json') ([Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Depth 8)))
  foreach ($item in $locked) {
    $modified.Add($item) # Include a partially written current file in rollback.
    Write-Locked $item.stream $item.after
    if ((Get-Hash (Read-Locked $item.stream)) -ne $item.entry.afterSha256) { throw 'Written usage verification failed' }
  }
  $report = @{status='cleaned';files=$locked.Count;removed=($locked | ForEach-Object {$_.entry.removed} | Measure-Object -Sum).Sum;backupDir=$backupRoot}
  $exitCode = 0
} catch {
  $message = $_.Exception.Message; $failed = New-Object System.Collections.Generic.List[string]
  for ($index=$modified.Count-1; $index -ge 0; $index--) {
    $item=$modified[$index]
    try { Write-Locked $item.stream $item.before; if ((Get-Hash (Read-Locked $item.stream)) -ne $item.entry.beforeSha256) { throw 'Restore verification failed' } }
    catch { $failed.Add($item.name) }
  }
  $report = @{status='refused';message=$message;restored=$modified.Count - $failed.Count;restoreFailures=@($failed);backupDir=$backupRoot}
  $exitCode = 1
} finally { foreach ($item in $locked) { $item.stream.Dispose() } }
$report | ConvertTo-Json -Depth 8 -Compress
exit $exitCode
