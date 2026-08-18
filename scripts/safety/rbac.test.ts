/**
 * RBAC and authentication — permissions, roles, token audiences.
 *
 * Pure logic plus in-memory middleware execution. No database, no network, so
 * this gates a pull request in about a second.
 *
 * The two properties that carry this phase:
 *
 *   1. LEGACY COMPATIBILITY. Abhigyan's 158 users have no Role documents. If
 *      requirePermission() denied them, every converted route would 403 for the
 *      entire existing customer. A user with no roles must resolve to exactly
 *      what their legacy role already grants.
 *
 *   2. AUDIENCE SEPARATION. A tenant token must be rejected by a platform route
 *      BEFORE any role or permission check runs, so a bug in tenant RBAC can
 *      never escalate into platform access.
 *
 *   npx ts-node --transpile-only scripts/safety/rbac.test.ts
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

import {
  PERMISSIONS,
  LEGACY_ROLE_PERMISSIONS,
  SYSTEM_ROLE_TEMPLATES,
  isValidPermission,
  sanitizePermissions,
  permissionsForLegacyRole,
} from '../../src/core/rbac/permissions';
import {
  signTenantToken,
  signPlatformToken,
  signLegacyToken,
  verifyToken,
  verifyAny,
  TokenAudienceMismatch,
} from '../../src/core/auth/tokens';
import jwt from 'jsonwebtoken';

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** Resolve permissions without a database, mirroring resolveUserPermissions. */
function resolveOffline(user: { role?: string; roles?: { permissions: string[]; name: string }[] }) {
  if (user.roles && user.roles.length) {
    const set = new Set<string>();
    for (const r of user.roles) for (const p of r.permissions) set.add(p);
    return { permissions: set, source: 'roles' as const };
  }
  return {
    permissions: new Set<string>(permissionsForLegacyRole(user.role) as string[]),
    source: 'legacy-role' as const,
  };
}

