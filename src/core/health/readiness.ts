/**
 * Is this process able to serve — not merely alive.
 *
 * `GET /api/health` answers "healthy" whenever the HTTP server is up, which is
 * what the apps' connectivity check needs and must stay as it is. A load
 * balancer needs more: a process whose database connection has dropped, or
 * whose platform runtime (/platform-api) is crash-looping, still answered
 * "healthy" there and kept receiving traffic.
 *
 * `GET /api/health/ready` answers from the two things that decide it:
 *
 *   database   mongoose's connection state — 1 (connected) is the only "up".
 *   platform   the forked platform runtime, when this process starts one:
 *              up once it has reported its port; "starting" while it boots or
 *              restarts. A process that starts no runtime reports "n/a".
 *
 * It names states only — never a host, port, URI or key.
 *
 * Pure (state in, verdict out), so it is tested without a database:
 * scripts/safety/ops-hardening.test.ts.
 */

export type Check = 'up' | 'down' | 'starting' | 'n/a';

export interface ReadinessInput {
  /** mongoose.connection.readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting. */
  mongoReadyState: number;
  /** Whether this process forks a platform runtime, and whether it is listening. */
  platform: { configured: boolean; listening: boolean; restarts?: number };
}

export interface Readiness {
  ready: boolean;
  checks: { database: Check; platform: Check; platformRestarts?: number };
}

export function readinessOf(input: ReadinessInput): Readiness {
  const database: Check =
    input.mongoReadyState === 1
      ? 'up'
      : input.mongoReadyState === 2
        ? 'starting'
        : 'down';
  const platform: Check = !input.platform.configured
    ? 'n/a'
    : input.platform.listening
      ? 'up'
      : 'starting';
  return {
    ready: database === 'up' && (platform === 'up' || platform === 'n/a'),
    // Consecutive platform-runtime restarts: 0 when healthy, rising during a
    // crash loop. Informational — readiness is decided by the checks above.
    checks: input.platform.configured
      ? { database, platform, platformRestarts: input.platform.restarts ?? 0 }
      : { database, platform },
  };
}
