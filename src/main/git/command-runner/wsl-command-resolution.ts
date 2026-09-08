import {
  getDefaultWslDistro,
  isWslIntegrationEnabled,
  parseWslPath,
  type WslPathInfo
} from '../../wsl'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs,
  buildWslLoginShellCommand,
  quotePosixShell,
  type WslCapturedLoginShellCommand
} from '../../../shared/wsl-login-shell-command'
import { UNTRANSLATED_GIT_OUTPUT_ENV } from '../../../shared/git-output-locale'
import type { WslGitReadEnvironment } from '../wsl-git-read-environment'
import {
  createWslProcessGroupTermination,
  type WslProcessGroupTermination
} from '../wsl-process-group-termination'
import { translateArgForWsl, translateArgsForWsl } from './wsl-path-translation'
import { resolveWslInteropSpawnCwd } from '../../wsl-interop-spawn-directory'

// Env-assignment prefix for WSL-routed git, where spawn env can't cross the wsl.exe boundary; values are shell-safe unquoted.
const GIT_OUTPUT_LOCALE_SHELL_PREFIX = Object.entries(UNTRANSLATED_GIT_OUTPUT_ENV)
  .map(([key, value]) => `${key}=${value}`)
  .join(' ')
const GIT_OUTPUT_LOCALE_ENV_ARGS = Object.entries(UNTRANSLATED_GIT_OUTPUT_ENV).map(
  ([key, value]) => `${key}=${value}`
)

export type ResolvedCommand = {
  binary: string
  args: string[]
  cwd: string | undefined
  /** Non-null when the command was routed through WSL. */
  wsl: WslPathInfo | null
  wslMode: 'direct-git' | 'login-shell' | 'non-login-shell' | null
  /** Present only when the caller opted into a fenced login-shell read. */
  captured?: WslCapturedLoginShellCommand
  termination?: WslProcessGroupTermination
}

let defaultWslDistroOverride: string | null = null

// Why: allow host commands fallback to route through the user's pinned WSL distro when host execution fails.
export function setDefaultWslDistroOverride(distro: string | null): void {
  // LOCAL PATCH (toggleable): honoring a persisted distro would let the startup gh
  // check route into `wsl.exe -d <distro> --exec bash` and boot the VM even though
  // distro discovery is off. When WSL is disabled, gh/glab stay on the host.
  defaultWslDistroOverride = isWslIntegrationEnabled() ? distro : null
}

/**
 * LOCAL PATCH (toggleable): per-command WSL routing policy.
 *
 * Why: `resolveDefaultWslCli` resolves a distro BEFORE deciding whether the command
 * actually needs WSL, and resolving a distro spawns `wsl.exe --list --quiet` — which
 * boots the WSL2 VM (VmmemWSL). A global `gh` call such as the startup star-nag check
 * therefore wakes the VM just to run a command the host could answer. Denying the
 * command up front skips BOTH the distro probe and the routed exec.
 *
 * ORCA_WSL_ALLOW_COMMANDS=gh,glab -> allow-list mode: anything not listed is denied.
 * ORCA_WSL_DENY_COMMANDS=gh,glab  -> deny-list mode: listed commands never route via WSL;
 *                                    unlisted commands keep upstream behaviour.
 * Set neither for stock upstream behaviour. Allow-list wins when both are set.
 *
 * Scope: only guards the no-cwd CLI fallback (gh/glab). Commands run inside a WSL
 * working directory go through resolveCommand() and are NOT affected — deliberately,
 * since opening a terminal in a WSL repo is an explicit user action.
 */
