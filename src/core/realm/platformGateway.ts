/**
 * /platform-api/* → the platform runtime.
 *
 * Mounted first in the main process's app, before CORS, the rate limiters and
 * the body parsers, so that nothing of the existing system's request pipeline
 * runs for a platform request: the runtime applies its own CORS, limits,
 * parsing, authentication and organization rules to it, exactly as it would to
 * a request made to it directly. The request body and the response (including
 * event streams and file downloads) are streamed through untouched.
 *
 * The runtime sees `/api/<rest>` — its own routes — and one fact the gateway
 * vouches for: the client's address, taken from this process's trusted view of
 * it (`req.ip`, which honours `trust proxy`), never from a header the client
 * sent. A caller cannot choose which process or database serves them: the
 * path decides, and only the backend maps paths to realms.
 */

import crypto from 'crypto';
import http from 'http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { platformUpstreamPath } from './realm';
import { platformRuntimeTarget } from './platformRuntime';

/** Connection-level headers belong to one hop and are never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Set by the gateway only; anything a client sends under these names is dropped. */
const GATEWAY_OWNED = new Set(['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-realm-gateway-key']);

export const GATEWAY_KEY_HEADER = 'x-realm-gateway-key';

function unavailable(res: Response, configured: boolean): void {
  if (!configured) {
    res.status(503).json({
      message: 'The platform API is not configured on this server.',
      code: 'PLATFORM_NOT_CONFIGURED',
    });
    return;
  }
  res.setHeader('Retry-After', '5');
  res.status(503).json({
    message: 'The platform API is starting. Please try again in a moment.',
    code: 'PLATFORM_UNAVAILABLE',
  });
}

/**
 * One of the gateway's own 503s, under the mounting app's CORS when it gave
 * one: an allowed preflight is answered by the CORS handler itself, and the
 * request that follows gets its 503 with the headers that let the page read
 * it. An origin the policy refuses gets the bare 503, as before.
 */
function answerUnavailable(req: Request, res: Response, configured: boolean, withCors: RequestHandler | null): void {
  if (!withCors) {
    unavailable(res, configured);
    return;
  }
  withCors(req, res, () => unavailable(res, configured));
}

/**
 * The gateway, as the main process mounts it.
 *
 * @param options.cors  CORS for the gateway's OWN answers — the 503s sent while
 *   the runtime is not serving. Everything the gateway forwards is answered
 *   under the runtime's CORS, but these never reach the runtime, and a browser
 *   cannot read a cross-origin answer without CORS headers: the page reports a
 *   "CORS policy" failure instead of "not configured" or "starting", which
 *   points at the wrong problem.
 */
export function createPlatformGateway(options: { cors?: RequestHandler } = {}): RequestHandler {
  const withCors = options.cors ?? null;
  return (req, res, next) => forward(req, res, next, withCors);
}

function forward(req: Request, res: Response, next: NextFunction, withCors: RequestHandler | null): void {
  const upstreamPath = platformUpstreamPath(req.originalUrl || req.url);
  if (!upstreamPath) return next();

  const target = platformRuntimeTarget();
  if (!target.configured || !target.port) return answerUnavailable(req, res, target.configured, withCors);

  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || GATEWAY_OWNED.has(lower)) continue;
    headers[lower] = value;
  }
  headers['x-forwarded-for'] = req.ip || req.socket.remoteAddress || '';
  headers['x-forwarded-proto'] = req.protocol;
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
  headers[GATEWAY_KEY_HEADER] = target.gatewayKey;

  const upstream = http.request(
    { host: '127.0.0.1', port: target.port, method: req.method, path: upstreamPath, headers },
    (upstreamRes) => {
      const responseHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
        responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    },
  );

  upstream.on('error', (error: NodeJS.ErrnoException) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    // Connection refused or reset: the runtime is restarting.
    answerUnavailable(req, res, true, withCors);
  });

  // The client went away: stop the work it asked for.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream);
}

/**
 * The runtime's side of the gateway — mounted first in the PLATFORM realm's
 * app, never in the existing system's.
 *
 *   Started by a gateway (REALM_GATEWAY_KEY set): serve nothing that did not
 *   come through it. The runtime listens on loopback only; this also refuses
 *   any other local process that finds its port.
 *
 *   Standalone (a fixture, a dedicated platform deployment): answer
 *   /platform-api/* directly as well as /api/*, so a client configured with
 *   the /platform-api base works against either.
 */
export function platformRuntimeEntry(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.REALM_GATEWAY_KEY || '';
  if (expected) {
    const presented = Buffer.from(String(req.header(GATEWAY_KEY_HEADER) || ''));
    const wanted = Buffer.from(expected);
    if (presented.length !== wanted.length || !crypto.timingSafeEqual(presented, wanted)) {
      res.status(403).json({
        message: 'The platform API is served at /platform-api/*.',
        code: 'PLATFORM_GATEWAY_REQUIRED',
      });
      return;
    }
    delete req.headers[GATEWAY_KEY_HEADER];
  }
  const rewritten = platformUpstreamPath(req.url);
  if (rewritten) {
    // Both, so every later reader (the learner and parent path rules read
    // originalUrl) sees the runtime's own route names.
    req.url = rewritten;
    req.originalUrl = rewritten;
  }
  next();
}
