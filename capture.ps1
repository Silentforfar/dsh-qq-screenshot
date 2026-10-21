<#
  QQ screenshot capture helper for the DSH "QQ 截图" plugin.

  The script presses the configured QQ screenshot hotkey (default Ctrl+Alt+A),
  waits for the QQ capture overlay to appear, waits for the user to finish the
  region selection, and then stores the bitmap that QQ copied to the clipboard
  as a PNG file.

  It always writes one UTF-8 JSON result file (never throws to the caller):
    { "ok": true,  "path": "...", "width": 1280, "height": 720, "bytes": 12345 }
    { "ok": false, "code": "no-overlay" | "cancelled" | "timeout" | "error", "message": "..." }
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Hotkey = 'Ctrl+Alt+A',
  [int]$TimeoutSec = 100,
  [int]$StartTimeoutSec = 8,
  [string]$ResultFile = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ResultFile)) { $ResultFile = "$OutFile.json" }

# Per-user overrides, re-read on every capture so a change needs no restart:
#   %USERPROFILE%\.dsh\qq-screenshot.json  { "hotkey": "Ctrl+Alt+A", "timeoutSec": 100 }
$settingsPath = ''
if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
  $settingsPath = Join-Path $env:USERPROFILE '.dsh\qq-screenshot.json'
}
if ($settingsPath -ne '' -and (Test-Path -LiteralPath $settingsPath)) {
  try {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if ($null -ne $settings.hotkey -and -not [string]::IsNullOrWhiteSpace([string]$settings.hotkey)) {
      $Hotkey = [string]$settings.hotkey
    }
    if ($null -ne $settings.timeoutSec -and [int]$settings.timeoutSec -gt 5) {
      $TimeoutSec = [int]$settings.timeoutSec
    }
  } catch { }
}