function parseWslCommandEnvList(raw: string | undefined): Set<string> | null {
  if (raw === undefined) {
    return null
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
  return entries.length > 0 ? new Set(entries) : null
}

function isWslCommandBlocked(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  const allowList = parseWslCommandEnvList(process.env.ORCA_WSL_ALLOW_COMMANDS)
  if (allowList) {
    return !allowList.has(normalized)
  }
  const denyList = parseWslCommandEnvList(process.env.ORCA_WSL_DENY_COMMANDS)
  if (denyList) {
    return denyList.has(normalized)
  }
  return false
}

export function resolveDefaultWslCli(
  command: 'gh' | 'glab',
  args: string[]
): ResolvedCommand | null {
  // Why ahead of getDefaultWslDistro(): resolving a distro spawns `wsl.exe --list --quiet`
  // and boots the WSL2 VM. A blocked command must short-circuit before that probe, or
  // the check would itself wake the very thing it exists to keep asleep.
  if (isWslCommandBlocked(command)) {
    return null
  }
  const distro = defaultWslDistroOverride ?? getDefaultWslDistro()
  return distro ? resolveCommand(command, args, undefined, distro) : null
}

/**
 * Resolve whether a command invocation should be routed through wsl.exe.
 *
 * Why `bash -c "cd … && …"` instead of `--cd`: wsl.exe's --cd fails with
 * ERROR_PATH_NOT_FOUND under Node's execFile/spawn in some configs.
 */
export function resolveCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  wslDistroOverride?: string,
  options: {
    useWslLoginShell?: boolean
    captureLoginShellOutput?: boolean
    wslGitReadEnvironment?: WslGitReadEnvironment
    env?: NodeJS.ProcessEnv
    terminationBarrier?: boolean
    /** Pre-quoted shell expression that names the program inside WSL, replacing `command`. */
    wslShellCommand?: string
    /**
     * Exit with this code when the `cd` fails, instead of letting `&&` swallow it as the shell's
     * own exit 1. Why: ripgrep also exits 1 for "no matches", so an unreachable workspace would
     * otherwise be indistinguishable from an empty result.
     */
    cwdFailureExitCode?: number
  } = {}
): ResolvedCommand {
  if (process.platform !== 'win32') {
    return { binary: command, args, cwd, wsl: null, wslMode: null }
  }

  // Why: global gh callers (rate_limit, listAccessibleProjects) have no cwd to derive a distro from; a distro hint still routes through wsl.exe.
  // TODO(wsl-default-distro): no default-distro setting yet, so override-less global gh callers fall back to host gh.exe (ENOENT on WSL-only installs).
  const cwdWsl = cwd ? parseWslPath(cwd) : null
  const wsl: WslPathInfo | null =
    cwdWsl ?? (wslDistroOverride ? { distro: wslDistroOverride, linuxPath: '' } : null)
  if (!wsl) {
    return { binary: command, args, cwd, wsl: null, wslMode: null }
  }

  const translatedArgs = translateArgsForWsl(args)
  // Why: env on wsl.exe stays Windows-side (WSLENV forwards only named vars), so the locale must ride the command string (issue #7808).
  const localePrefix = command === 'git' ? `${GIT_OUTPUT_LOCALE_SHELL_PREFIX} ` : ''
  const escapedCommand = options.wslShellCommand ?? quotePosixShell(command)
  // Why: shell-escape each arg to prevent word splitting / glob expansion inside the bash -c string.
  const escapedArgs = translatedArgs.map(quotePosixShell)
  // Why: prepend `cd <linuxPath> &&` for a UNC cwd; skip it when only a distro override was given (global gh needs no cwd).
  const linuxCwd = cwdWsl?.linuxPath ?? (cwd && wslDistroOverride ? translateArgForWsl(cwd) : null)
  const invocation = `${localePrefix}${escapedCommand} ${escapedArgs.join(' ')}`
  const enterCwd = linuxCwd
    ? options.cwdFailureExitCode === undefined
      ? `cd ${quotePosixShell(linuxCwd)} && `
      : `cd ${quotePosixShell(linuxCwd)} || exit ${Math.trunc(options.cwdFailureExitCode)}; `
    : ''
  const shellCmd = `${enterCwd}${invocation}`

  if (command === 'git' && options.wslGitReadEnvironment) {
    const optionalLocks = options.env?.GIT_OPTIONAL_LOCKS
    return withWslProcessGroupTermination(
      {
        binary: 'wsl.exe',
        args: [
          '-d',
          wsl.distro,
          '--exec',
          '/usr/bin/env',
          `PATH=${options.wslGitReadEnvironment.path}`,
          `HOME=${options.wslGitReadEnvironment.home}`,
          ...GIT_OUTPUT_LOCALE_ENV_ARGS,
          ...(optionalLocks !== undefined ? [`GIT_OPTIONAL_LOCKS=${optionalLocks}`] : []),
          options.wslGitReadEnvironment.gitPath,
          ...(linuxCwd ? ['-C', linuxCwd] : []),
          ...translatedArgs
        ],
        cwd: resolveWslInteropSpawnCwd(),
        wsl,
        wslMode: 'direct-git'
      },
      options.terminationBarrier
    )
  }

  if (options.useWslLoginShell) {
    // Why opt-in: the login shell is interactive for bash/zsh, so its rc output
    // lands on stdout ahead of the payload. Callers that buffer the whole stream
    // fence it; streaming consumers (git grep, ls-files -z) must not, because a
    // marker would be glued onto their first record.
    if (options.captureLoginShellOutput) {
      const captured = buildWslCapturedLoginShellCommand(shellCmd)
      return withWslProcessGroupTermination(
        {
          binary: 'wsl.exe',
          args: buildWslExecArgs(wsl.distro, ['sh', '-lc', captured.command]),
          cwd: resolveWslInteropSpawnCwd(),
          wsl,
          wslMode: 'login-shell',
          captured
        },
        options.terminationBarrier
      )
    }
    return withWslProcessGroupTermination(
      {
        binary: 'wsl.exe',
        args: buildWslExecArgs(wsl.distro, ['sh', '-lc', buildWslLoginShellCommand(shellCmd)]),
        cwd: resolveWslInteropSpawnCwd(),
        wsl,
        wslMode: 'login-shell'
      },
      options.terminationBarrier
    )
  }

  return withWslProcessGroupTermination(
    {
      binary: 'wsl.exe',
      args: buildWslExecArgs(wsl.distro, ['bash', '-c', shellCmd]),
      // Why: the `cd` inside bash -c handles the Linux directory. This names an
      // explicit Windows directory anyway, because `undefined` makes
      // CreateProcessW inherit the parent's — which is a deletable WSL UNC path
      // when Orca was launched from a worktree (#16463).
      cwd: resolveWslInteropSpawnCwd(),
      wsl,
      wslMode: 'non-login-shell'
    },
    options.terminationBarrier
  )
}

function withWslProcessGroupTermination(
  command: ResolvedCommand,
  enabled: boolean | undefined
): ResolvedCommand {
  if (!enabled || !command.wsl) {
    return command
  }
  const execIndex = command.args.indexOf('--exec')
  if (execIndex === -1) {
    return command
  }
  const termination = createWslProcessGroupTermination(command.wsl.distro)
  return {
    ...command,
    args: [
      ...command.args.slice(0, execIndex + 1),
      ...termination.wrapGuestArgs(command.args.slice(execIndex + 1))
    ],
    termination
  }
}
