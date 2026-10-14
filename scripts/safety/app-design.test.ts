/**
 * App design requests — the rules, asserted without a database.
 *
 * ── What is being defended ──────────────────────────────────────────────────
 *   - the server stores a template REFERENCE plus validated overrides, and
 *     nothing else a client sends (tokens, styles, scripts, its own version)
 *   - who may do what, from which stage, comes from the mirrored lifecycle —
 *     an institute can never approve or activate, staff never act on a draft
 *   - a build compiles in only an activated design this platform version
 *     ships; a retired template is a readiness problem with a sentence, not a
 *     silent fall-back to the default look
 *
 * The database half (one open request per organization, the optimistic stage
 * guard, superseding the previous active design, the Org write) is exercised
 * end to end against the `test` database only.
 *
 *   npm run safety:app-design
 */

import mongoose from 'mongoose';
import {
  activeSelectionOf,
  designBuildProblem,
  designForBuildView,
  DesignRequestError,
  requestView,
  selectionFromInput,
} from '../../src/core/platform/appDesign';
import { TEMPLATES, templateById, transition, startDraft, type DesignStage } from '../../src/core/platform/design';
import type { IAppDesignRequest } from '../../src/models/AppDesignRequest';

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function throws(fn: () => unknown): DesignRequestError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof DesignRequestError ? err : null;
  }
}

console.log('\nCatalogue (mirrored)');
check('the server knows all twenty templates', TEMPLATES.length === 20, String(TEMPLATES.length));
check('ids are unique', new Set(TEMPLATES.map((t) => t.meta.id)).size === TEMPLATES.length);

console.log('\nWhat is stored');
const stored = selectionFromInput({
  templateId: 'executive-scholar',
  templateVersion: '9.9.9',
  overrides: { primaryColor: '#0B3D91', density: 'compact', appearance: 'neon', css: 'body{display:none}' },
  tokens: { text: '#ffffff' },
  script: '<script>alert(1)</script>',
});
check('the template version is the server’s, not the client’s', stored.templateVersion === templateById('executive-scholar')!.meta.version);
check('valid overrides are kept and normalized', stored.overrides.primaryColor === '#0b3d91' && stored.overrides.density === 'compact');
check('invalid override values are dropped', stored.overrides.appearance === undefined);
check('only the declared keys reach the record', Object.keys(stored).sort().join(',') === 'kind,overrides,schemaVersion,templateId,templateVersion');
check('undeclared override keys are dropped', Object.keys(stored.overrides).sort().join(',') === 'density,primaryColor');
const unknown = throws(() => selectionFromInput({ templateId: 'retired-template' }));
check('an unknown template is refused with 400', unknown?.status === 400 && unknown.code === 'DESIGN_TEMPLATE_UNKNOWN');
check('a missing body is refused', throws(() => selectionFromInput(null))?.status === 400);
check('a path-like id is refused', throws(() => selectionFromInput({ templateId: '../../etc/passwd' }))?.status === 400);

console.log('\nWho may do what');
function fakeRequest(stage: DesignStage): IAppDesignRequest {
  const now = new Date('2026-10-14T09:41:00Z');
  return {
    _id: new mongoose.Types.ObjectId(),
    orgId: new mongoose.Types.ObjectId(),
    organizationName: 'Northfield Academy',
    organizationSlug: 'northfield',
    stage,
    revision: 2,
    selection: stored,
    templateName: 'Executive Scholar',
    history: [],
    builds: [],
    createdAt: now,
    updatedAt: now,
  } as unknown as IAppDesignRequest;
}
const actionsAt = (stage: DesignStage) => requestView(fakeRequest(stage)).actions;
check('a draft offers the institute save and submit', actionsAt('draft').orgAdmin.sort().join(',') === 'save,submit');
check('a draft offers staff nothing', actionsAt('draft').platform.length === 0);
check('a submission offers the institute only withdraw', actionsAt('submitted').orgAdmin.join(',') === 'withdraw');
check('a submission offers staff request-changes, approve, reject', actionsAt('submitted').platform.sort().join(',') === 'approve,reject,request-changes');
check('an approved design offers staff activate', actionsAt('approved').platform.join(',') === 'activate');
check('an approved design offers the institute nothing', actionsAt('approved').orgAdmin.length === 0);
check('changes requested lets the institute edit again', actionsAt('changes-requested').orgAdmin.join(',') === 'save');
check('an active design offers no human action', actionsAt('active').orgAdmin.length === 0 && actionsAt('active').platform.length === 0);
const view = requestView(fakeRequest('submitted'));
check('a view names its template for the console', view.template?.name === 'Executive Scholar' && view.compatibility === 'exact');

const at = '2026-10-14T09:41:00.000Z';
const draft = startDraft(stored, at);
check('the institute cannot approve its own design', !transition({ ...draft, stage: 'submitted' }, 'approve', 'org-admin', at).ok);
check('staff cannot activate an unapproved design', !transition({ ...draft, stage: 'submitted' }, 'activate', 'platform-admin', at).ok);
check('the institute cannot activate an approved design', !transition({ ...draft, stage: 'approved' }, 'activate', 'org-admin', at).ok);

console.log('\nWhat a build compiles in');
check('no activated design builds the default look', activeSelectionOf({}) === null && designBuildProblem({}) === null && designForBuildView({}) === null);
const activeOrg = { appDesign: { active: { requestId: 'r1', selection: stored, templateName: 'Executive Scholar' } } };
check('an activated design is what the build carries', activeSelectionOf(activeOrg)?.templateId === 'executive-scholar');
check('the console is told which design a build carries', designForBuildView(activeOrg)?.templateName === 'Executive Scholar');
check('a valid activated design is no readiness problem', designBuildProblem(activeOrg) === null);
const retired = { appDesign: { active: { requestId: 'r2', selection: { ...stored, templateId: 'retired-template' }, templateName: 'Old Look' } } };
check('a retired template builds nothing silently', activeSelectionOf(retired) === null);
check('…and is a readiness problem that names it', /Old Look/.test(designBuildProblem(retired) ?? ''));
const tampered = { appDesign: { active: { requestId: 'r3', selection: { kind: 'org-app-design', templateId: 'nordic-calm' } } } };
check('a malformed stored selection is a readiness problem', Boolean(designBuildProblem(tampered)) && activeSelectionOf(tampered) === null);

console.log('\n  ' + (checks - failures) + '/' + checks + ' checks passed.\n');
process.exit(failures ? 1 : 0);
