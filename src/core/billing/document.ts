/**
 * Sending an invoice document — the same page for platform staff and for the
 * organization's own admins.
 *
 *   ?format=html (default)  the printable page, served inert: a CSP allowing
 *                           no scripts, no loads, only its own inline styles
 *   ?format=pdf             the same page through the shared PDF renderer
 *                           (utils/launchBrowser: JavaScript off, asset
 *                           allowlist). Without a Chromium on the host the
 *                           answer is 503 PDF_UNAVAILABLE, never a broken file.
 */

import type { Response } from 'express';
import { renderInvoiceHtml } from './invoices';

export async function sendInvoiceDocument(res: Response, invoice: Record<string, any>, format: string) {
  const html = renderInvoiceHtml(invoice);
  const name = String(invoice.number || `draft-${invoice.id ?? invoice._id}`).replace(/[^A-Za-z0-9-]/g, '_');
  if (format === 'pdf') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { htmlToPdfBuffer } = require('../../utils/launchBrowser');
      const pdf: Buffer = await htmlToPdfBuffer(html);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
      return res.send(pdf);
    } catch (error) {
      console.error('[billing] invoice PDF could not be rendered:', (error as Error).message);
      return res.status(503).json({
        message: 'The PDF could not be produced on this server. The printable page is available instead.',
        code: 'PDF_UNAVAILABLE',
      });
    }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'");
  res.setHeader('Content-Disposition', `inline; filename="${name}.html"`);
  return res.send(html);
}
