/**
 * Clicks the replay's Fog of War team dropdown. The Replay API has no field for it, so this
 * sends two left clicks (open, then the option) to the League window through PowerShell's
 * user32 calls: no native module. SendInput with mouse input structs was refused on this
 * machine (error 87); SetCursorPos + mouse_event works. The process is made DPI-aware so
 * the coordinates are physical pixels, the same ones the screen captures use.
 */
import { execFile } from "child_process";
import { fogDropdownClicks, FogView } from "../core/fogview";

const PS = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class LcFog {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
"@
[LcFog]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Name "League of Legends" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { "no-window"; exit }
if ([LcFog]::GetForegroundWindow() -ne $p.MainWindowHandle) {
  [LcFog]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [LcFog]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
  [LcFog]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 400
}
foreach ($pt in $env:LC_CLICKS.Split(";")) {
  $xy = $pt.Split(",")
  [LcFog]::SetCursorPos([int]$xy[0], [int]$xy[1]) | Out-Null; Start-Sleep -Milliseconds 150
  [LcFog]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
  [LcFog]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 700
}
"ok"
`;

/** Clicks the dropdown to `view`. Resolves with "ok", or "no-window" if League isn't running. */
export function clickFogView(view: FogView, screen: { w: number; h: number }): Promise<string> {
  const clicks = fogDropdownClicks(view, screen).map((p) => `${p.x},${p.y}`).join(";");
  return new Promise((resolve, reject) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS],
      { env: { ...process.env, LC_CLICKS: clicks }, timeout: 30_000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    ),
  );
}
