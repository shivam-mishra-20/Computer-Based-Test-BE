/**
 * Registers the tenant plugin globally.
 *
 * ── This module MUST be imported before any model ────────────────────────────
 * `mongoose.plugin()` applies only to schemas compiled AFTER the call. Models
 * compile at import time, so importing a model before this runs silently
 * produces a model with no `orgId` field and no scoping hooks — and it fails
 * silently, which is the worst possible failure for a security control.
 *
 * Every entrypoint therefore imports this first:
 *   src/server.ts · src/workers/*.ts · scripts that touch models
 *
 * `verifyTenantPluginApplied()` exists because "must be imported first" is a
 * convention, and conventions get broken by whoever adds the next entrypoint at
 * 2am. It converts a silent security hole into a loud startup failure.
 */

import mongoose from 'mongoose';
import { tenantPlugin } from './plugin';
import {
  describeTenancy,
  isExplicitlyPinned,
  pinnedOrgId,
  tenantEnforcement,
  tenantMode,
} from './config';

let registered = false;

export function registerTenancy(): void {
  if (registered) return;
  registered = true;

  mongoose.plugin(tenantPlugin);

  console.log(`[tenancy] plugin registered — ${describeTenancy()}`);

  if (tenantMode() === 'pinned' && !pinnedOrgId()) {
    // ── Two very different situations, and the log has to tell them apart ──
    // `tenantMode()` DEFAULTS to 'pinned', so this branch is reached both by a
    // deployment that asked for pinned mode and forgot ORG_ID, and by one that
    // has never been configured for tenancy at all.
    //
    // Only the first is a fault. `tenantContextMiddleware` checks the same
    // distinction and 503s only when the mode was set EXPLICITLY; an
    // unconfigured deployment takes the pre-migration path and serves exactly
    // as it did before this code existed.
    //
    // The message used to say "Requests will fail" in both cases. On the live
    // legacy deployment — which sets no TENANT_* variables — that was untrue,
    // and it read as an outage during an unrelated investigation. A warning
    // that cries wolf is worse than no warning, so each case now says what is
    // actually true of it.
    if (isExplicitlyPinned()) {
      console.warn(
        '[tenancy] TENANT_MODE=pinned but ORG_ID is unset. ' +
          'Requests WILL fail with 503 until ORG_ID names a real organization.',
      );
    } else {
      console.info(
        '[tenancy] No TENANT_MODE set — running pre-migration, unscoped, exactly as before. ' +
          'This is expected for the legacy deployment. Do not set ORG_ID until an ' +
          'organization exists to point it at.',
      );
    }
  }

  if (tenantEnforcement() === 'off') {
    console.warn(
      '[tenancy] TENANT_ENFORCEMENT=off — no scoping and no observation. ' +
        'This is an emergency escape hatch, not a normal setting.',
    );
  }
}

/**
 * Assert every compiled model actually carries the plugin.
 *
 * Run after all models are loaded. A model listed here as missing was imported
 * before `registerTenancy()` — its queries are unscoped and always will be, and
 * no amount of enforcement configuration will change that.
 */
export function verifyTenantPluginApplied(): { ok: boolean; missing: string[]; exempt: string[] } {
  const missing: string[] = [];
  const exempt: string[] = [];

  for (const name of mongoose.modelNames()) {
    const schema = mongoose.model(name).schema;
    if ((schema.options as Record<string, unknown>).tenantScoped === false) {
      exempt.push(name);
      continue;
    }
    if (!schema.path('orgId')) missing.push(name);
  }

  if (missing.length) {
    console.error(
      `[tenancy] ${missing.length} model(s) compiled WITHOUT tenant scoping: ${missing.join(', ')}\n` +
        `[tenancy] They were imported before registerTenancy(). Their queries are unscoped.`,
    );

    // Under enforce, an unscoped model is a live cross-tenant hole and booting
    // anyway would serve one customer another's data. Refuse.
    //
    // Under warn, nothing is enforced yet and no isolation is being relied on,
    // so refusing to boot would take production down to protect a guarantee
    // that is not yet in effect. Log loudly and keep serving — the migration
    // gate is "warn log clean", which this feeds.
    if (tenantEnforcement() === 'enforce') {
      throw new Error(
        `[tenancy] Refusing to start under TENANT_ENFORCEMENT=enforce with ` +
          `${missing.length} unscoped model(s): ${missing.join(', ')}`,
      );
    }
  } else {
    console.log(
      `[tenancy] verified — ${mongoose.modelNames().length - exempt.length} scoped model(s), ` +
        `${exempt.length} exempt (${exempt.join(', ') || 'none'})`,
    );
  }

  return { ok: missing.length === 0, missing, exempt };
}
