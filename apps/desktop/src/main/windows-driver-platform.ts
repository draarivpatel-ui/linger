import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AuthenticodeCheckResult,
  WindowsInstallerRunResult,
} from "./driver-updater.js";

const runFile = promisify(execFile);

const POWERSHELL = "powershell.exe";
const BASE_ARGS = ["-NoProfile", "-NonInteractive", "-Command"] as const;

/**
 * Probes the first NVIDIA graphics adapter display name on Windows via CIM.
 * Returns undefined when unavailable or on any command error.
 */
export async function detectWindowsNvidiaGpuName(): Promise<
  string | undefined
> {
  try {
    const { stdout } = await runFile(
      POWERSHELL,
      [
        ...BASE_ARGS,
        "Get-CimInstance -ClassName Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1 -ExpandProperty Name",
      ],
      {
        timeout: 10_000,
        windowsHide: true,
      },
    );
    const name = stdout.trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies a downloaded Windows executable's Authenticode signature using
 * Windows' native trust store. Passes the file path through an environment
 * variable to avoid shell quoting hazards.
 */
export async function verifyWindowsAuthenticode(
  exePath: string,
): Promise<AuthenticodeCheckResult> {
  try {
    const { stdout } = await runFile(
      POWERSHELL,
      [
        ...BASE_ARGS,
        "$sig = Get-AuthenticodeSignature -LiteralPath $env:LINGER_DRIVER_EXE; [PSCustomObject]@{ Status = [string]$sig.Status; Subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' } } | ConvertTo-Json -Compress",
      ],
      {
        env: { ...process.env, LINGER_DRIVER_EXE: exePath },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== "object") {
      return { valid: false };
    }
    const record = parsed as { Status?: unknown; Subject?: unknown };
    const status = typeof record.Status === "string" ? record.Status : "";
    const subject = typeof record.Subject === "string" ? record.Subject : "";
    return {
      valid: status === "Valid" && /\bNVIDIA Corporation\b/i.test(subject),
      subject,
    };
  } catch {
    return { valid: false };
  }
}

/**
 * Runs a verified NVIDIA Windows DCH installer with UAC elevation in silent,
 * non-rebooting mode (`-s -noreboot -noeula`) and classifies its exit code.
 */
export async function runWindowsDriverInstaller(
  exePath: string,
): Promise<WindowsInstallerRunResult> {
  try {
    const { stdout } = await runFile(
      POWERSHELL,
      [
        ...BASE_ARGS,
        "$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath $env:LINGER_DRIVER_EXE -ArgumentList @('-s','-noreboot','-noeula') -Verb RunAs -Wait -PassThru; Write-Output $p.ExitCode",
      ],
      {
        env: { ...process.env, LINGER_DRIVER_EXE: exePath },
        timeout: 30 * 60_000,
        windowsHide: true,
      },
    );
    const exitCode = Number.parseInt(stdout.trim(), 10);
    if (exitCode === 0) return { outcome: "completed" };
    if (exitCode === 1 || exitCode === 3010) {
      return { outcome: "reboot_required" };
    }
    return {
      outcome: "failed",
      exitCode: Number.isNaN(exitCode) ? undefined : exitCode,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
    const combined = `${detail}\n${stderr}`;
    if (
      /\b1223\b|cancel(?:ed|led)\s+by\s+the\s+user|operation\s+was\s+cancel(?:ed|led)/i.test(
        combined,
      )
    ) {
      return { outcome: "uac_cancelled" };
    }
    return { outcome: "failed" };
  }
}