$script:debugLines = New-Object System.Collections.Generic.List[string]
function Write-DebugLine {
  param([string]$Text)
  $script:debugLines.Add((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $Text)
}

function Write-Result {
  param([hashtable]$Payload)
  $json = $Payload | ConvertTo-Json -Compress -Depth 4
  if ($Payload.ok -ne $true -and $script:debugLines.Count -gt 0) {
    try {
      [System.IO.File]::WriteAllLines(
        "$ResultFile.log",
        [string[]]$script:debugLines.ToArray(),
        (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
  }
  [System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output $json
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class QQShotNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    public static void SendKey(ushort vk, bool up)
    {
        INPUT input = new INPUT();
        input.type = 1;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = 0;
        input.u.ki.dwFlags = up ? 2u : 0u;
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        INPUT[] batch = new INPUT[] { input };
        SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
    }

    /** True while a QQ capture overlay is on screen: its window class, or a full-screen window of a QQ process. */
    public static bool OverlayOpen(int screenWidth, int screenHeight)
    {
        bool found = false;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;

            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            if (cls.IndexOf("QQScreenCapture", StringComparison.OrdinalIgnoreCase) >= 0) { found = true; return false; }
            if (cls.IndexOf("QQScreenShot", StringComparison.OrdinalIgnoreCase) >= 0) { found = true; return false; }
            if (cls.IndexOf("QQScreenshot", StringComparison.OrdinalIgnoreCase) >= 0) { found = true; return false; }

            // Ordinary shell / Qt windows are not the capture overlay.
            if (cls == "Chrome_WidgetWin_1" || cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd") return true;

            RECT r;
            if (!GetWindowRect(hWnd, out r)) return true;
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            if (w < screenWidth * 0.95 || h < screenHeight * 0.95) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            try
            {
                var p = System.Diagnostics.Process.GetProcessById((int)pid);
                if (p.ProcessName.StartsWith("QQ", StringComparison.OrdinalIgnoreCase)) { found = true; return false; }
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /** Diagnostic snapshot of QQ-ish or full-screen windows, for troubleshooting the overlay handshake. */
    public static string Describe(int screenWidth, int screenHeight)
    {
        StringBuilder report = new StringBuilder();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            RECT r;
            if (!GetWindowRect(hWnd, out r)) return true;
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string proc = "?";
            try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
            bool interesting = cls.IndexOf("QQ", StringComparison.OrdinalIgnoreCase) >= 0
                || proc.StartsWith("QQ", StringComparison.OrdinalIgnoreCase)
                || (w >= screenWidth * 0.95 && h >= screenHeight * 0.95);
            if (!interesting) return true;
            report.Append(cls).Append(" | pid=").Append(pid).Append(" | ").Append(proc)
                  .Append(" | ").Append(w).Append("x").Append(h).Append(" @").Append(r.Left).Append(",").Append(r.Top)
                  .AppendLine();
            return true;
        }, IntPtr.Zero);
        return report.ToString();
    }
}
"@

function Get-HotkeyVirtualKeys {
  param([string]$Spec)
  $modifiers = New-Object System.Collections.Generic.List[int]
  $mainKey = 0
  foreach ($raw in $Spec.Split('+')) {
    $token = $raw.Trim()
    if ($token.Length -eq 0) { continue }
    $lower = $token.ToLowerInvariant()
    if ($lower -eq 'ctrl' -or $lower -eq 'control') { $modifiers.Add(0x11); continue }
    if ($lower -eq 'alt') { $modifiers.Add(0x12); continue }
    if ($lower -eq 'shift') { $modifiers.Add(0x10); continue }
    if ($lower -eq 'win' -or $lower -eq 'meta') { $modifiers.Add(0x5B); continue }
    if ($token.Length -eq 1) {
      $upper = $token.ToUpperInvariant()
      $code = [int][char]$upper[0]
      if (($code -ge 0x41 -and $code -le 0x5A) -or ($code -ge 0x30 -and $code -le 0x39)) { $mainKey = $code; continue }
    }
    if ($token -match '^(?i)F([1-9]|1[0-9]|2[0-4])$') { $mainKey = 0x70 + [int]$Matches[1] - 1; continue }
    if ($lower -eq 'prtsc' -or $lower -eq 'printscreen' -or $lower -eq 'snapshot') { $mainKey = 0x2C; continue }
    if ($lower -eq 'esc' -or $lower -eq 'escape') { $mainKey = 0x1B; continue }
    if ($lower -eq 'space') { $mainKey = 0x20; continue }
    if ($lower -eq 'enter' -or $lower -eq 'return') { $mainKey = 0x0D; continue }
    if ($lower -eq 'tab') { $mainKey = 0x09; continue }
    throw "Unsupported hotkey token: $token"
  }
  if ($mainKey -eq 0) { throw "Hotkey '$Spec' has no main key" }
  return @{ Modifiers = $modifiers; Key = $mainKey }
}

function Get-ClipboardBitmap {
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    try {
      $bitmap = [System.Windows.Forms.Clipboard]::GetImage()
      if ($null -ne $bitmap) { return $bitmap }
    } catch { }
    Start-Sleep -Milliseconds 120
  }
  return $null
}

function Save-BitmapResult {
  param([System.Drawing.Image]$Bitmap)
  $directory = [System.IO.Path]::GetDirectoryName($OutFile)
  if (-not [string]::IsNullOrEmpty($directory) -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $width = $Bitmap.Width
  $height = $Bitmap.Height
  $Bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $Bitmap.Dispose()
  $bytes = (Get-Item -LiteralPath $OutFile).Length
  Write-Result @{ ok = $true; path = $OutFile; width = $width; height = $height; bytes = $bytes }
  exit 0
}

try {
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $hotkeyKeys = Get-HotkeyVirtualKeys -Spec $Hotkey
  $sequenceBefore = [QQShotNative]::GetClipboardSequenceNumber()

  foreach ($modifier in $hotkeyKeys.Modifiers) { [QQShotNative]::SendKey([uint16]$modifier, $false); Start-Sleep -Milliseconds 24 }
  [QQShotNative]::SendKey([uint16]$hotkeyKeys.Key, $false)
  Start-Sleep -Milliseconds 60
  [QQShotNative]::SendKey([uint16]$hotkeyKeys.Key, $true)
  for ($index = $hotkeyKeys.Modifiers.Count - 1; $index -ge 0; $index--) {
    [QQShotNative]::SendKey([uint16]$hotkeyKeys.Modifiers[$index], $true)
    Start-Sleep -Milliseconds 24
  }

  $startDeadline = (Get-Date).AddSeconds($StartTimeoutSec)
  $overlaySeen = $false
  while ((Get-Date) -lt $startDeadline) {
    if ([QQShotNative]::OverlayOpen($virtual.Width, $virtual.Height)) { $overlaySeen = $true; break }
    Start-Sleep -Milliseconds 120
  }

  Write-DebugLine ("overlaySeen=" + $overlaySeen + " hotkey=" + $Hotkey + " seqBefore=" + $sequenceBefore)
  Write-DebugLine ([QQShotNative]::Describe($virtual.Width, $virtual.Height))

  if (-not $overlaySeen) {
    Write-Result @{ ok = $false; code = 'no-overlay'; message = 'QQ screenshot overlay did not appear' }
    exit 0
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $absentChecks = 0
  $openedAt = Get-Date
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 150

    $sequenceNow = [QQShotNative]::GetClipboardSequenceNumber()
    if ($sequenceNow -ne $sequenceBefore) {
      Write-DebugLine ("clipboard changed: " + $sequenceBefore + " -> " + $sequenceNow)
      $bitmap = Get-ClipboardBitmap
      if ($null -ne $bitmap) { Save-BitmapResult -Bitmap $bitmap }
    }

    if ([QQShotNative]::OverlayOpen($virtual.Width, $virtual.Height)) {
      $absentChecks = 0
    }
    else {
      $absentChecks++
    }

    if ($absentChecks -ge 4) {
      # The overlay is gone; give QQ a moment to finish copying the bitmap.
      $clipboardDeadline = (Get-Date).AddSeconds(3)
      while ((Get-Date) -lt $clipboardDeadline) {
        $bitmap = Get-ClipboardBitmap
        if ($null -ne $bitmap) { Save-BitmapResult -Bitmap $bitmap }
        Start-Sleep -Milliseconds 150
      }
      Write-DebugLine ("overlay closed after " + [int]((Get-Date) - $openedAt).TotalMilliseconds + "ms; seq=" + [QQShotNative]::GetClipboardSequenceNumber())
      Write-DebugLine ([QQShotNative]::Describe($virtual.Width, $virtual.Height))
      Write-Result @{ ok = $false; code = 'cancelled'; message = 'QQ overlay closed without a copied image' }
      exit 0
    }
  }

  Write-Result @{ ok = $false; code = 'timeout'; message = 'Timed out waiting for the QQ capture to finish' }
  exit 0
}
catch {
  Write-Result @{ ok = $false; code = 'error'; message = $_.Exception.Message }
  exit 0
}
