/**
 * The platform runtime: the organization platform, as a child of the main
 * process — see realm.ts for why it is a separate process at all.
 *
 * The main process (the existing system, /api/*) starts it when
 * PLATFORM_MONGODB_URI is configured, and forwards /platform-api/* to it
 * (platformGateway.ts). The runtime listens on loopback only, on a port the OS
 * picks, and reports that port back over IPC once it is serving. If it exits,
 * /platform-api/* answers 503 while it is restarted — /api/* never notices.
 */

import { fork, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import { databaseNameOf, platformDatabaseUri, platformRuntimeEnv } from './realm';

export const RUNTIME_LISTENING = 'platform-realm:listening';
export const RUNTIME_SHUTDOWN = 'platform-realm:shutdown';

interface RuntimeState {
  configured: boolean;
  port: number | null;
  gatewayKey: string;
  child: ChildProcess | null;
  stopping: boolean;
  restarts: number;
}

const state: RuntimeState = {
  configured: false,
  port: null,
  // Per boot, never configured: it exists only between this process and its
  // own child, so there is nothing to leak or rotate.
  gatewayKey: crypto.randomBytes(32).toString('hex'),
  child: null,
  stopping: false,
  restarts: 0,
};

/** Where /platform-api/* goes right now. `port: null` means starting or restarting. */
export function platformRuntimeTarget(): { configured: boolean; port: number | null; gatewayKey: string } {
  return { configured: state.configured, port: state.port, gatewayKey: state.gatewayKey };
}

/**
 * Start the platform runtime when the platform is configured.
 *
 * @param configured  the operator's environment (dataSource.configuredEnv())
 * @param options.entry    the file to run: this process's own entry point
 * @param options.primary  whether this runtime may run singleton work — the
 *                         same answer this process gives for its own cron
 * @returns false when PLATFORM_MONGODB_URI is not set (nothing started)
 * @throws RealmConfigurationError for a platform configuration that must not start
 */
export function startPlatformRuntime(
  configured: NodeJS.ProcessEnv,
  options: { entry: string; primary: boolean },
): boolean {
  if (!platformDatabaseUri(configured)) {
    state.configured = false;
    return false;
  }
  const env = platformRuntimeEnv(configured, { primary: options.primary, gatewayKey: state.gatewayKey });
  state.configured = true;
  state.stopping = false;
  spawn(env, options.entry);
  return true;
}

function spawn(env: NodeJS.ProcessEnv, entry: string): void {
  // Under ts-node (development) the entry is TypeScript; a built deployment
  // runs the bundle. The parent's own execArgv is deliberately NOT inherited:
  // it can carry a debugger port or a file watcher that must not be doubled.
  const execArgv = entry.endsWith('.ts') ? ['-r', require.resolve('ts-node/register/transpile-only')] : [];
  const child = fork(entry, [], { env, execArgv, stdio: 'inherit' });
  state.child = child;

  child.on('message', (message: unknown) => {
    const msg = message as { type?: string; port?: unknown } | null;
    if (msg && msg.type === RUNTIME_LISTENING && typeof msg.port === 'number') {
      state.port = msg.port;
      state.restarts = 0;
      console.log(
        `✅ [platform] /platform-api/* → platform runtime on 127.0.0.1:${msg.port} (database "${databaseNameOf(env.MONGO_URI)}")`,
      );
    }
  });

  child.on('exit', (code, signal) => {
    state.port = null;
    if (state.child === child) state.child = null;
    if (state.stopping) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(state.restarts, 5));
    state.restarts += 1;
    console.error(
      `❌ [platform] the platform runtime exited (${signal || `code ${code}`}); /platform-api/* answers 503 until it restarts in ${delay}ms. /api/* is unaffected.`,
    );
    setTimeout(() => {
      if (!state.stopping) spawn(env, entry);
    }, delay).unref();
  });
}

/** Stop the runtime: ask first (a signal cannot be handled on Windows), then insist. */
export async function stopPlatformRuntime(timeoutMs = 8_000): Promise<void> {
  state.stopping = true;
  state.port = null;
  const child = state.child;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      if (child.connected) child.send({ type: RUNTIME_SHUTDOWN });
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  });
}
