/**
 * Branding for generated documents — PDFs, spreadsheets, anything a student or
 * parent actually holds.
 *
 * ── Why this is its own resolver ────────────────────────────────────────────
 * A generated question paper is the most customer-facing artefact this platform
 * produces. It leaves the building: it is printed, photocopied, handed out, and
 * kept. An exported paper carrying another institute's name and street address
 * is not a cosmetic defect — it is the single most visible way a white-label
 * platform can fail.
 *
 * `paperExport.ts` had the name, the address and the logo as module constants.
 * That was correct when there was one customer.
 *
 * ── Abhigyan is unchanged ───────────────────────────────────────────────────
 * The legacy constants ARE the fallback. An organization that has configured no
 * document branding gets exactly the header it gets today, byte for byte —
 * which is the same per-section fallback rule as `orgConfig`, `policy` and
 * `timeSlots`:
 *
 *     Absent configuration must mean "as before", never "nothing".
 *
 * A tenant with no configured document branding and no name would otherwise get
 * a paper headed with an empty string, which is worse than getting someone
 * else's.
 */

import { currentOrgId, withoutTenantScope } from '../tenancy';
import { LOGO_DATA_URL } from '../../services/aiContent/brandAssets';

/** Abhigyan's current header, transcribed. The fallback, not the default. */
export const LEGACY_DOCUMENT_BRANDING = {
  instituteName: 'Abhigyan Gurukul',
  instituteAddress:
    'Akshar Pavilion, Road 4, Vasna – Bhayli Main Rd, opp. to Rosedale Heights, ' +
    'Yogi Nagar Twp, Gokul Nagar, Vadodara, Gujarat 391410',
  logoDataUrl: LOGO_DATA_URL,
} as const;

export interface DocumentBranding {
  instituteName: string;
  instituteAddress: string;
  /** A data: URL or an https: URL. Empty string renders no logo. */
  logoDataUrl: string;
  /** True when these values came from the legacy constants. */
  usingDefaults: boolean;
}

/**
 * Document branding for an organization.
 *
 * `documentHeader` wins over `appName` wins over the organization's name: the
 * first is the field whose stated purpose is exactly this, and an institute
 * that sets it has said what it wants printed.
 */
export async function getDocumentBranding(orgId?: string | null): Promise<DocumentBranding> {
  const org = orgId ?? currentOrgId();
  if (!org) return { ...LEGACY_DOCUMENT_BRANDING, usingDefaults: true };

  try {
    const doc = (await withoutTenantScope('config:read-document-branding', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Org = require('../../models/Org').default;
      return Org.findById(org).select('name branding').lean();
    })) as {
      name?: string;
      branding?: {
        documentHeader?: string;
        documentAddress?: string;
        appName?: string;
        logoUrl?: string;
      };
    } | null;

    if (!doc) return { ...LEGACY_DOCUMENT_BRANDING, usingDefaults: true };

    const branding = doc.branding ?? {};
    const name = (branding.documentHeader || branding.appName || doc.name || '').trim();
    const address = (branding.documentAddress || '').trim();
    const logo = (branding.logoUrl || '').trim();

    // Per FIELD, not all-or-nothing: an institute that set its name but not its
    // address should not inherit Abhigyan's name back, and should not print an
    // empty address line either — it prints no address line at all, which the
    // template handles.
    return {
      instituteName: name || LEGACY_DOCUMENT_BRANDING.instituteName,
      instituteAddress: name ? address : LEGACY_DOCUMENT_BRANDING.instituteAddress,
      logoDataUrl: logo || (name ? '' : LEGACY_DOCUMENT_BRANDING.logoDataUrl),
      usingDefaults: !name,
    };
  } catch (error) {
    // A branding lookup must never be the reason a paper fails to generate.
    console.error('[documentBranding] resolution failed, using defaults:', (error as Error).message);
    return { ...LEGACY_DOCUMENT_BRANDING, usingDefaults: true };
  }
}
