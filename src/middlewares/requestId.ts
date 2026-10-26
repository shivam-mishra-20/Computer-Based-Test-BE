/**
 * One identifier per request, end to end.
 *
 * A well-formed inbound `X-Request-Id` (from a load balancer, the gateway in
 * front of the platform runtime, or a client retrying) is kept; anything else
 * is replaced with a fresh UUID. The id is echoed on the response and written
 * back onto the request headers, so the /platform-api gateway forwards the SAME
 * id to the platform runtime and both processes log it.
 *
 * It identifies a request, never a person: it carries nothing about the caller
 * and is safe to show to them (a 500 body includes it, so a report from a user
 * can be matched to the one log line that explains it).
 */

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';
const WELL_FORMED = /^[A-Za-z0-9._-]{8,64}$/;

export function requestIdFor(inbound: string | undefined | null): string {
  const value = String(inbound ?? '').trim();
  return WELL_FORMED.test(value) ? value : crypto.randomUUID();
}

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id = requestIdFor(req.header(REQUEST_ID_HEADER));
  (req as Request & { requestId?: string }).requestId = id;
  req.headers['x-request-id'] = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

export function requestIdOf(req: Request): string | undefined {
  return (req as Request & { requestId?: string }).requestId;
}
