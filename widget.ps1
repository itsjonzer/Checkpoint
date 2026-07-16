# Launches Checkpoint as a small desktop widget: a chromeless Edge/Chrome
# app window docked in the top-right corner of the screen.
#
# On machines where PowerShell runs in FullLanguage mode, the window is
# also pinned always-on-top via Win32. On IT-managed machines with
# ConstrainedLanguage mode (which blocks Add-Type), the widget still
# opens normally — it just can't be auto-pinned.

$ErrorActionPreference = 'Stop'

$appPath = Join-Path $PSScriptRoot 'index.html'
if (-not (Test-Path $appPath)) {
  Write-Error "index.html not found next to this script."
  exit 1
}
$url = 'file:///' + ($appPath -replace '\\', '/') + '?widget=1'

$candidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:LocalAppData}\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) {
  Write-Error 'Neither Microsoft Edge nor Google Chrome was found.'
  exit 1
}

# Widget size, docked near the top-right corner (CIM instead of
# System.Windows.Forms so this also works in ConstrainedLanguage mode)
$screenW = 1920
try {
  $vc = Get-CimInstance Win32_VideoController -ErrorAction Stop |
    Where-Object { $_.CurrentHorizontalResolution } | Select-Object -First 1
  if ($vc) { $screenW = $vc.CurrentHorizontalResolution }
} catch { }

$width = 360
$height = 560
$posX = $screenW - $width - 26
$posY = 16

Start-Process $browser -ArgumentList "--app=`"$url`"", "--window-size=$width,$height", "--window-position=$posX,$posY"

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Host ''
  Write-Host "Widget opened. (PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode on this machine,"
  Write-Host 'so the window cannot be auto-pinned always-on-top. If you want pinning,'
  Write-Host "Microsoft PowerToys 'Always On Top' can do it with Win+Ctrl+T.)"
  exit 0
}

# FullLanguage machines: pin the widget window always-on-top
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CheckpointWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_SHOWWINDOW = 0x0040;
}
"@

$deadline = (Get-Date).AddSeconds(15)
$pinned = $false
while (-not $pinned -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 400
  $win = Get-Process |
    Where-Object { $_.MainWindowTitle -eq 'Checkpoint Widget' -and $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if ($win) {
    [CheckpointWin32]::SetWindowPos(
      $win.MainWindowHandle,
      [CheckpointWin32]::HWND_TOPMOST,
      0, 0, 0, 0,
      [CheckpointWin32]::SWP_NOMOVE -bor [CheckpointWin32]::SWP_NOSIZE -bor [CheckpointWin32]::SWP_SHOWWINDOW
    ) | Out-Null
    $pinned = $true
  }
}

if (-not $pinned) {
  Write-Warning 'Widget window opened, but could not be pinned always-on-top (window not found in time).'
}
