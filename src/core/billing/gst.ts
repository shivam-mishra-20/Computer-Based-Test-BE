/**
 * Indian invoicing arithmetic — pure, no database.
 *
 * What this is: the SHAPE of a GST computation (CGST + SGST inside one state,
 * IGST across states, tax added on top or carved out of an inclusive price),
 * the Indian financial year, and an invoice number that fits the 16-character
 * limit. What this is NOT: a statement that any invoice is GST-compliant. The
 * rate, the SAC code, the seller's registration and whether plan prices include
 * tax are the platform's to provide (models/BillingProfile.ts) and need review
 * by whoever is responsible for the platform's tax filings.
 *
 * Money is integer paise throughout. Each tax component is rounded on its own,
 * to the nearest paisa, half up.
 */

/** GST state and union-territory codes (the first two digits of a GSTIN). */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

export function isStateCode(code: unknown): code is string {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(GST_STATE_CODES, code);
}

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The GSTIN check character for its first 14 characters (mod-36). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARSET.indexOf(first14[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/**
 * Whether a GSTIN is WELL-FORMED: shape, a known state code, and the check
 * character. Says nothing about whether it is registered or active — that is
 * only answerable by the GST portal.
 */
export function gstinProblem(gstin: string): string | null {
  const value = String(gstin || '').trim().toUpperCase();
  if (!GSTIN_SHAPE.test(value)) return 'A GSTIN is 15 characters: state code, PAN, entity number, Z, check character.';
  if (!isStateCode(value.slice(0, 2))) return `"${value.slice(0, 2)}" is not a GST state code.`;
  if (gstinCheckChar(value.slice(0, 14)) !== value[14]) return 'The GSTIN\'s check character does not match; check it for a typo.';
  return null;
}

export interface TaxInput {
  /** Sum of the line amounts, in paise. */
  linesTotalMinor: number;
  /** Combined rate, e.g. 18. Undefined → no GST. */
  ratePercent?: number;
  sellerGstin?: string;
  sellerStateCode?: string;
  /** The buyer's state: the place of supply for a service like this one. */
  buyerStateCode?: string;
  inclusive?: boolean;
}

export interface TaxResult {
  regime: 'none' | 'gst';
  ratePercent?: number;
  inclusive?: boolean;
  placeOfSupply?: string;
  subtotalMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalTaxMinor: number;
  totalMinor: number;
}

export class TaxInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TaxInputError';
  }
}

const half = (n: number) => Math.round(n);

/**
 * Compute an invoice's tax. With no seller GSTIN or no rate: no GST at all
 * (`regime: 'none'`) — never a guessed rate.
 */
export function computeTax(input: TaxInput): TaxResult {
  const lines = Math.max(0, Math.round(input.linesTotalMinor));
  const rate = input.ratePercent;
  if (!input.sellerGstin || rate === undefined || rate === null || !(rate > 0)) {
    return { regime: 'none', subtotalMinor: lines, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalTaxMinor: 0, totalMinor: lines };
  }
  if (!isStateCode(input.sellerStateCode)) {
    throw new TaxInputError('SELLER_STATE_REQUIRED', 'The platform billing profile needs its GST state code before GST can be charged.');
  }
  if (!isStateCode(input.buyerStateCode)) {
    throw new TaxInputError('BUYER_STATE_REQUIRED', 'The organization\'s billing state (place of supply) is needed to charge GST.');
  }

  const sameState = input.sellerStateCode === input.buyerStateCode;
  let subtotal: number;
  let tax: number;
  if (input.inclusive) {
    subtotal = half((lines * 100) / (100 + rate));
    tax = lines - subtotal;
  } else {
    subtotal = lines;
    tax = sameState ? half((lines * rate) / 200) * 2 : half((lines * rate) / 100);
  }

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (sameState) {
    cgst = input.inclusive ? half(tax / 2) : half((lines * rate) / 200);
    sgst = tax - cgst;
  } else {
    igst = tax;
  }
  return {
    regime: 'gst',
    ratePercent: rate,
    inclusive: Boolean(input.inclusive),
    placeOfSupply: input.buyerStateCode,
    subtotalMinor: subtotal,
    cgstMinor: cgst,
    sgstMinor: sgst,
    igstMinor: igst,
    totalTaxMinor: cgst + sgst + igst,
    totalMinor: subtotal + cgst + sgst + igst,
  };
}

const IST_OFFSET_MS = 330 * 60 * 1000;

/** The Indian financial year (April–March) a date falls in, as "2026-27". */
export function financialYearOf(date = new Date()): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const INVOICE_NUMBER_MAX = 16;
const PREFIX = /^[A-Z0-9]{1,5}$/;

/**
 * "INV/26-27/0001". Only letters, digits, "/" and "-", at most 16 characters
 * — the limit an Indian tax invoice number has.
 */
export function formatInvoiceNumber(prefix: string, financialYear: string, seq: number): string {
  const p = String(prefix || '').toUpperCase();
  if (!PREFIX.test(p)) throw new TaxInputError('PREFIX_INVALID', 'An invoice prefix is 1–5 letters or digits.');
  const [from, to] = financialYear.split('-');
  const number = `${p}/${from.slice(2)}-${to}/${String(seq).padStart(4, '0')}`;
  if (number.length > INVOICE_NUMBER_MAX) {
    throw new TaxInputError('NUMBER_TOO_LONG', `Invoice number ${number} is longer than ${INVOICE_NUMBER_MAX} characters; shorten the prefix.`);
  }
  return number;
}

export function isInvoicePrefix(prefix: unknown): boolean {
  return typeof prefix === 'string' && PREFIX.test(prefix.toUpperCase());
}

/** Rupees for display: 99900 → "999.00". */
export function rupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100).toLocaleString('en-IN');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
}
