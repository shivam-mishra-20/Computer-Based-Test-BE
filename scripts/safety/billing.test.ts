/**
 * Billing — GST arithmetic, GSTIN checks, invoice numbering and the invoice
 * document, as pure logic. No database. The end-to-end proof is
 * invoices.e2e.test.ts.
 *
 * Nothing here asserts that an invoice is GST-compliant: it asserts that the
 * arithmetic does what the code says, and that no GST appears unless the
 * platform has supplied a GSTIN and a rate.
 *
 *   npx ts-node --transpile-only scripts/safety/billing.test.ts
 */

import {
  GST_STATE_CODES,
  computeTax,
  financialYearOf,
  formatInvoiceNumber,
  gstinCheckChar,
  gstinProblem,
  isInvoicePrefix,
  rupees,
  TaxInputError,
} from '../../src/core/billing/gst';
import { invoiceView, renderInvoiceHtml } from '../../src/core/billing/invoices';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);
const throwsCode = (fn: () => unknown, code: string) => {
  try {
    fn();
    return false;
  } catch (e) {
    return (e as TaxInputError).code === code;
  }
};

function main() {
  console.log('Billing\n');

  section('GSTIN');
  // Published GSTINs of real, registered businesses — used only to check the
  // check-character algorithm.
  const real = ['27AAPFU0939F1ZV', '29AAICA3918J1ZE', '07AAGFF2194N1Z1', '24AAACC1206D1ZM', '33AAACH7409R1Z8', '27AAACR5055K1Z7'];
  check('the check character of six published GSTINs is computed correctly', real.every((g) => gstinProblem(g) === null), real.map((g) => `${g}:${gstinCheckChar(g.slice(0, 14))}`).join(' '));
  check('a typo in the PAN part is caught by the check character', gstinProblem('27AAPFU0938F1ZV') !== null);
  check('the wrong length or shape is refused', gstinProblem('27AAPFU0939F1Z') !== null && gstinProblem('27AAPFU0939F1XV') !== null);
  check('an unknown state code is refused', /state code/.test(gstinProblem('98AAPFU0939F1ZV') ?? ''));
  check('lower case is accepted (normalized)', gstinProblem('27aapfu0939f1zv') === null);
  check('the state list has Gujarat 24, Maharashtra 27, Delhi 07, Ladakh 38', GST_STATE_CODES['24'] === 'Gujarat' && GST_STATE_CODES['27'] === 'Maharashtra' && GST_STATE_CODES['07'] === 'Delhi' && GST_STATE_CODES['38'] === 'Ladakh');

  section('no GST unless the platform supplies it');
  const none = computeTax({ linesTotalMinor: 99900 });
  check('without a GSTIN or a rate: regime none, total = lines', none.regime === 'none' && none.totalMinor === 99900 && none.totalTaxMinor === 0);
  check('a rate without a GSTIN is still no GST', computeTax({ linesTotalMinor: 99900, ratePercent: 18 }).regime === 'none');
  check('a GSTIN without a rate is still no GST', computeTax({ linesTotalMinor: 99900, sellerGstin: '24AAACC1206D1ZM' }).regime === 'none');
  check('a rate of 0 is no GST', computeTax({ linesTotalMinor: 99900, ratePercent: 0, sellerGstin: '24AAACC1206D1ZM', sellerStateCode: '24', buyerStateCode: '24' }).regime === 'none');

  section('GST arithmetic (18%, ₹999)');
  const base = { linesTotalMinor: 99900, ratePercent: 18, sellerGstin: '24AAACC1206D1ZM', sellerStateCode: '24' };
  const intra = computeTax({ ...base, buyerStateCode: '24' });
  check('same state: CGST 9% + SGST 9% = ₹89.91 + ₹89.91', intra.regime === 'gst' && intra.cgstMinor === 8991 && intra.sgstMinor === 8991 && intra.igstMinor === 0);
  check('...total ₹1,178.82, place of supply 24', intra.totalMinor === 117882 && intra.placeOfSupply === '24');
  const inter = computeTax({ ...base, buyerStateCode: '27' });
  check('another state: IGST 18% = ₹179.82, no CGST/SGST', inter.igstMinor === 17982 && inter.cgstMinor === 0 && inter.sgstMinor === 0 && inter.totalMinor === 117882);
  const incl = computeTax({ ...base, buyerStateCode: '27', inclusive: true });
  check('inclusive price: ₹999 contains taxable ₹846.61 + IGST ₹152.39', incl.subtotalMinor === 84661 && incl.igstMinor === 15239 && incl.totalMinor === 99900);
  const inclIntra = computeTax({ ...base, buyerStateCode: '24', inclusive: true });
  check('inclusive, same state: CGST + SGST add up to the tax exactly', inclIntra.cgstMinor + inclIntra.sgstMinor === inclIntra.totalTaxMinor && inclIntra.totalMinor === 99900);
  const odd = computeTax({ ...base, linesTotalMinor: 101, buyerStateCode: '24' });
  check('rounding: each component to the paisa, half up (₹1.01 → 9p + 9p)', odd.cgstMinor === 9 && odd.sgstMinor === 9 && odd.totalMinor === 119, JSON.stringify(odd));
  check('GST needs the buyer\'s state (place of supply)', throwsCode(() => computeTax({ ...base }), 'BUYER_STATE_REQUIRED'));
  check('...and the seller\'s', throwsCode(() => computeTax({ ...base, sellerStateCode: undefined, buyerStateCode: '24' }), 'SELLER_STATE_REQUIRED'));

  section('financial year and numbering');
  check('31 March 23:59 IST is still FY 2025-26', financialYearOf(new Date('2026-03-31T18:29:00Z')) === '2025-26');
  check('1 April 00:00 IST starts FY 2026-27', financialYearOf(new Date('2026-03-31T18:30:00Z')) === '2026-27');
  check('the number format is INV/26-27/0001', formatInvoiceNumber('INV', '2026-27', 1) === 'INV/26-27/0001');
  check('a five-character prefix with 9999 still fits 16 characters', formatInvoiceNumber('ABCDE', '2026-27', 9999).length === 16);
  check('beyond 16 characters is refused rather than truncated', throwsCode(() => formatInvoiceNumber('ABCDE', '2026-27', 10000), 'NUMBER_TOO_LONG'));
  check('a prefix is 1–5 letters or digits', isInvoicePrefix('INV') && isInvoicePrefix('AG26') && !isInvoicePrefix('INV/X') && !isInvoicePrefix('TOOLONG') && !isInvoicePrefix(''));
  check('rupees formatting: 117882 → 1,178.82; 9 → 0.09', rupees(117882) === '1,178.82' && rupees(9) === '0.09' && rupees(1234567890) === '1,23,45,678.90');

  section('the invoice document');
  const evil = '<script>alert(1)</script>';
  const html = renderInvoiceHtml({
    status: 'issued',
    number: 'INV/26-27/0001',
    lines: [{ description: `Starter ${evil}`, quantity: 1, unitPriceMinor: 99900, amountMinor: 99900 }],
    subtotalMinor: 99900,
    tax: { regime: 'none', cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 0 },
    totalMinor: 99900,
    seller: { legalName: `Seller ${evil}` },
    buyer: { legalName: 'Buyer "quoted" & co' },
    notes: `<img src=x onerror=alert(1)>`,
    issuedAt: new Date('2026-10-21T06:00:00Z'),
  });
  check('every value is escaped: no script or handler survives', !html.includes('<script>alert') && !/<img[^>]*onerror/i.test(html) && html.includes('&lt;script&gt;'));
  check('quotes and ampersands are escaped', html.includes('Buyer &quot;quoted&quot; &amp; co'));
  check('without GST it says plainly it is not a tax invoice', /not a GST tax invoice/.test(html) && /<h1>Invoice<\/h1>/.test(html));
  check('the page loads nothing external', !/(src|href)=["']?https?:/i.test(html));
  const gstHtml = renderInvoiceHtml({
    status: 'paid',
    number: 'INV/26-27/0002',
    lines: [{ description: 'Growth', quantity: 1, unitPriceMinor: 299900, amountMinor: 299900 }],
    subtotalMinor: 299900,
    tax: { regime: 'gst', ratePercent: 18, placeOfSupply: '24', cgstMinor: 26991, sgstMinor: 26991, igstMinor: 0, totalMinor: 53982 },
    totalMinor: 353882,
    amountPaidMinor: 353882,
    paidAt: new Date(),
  });
  check('with GST: titled "Tax invoice", with CGST 9% and SGST 9% rows and the place of supply',
    /<h1>Tax invoice<\/h1>/.test(gstHtml) && /CGST 9%/.test(gstHtml) && /SGST 9%/.test(gstHtml) && /Gujarat \(24\)/.test(gstHtml) && !/not a GST tax invoice/.test(gstHtml));
  check('a paid invoice is stamped PAID', /stamp paid/.test(gstHtml));
  check('a void invoice is stamped VOID with its reason', /VOID — Duplicate/.test(renderInvoiceHtml({ status: 'void', voidReason: 'Duplicate', lines: [], tax: { regime: 'none' } })));
  check('a draft is titled "Draft invoice" and not numbered', /Draft invoice/.test(renderInvoiceHtml({ status: 'draft', lines: [], tax: { regime: 'none' } })) && /Not yet numbered/.test(renderInvoiceHtml({ status: 'draft', lines: [], tax: { regime: 'none' } })));

  section('the invoice view');
  const overdue = invoiceView({ _id: 'x', status: 'issued', totalMinor: 100, amountPaidMinor: 0, dueAt: new Date(Date.now() - 1000), tax: { regime: 'none' } });
  check('an issued invoice past its due date is overdue, with its balance', overdue.overdue === true && overdue.balanceMinor === 100);
  check('a paid one is not overdue and owes nothing', invoiceView({ _id: 'x', status: 'paid', totalMinor: 100, amountPaidMinor: 100, dueAt: new Date(0), tax: {} }).overdue === false &&
    invoiceView({ _id: 'x', status: 'paid', totalMinor: 100, amountPaidMinor: 100, tax: {} }).balanceMinor === 0);
  check('a void one owes nothing', invoiceView({ _id: 'x', status: 'void', totalMinor: 100, amountPaidMinor: 0, tax: {} }).balanceMinor === 0);

  console.log(`\n  ${checks - failures}/${checks} checks passed.\n`);
  process.exit(failures ? 1 : 0);
}

main();
