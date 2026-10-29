import cron from 'node-cron';
import { runLifecycleSweep } from '../core/subscriptions/service';
import { serviceRealm } from '../core/realm/realm';

/**
 * The daily subscription sweep: trials that ended, periods that ran out, grace
 * periods that elapsed. Platform runtime only — the existing system has no
 * organizations and no subscriptions.
 *
 * Not the only thing that moves the clock. Every entitlement read past a
 * subscription's next transition re-resolves it (core/entitlements/resolve.ts),
 * so a trial ends on time even where this job is switched off — which, in the
 * platform runtime, is the default (PLATFORM_ENABLE_CRON). This job makes the
 * change happen for organizations nobody is using, so the console's lists and
 * the subscription history are current without waiting for a sign-in.
 *
 * Idempotent: each subscription moves under a conditional write, so a second
 * run — or a request racing the run — finds nothing left to do.
 */
export class SubscriptionLifecycleCron {
  private static initialized = false;
  private static readonly SWEEP_CRON = '15 0 * * *'; // 00:15 IST

  /**
   * Whether this process should schedule the sweep at all, once cron itself is
   * allowed (server.ts `cronSkipReason`: ENABLE_CRON, the singleton, the
   * cluster leader). Platform runtime only — and in the platform runtime
   * ENABLE_CRON is derived from PLATFORM_ENABLE_CRON, default off
   * (core/realm/realm.ts `platformRuntimeEnv`).
   */
  public static shouldRun(env: NodeJS.ProcessEnv = process.env): boolean {
    return serviceRealm(env) === 'platform' && env.ENABLE_CRON !== 'false';
  }

  public static init(): void {
    if (this.initialized) return;

    cron.schedule(
      this.SWEEP_CRON,
      async () => {
        try {
          const summary = await runLifecycleSweep(new Date());
          console.log(
            `[SubscriptionLifecycleCron] examined ${summary.examined}, advanced ${summary.advanced}, failed ${summary.failed}`,
          );
          for (const error of summary.errors.slice(0, 20)) console.error(`[SubscriptionLifecycleCron] ${error}`);
          const r = summary.renewals as { invoiced?: number; charged?: number; reminded?: number; errors?: string[] } | undefined;
          if (r) {
            console.log(`[SubscriptionLifecycleCron] renewals: invoiced ${r.invoiced ?? 0}, charged ${r.charged ?? 0}, reminded ${r.reminded ?? 0}`);
            for (const error of (r.errors ?? []).slice(0, 20)) console.error(`[SubscriptionLifecycleCron] ${error}`);
          }
        } catch (error) {
          console.error('[SubscriptionLifecycleCron] sweep failed:', (error as Error).message);
        }
      },
      { timezone: 'Asia/Kolkata' },
    );

    this.initialized = true;
    console.log('[SubscriptionLifecycleCron] Scheduled the 00:15 IST subscription sweep');
  }
}
