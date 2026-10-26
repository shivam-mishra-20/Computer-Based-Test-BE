/**
 * Staff alerts for the admissions desk.
 *
 * Every event a family creates — a new enquiry, a new AGTS registration, a
 * guidance request, a submitted application — reaches the institute's admins
 * (and the lead's owner, when one is assigned) as an in-app notification with
 * push. Before this, the only way to learn of a new family was to open the
 * dashboard and look.
 *
 * Best effort by design: an alert that fails must never fail the form the
 * family just submitted, so every entry point here swallows its own errors.
 * The text carries a student's first name and class only — enough to act on,
 * nothing a lock screen should not show.
 */

import User from '../../models/User';
import { requireTenantScope } from '../../core/tenancy';
import { createAndSendNotification } from '../notificationService';

export type AdmissionAlertKind = 'enquiry' | 'agts_registration' | 'guidance' | 'application';

export interface AdmissionAlertLead {
  _id: unknown;
  student?: { name?: string; classLevel?: number };
  admission?: { classLevel?: number; stream?: string };
  owner?: { id?: unknown };
}

const firstName = (name?: string) => String(name || 'A family').trim().split(/\s+/)[0] || 'A family';

function describe(lead: AdmissionAlertLead): string {
  const target = lead.admission?.classLevel
    ? `Class ${lead.admission.classLevel}${lead.admission.stream ? ` ${lead.admission.stream}` : ''}`
    : lead.student?.classLevel
      ? `in Class ${lead.student.classLevel}`
      : '';
  return [firstName(lead.student?.name), target].filter(Boolean).join(', ');
}

export function alertText(kind: AdmissionAlertKind, lead: AdmissionAlertLead, detail = ''): { title: string; body: string } {
  const who = describe(lead);
  switch (kind) {
    case 'enquiry':
      return { title: 'New admission enquiry', body: `${who}${detail ? ` — from the ${detail}` : ''}. Call within one working day.` };
    case 'agts_registration':
      return { title: 'New AGTS registration', body: `${who} started AGTS.` };
    case 'guidance':
      return { title: 'Guidance call requested', body: `${who} asked for academic guidance${detail ? ` (${detail})` : ''}.` };
    case 'application':
      return { title: 'Application submitted', body: `${who} submitted the admission application.` };
    default:
      return { title: 'Admissions update', body: who };
  }
}

const SOURCE_LABELS: Record<string, string> = {
  enrollnow: 'admission form',
  'enquiry-page': 'enquiry page',
  home: 'home page',
  'marketing-hub': 'marketing hub',
  'admissions-page': 'admissions page',
  'agts-result': 'AGTS result page',
};

export const enquirySourceLabel = (source?: string) => SOURCE_LABELS[String(source || '')] || 'website';

/** Admins of the current organization, plus the owner. Never throws. */
export async function notifyAdmissionsStaff(kind: AdmissionAlertKind, lead: AdmissionAlertLead, detail = ''): Promise<void> {
  try {
    const admins = await User.find({ ...requireTenantScope('admissions:alert'), role: 'admin' }).select('_id').lean();
    const recipients = new Set(admins.map((a: any) => String(a._id)));
    if (lead.owner?.id) recipients.add(String(lead.owner.id));
    if (!recipients.size) return;

    const { title, body } = alertText(kind, lead, detail);
    await Promise.all(
      [...recipients].map((userId) =>
        createAndSendNotification({
          userId,
          type: 'general',
          title,
          body,
          data: { type: 'admission_lead', kind, leadId: String(lead._id) },
        }),
      ),
    );
  } catch (err) {
    console.error('[admissions] staff alert failed:', (err as Error)?.message);
  }
}