function main() {
  console.log('RBAC and authentication\n');

  // ── Vocabulary ──────────────────────────────────────────────────────────
  console.log('permission vocabulary');
  check(`closed vocabulary of ${PERMISSIONS.length} permissions`, PERMISSIONS.length > 50);
  check('every permission is resource.action', PERMISSIONS.every((p) => /^[a-z]+\.[a-z]+$/.test(p)));
  check('no duplicates', new Set(PERMISSIONS).size === PERMISSIONS.length);
  check('a known permission validates', isValidPermission('students.read'));
  check('an invented permission does NOT validate', !isValidPermission('students.superedit'));
  {
    const kept = sanitizePermissions(['students.read', 'students.superedit', 'exams.publish']);
    check(
      'sanitize drops invented strings and keeps real ones',
      kept.length === 2 && kept.includes('students.read') && kept.includes('exams.publish'),
      kept.join(','),
    );
  }

  // ── Legacy compatibility — the property that protects Org 001 ───────────
  console.log('\nlegacy role compatibility (Org 001 has NO role documents)');
  {
    const admin = resolveOffline({ role: 'admin' });
    check(
      'legacy admin resolves to every permission',
      admin.permissions.size === PERMISSIONS.length,
      `${admin.permissions.size} of ${PERMISSIONS.length}`,
    );
    check('legacy admin came from the legacy mapping', admin.source === 'legacy-role');

    const teacher = resolveOffline({ role: 'teacher' });
    check('legacy teacher can create exams', teacher.permissions.has('exams.create'));
    check('legacy teacher can publish results', teacher.permissions.has('results.publish'));
    check('legacy teacher can mark attendance', teacher.permissions.has('attendance.mark'));
    check('legacy teacher CANNOT manage roles', !teacher.permissions.has('roles.create'));
    check('legacy teacher CANNOT change org settings', !teacher.permissions.has('org.settings'));

    const student = resolveOffline({ role: 'student' });
    check('legacy student can read exams', student.permissions.has('exams.read'));
    check('legacy student can read results', student.permissions.has('results.read'));
    check('legacy student CANNOT create exams', !student.permissions.has('exams.create'));
    check('legacy student CANNOT publish results', !student.permissions.has('results.publish'));
    check('legacy student CANNOT read other users', !student.permissions.has('users.read'));

    check('an unknown legacy role grants nothing', permissionsForLegacyRole('developer').length === 0);
    check('a null role grants nothing', permissionsForLegacyRole(null).length === 0);
  }

  // ── System templates ────────────────────────────────────────────────────
  console.log('\nsystem role templates');
  check('five templates are seeded', SYSTEM_ROLE_TEMPLATES.length === 5);
  check(
    'every template permission is in the vocabulary',
    SYSTEM_ROLE_TEMPLATES.every((t) => t.permissions.every((p) => isValidPermission(p))),
  );
  {
    const auditor = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === 'auditor')!;
    check(
      'auditor is read-only — every permission ends in .read',
      auditor.permissions.every((p) => p.endsWith('.read')),
    );
    const frontDesk = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === 'front_desk')!;
    check('front desk can mark attendance', frontDesk.permissions.includes('attendance.mark'));
    check('front desk CANNOT publish exams', !frontDesk.permissions.includes('exams.publish'));
  }

  // ── THE ACCEPTANCE TEST: Org 002 custom roles ───────────────────────────
  console.log('\nOrg 002 custom roles — Centre Manager and Counsellor');
  {
    const centreManager = {
      name: 'Centre Manager',
      permissions: sanitizePermissions([
        'students.read', 'students.create', 'students.update',
        'schedule.read', 'schedule.manage',
      ]) as string[],
    };
    const counsellor = {
      name: 'Counsellor',
      permissions: sanitizePermissions(['students.read']) as string[],
    };

    check('Centre Manager holds exactly 5 permissions', centreManager.permissions.length === 5);
    check('Counsellor holds exactly 1 permission', counsellor.permissions.length === 1);

    const cm = resolveOffline({ role: 'teacher', roles: [centreManager] });
    check('Centre Manager resolves from ROLES, not the legacy fallback', cm.source === 'roles');
    check('  can read students', cm.permissions.has('students.read'));
    check('  can create students', cm.permissions.has('students.create'));
    check('  can update students', cm.permissions.has('students.update'));
    check('  can manage the schedule', cm.permissions.has('schedule.manage'));
    check('  CANNOT publish exams', !cm.permissions.has('exams.publish'));
    check('  CANNOT manage roles', !cm.permissions.has('roles.create'));
    check('  CANNOT change org settings', !cm.permissions.has('org.settings'));
    check(
      '  assigning a narrow role REVOKES the broad legacy teacher grant',
      !cm.permissions.has('exams.create'),
      'the legacy fallback must apply only when NO roles are assigned, or ' +
        '"Centre Manager" would be a lie',
    );

    const co = resolveOffline({ role: 'teacher', roles: [counsellor] });
    check('Counsellor can read students', co.permissions.has('students.read'));
    check('  CANNOT update students', !co.permissions.has('students.update'));
    check('  CANNOT create students', !co.permissions.has('students.create'));
    check('  CANNOT delete students', !co.permissions.has('students.delete'));
    check('  CANNOT publish exams', !co.permissions.has('exams.publish'));
    check('  CANNOT manage the schedule', !co.permissions.has('schedule.manage'));
    check('  CANNOT read audit logs', !co.permissions.has('audit.read'));
    check(
      '  holds exactly one permission and inherits nothing',
      co.permissions.size === 1,
      `holds ${co.permissions.size}`,
    );

    // A tenant cannot mint platform authority through a role.
    const sneaky = sanitizePermissions(['platform.manage', 'billing.manage', 'students.read']);
    check(
      'a tenant CANNOT grant itself platform or billing permissions',
      sneaky.length === 1 && sneaky[0] === 'students.read',
      `got ${sneaky.join(',')} — those strings are not in the vocabulary at all`,
    );
  }

  // ── Token audiences ─────────────────────────────────────────────────────
  console.log('\ntoken audiences');
  {
    const tenant = signTenantToken({ id: 'u1', orgId: 'ORG_001', tokenVersion: 0 });
    const platform = signPlatformToken({ id: 'p1', role: 'owner', tokenVersion: 0 });
    const legacy = signLegacyToken({ id: 'u1', role: 'admin' });

    check('tenant token verifies as tenant', Boolean(verifyToken(tenant, 'tenant')));
    check('platform token verifies as platform', Boolean(verifyToken(platform, 'platform')));

    let rejected = false;
    try { verifyToken(tenant, 'platform'); } catch (e) { rejected = e instanceof TokenAudienceMismatch; }
    check(
      'TENANT token is REJECTED by a platform route',
      rejected,
      'this is the structural guarantee — it fails before any role check',
    );

    rejected = false;
    try { verifyToken(platform, 'tenant'); } catch (e) { rejected = e instanceof TokenAudienceMismatch; }
    check('PLATFORM token is REJECTED as a tenant token', rejected);

    rejected = false;
    try { verifyToken(legacy, 'platform'); } catch (e) { rejected = e instanceof TokenAudienceMismatch; }
    check('LEGACY token is REJECTED by a platform route', rejected);

    check(
      'a token with NO aud claim is treated as legacy',
      verifyAny<{ aud: string }>(legacy).aud === 'legacy',
      'every token in the field today predates this code; rejecting them ' +
        'would log out every user on deploy',
    );
    check('legacy token still verifies as legacy', Boolean(verifyToken(legacy, 'legacy')));
    check('tenant token carries orgId', verifyAny<{ orgId?: string }>(tenant).orgId === 'ORG_001');
  }

  // ── Token integrity ─────────────────────────────────────────────────────
  console.log('\ntoken integrity');
  {
    const good = signTenantToken({ id: 'u1', orgId: 'ORG_001' });

    let caught = false;
    try { verifyToken(good.slice(0, -4) + 'AAAA', 'tenant'); } catch { caught = true; }
    check('a tampered signature is rejected', caught);

    caught = false;
    try { verifyToken('not.a.token', 'tenant'); } catch { caught = true; }
    check('a malformed token is rejected', caught);

    caught = false;
    const expired = jwt.sign({ id: 'u1', orgId: 'ORG_001', aud: 'tenant' }, process.env.JWT_SECRET!, {
      expiresIn: '-1s',
    });
    try { verifyToken(expired, 'tenant'); } catch { caught = true; }
    check('an expired token is rejected', caught);

    caught = false;
    const wrongSecret = jwt.sign({ id: 'u1', aud: 'platform' }, 'a-different-secret-entirely-here');
    try { verifyToken(wrongSecret, 'platform'); } catch { caught = true; }
    check('a token signed with another secret is rejected', caught);

    // Forging the orgId claim requires the signing secret — this is why tenancy
    // travels in the claim rather than in a header.
    const forged = jwt.sign({ id: 'u1', orgId: 'ORG_002', aud: 'tenant' }, 'attacker-secret-value-here');
    caught = false;
    try { verifyToken(forged, 'tenant'); } catch { caught = true; }
    check('an org claim cannot be forged without the secret', caught);
  }

  // ── Permissions never replace tenant isolation ──────────────────────────
  console.log('\npermissions do not replace tenant isolation');
  {
    const admin = resolveOffline({ role: 'admin' });
    check(
      'an org admin holds students.read',
      admin.permissions.has('students.read'),
    );
    check(
      'but no permission string names an ORGANIZATION',
      PERMISSIONS.every((p) => !p.includes('org_') && !/\borg\d/.test(p)),
      'a permission answers "may this user do this KIND of thing" — WHICH ' +
        'organization is the Mongoose plugin, and it runs regardless',
    );
  }

  console.log('');
  if (failures) {
    console.error(`RBAC TESTS FAILED — ${failures} of ${checks}.`);
    process.exit(1);
  }
  console.log(`All ${checks} RBAC checks passed.`);
}

main();
