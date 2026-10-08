/**
 * LOCAL PATCH (toggleable): master switch for WSL integration.
 *
 * Why: every WSL entry point spawns `wsl.exe`, which boots the WSL2 VM (VmmemWSL) and can
 * hoard 1.5-5.5GB RAM on a 16GB machine. Pure-Windows use never needs WSL. Default is
 * DISABLED; flip the "WSL integration" switch in Settings → Terminal to opt back into
 * upstream behaviour.
 *
 * Why a module-level flag instead of reading the store: the WSL stack sits outside the
 * dependency-injection chain and cannot reach the Store. The startup foundation pushes the
 * persisted value in via setWslIntegrationEnabled() and keeps it in sync.
 *
 * Why a leaf module rather than living in `wsl.ts`: `wsl.ts` and `wsl-availability.ts` both
 * need the flag, and `wsl.ts` already imports `wsl-availability`, so holding it in either
 * would make that pair a cycle.
 */
let wslIntegrationEnabled = false

export function setWslIntegrationEnabled(enabled: boolean): void {
  wslIntegrationEnabled = enabled
}

export function isWslIntegrationEnabled(): boolean {
  return wslIntegrationEnabled
}
