/**
 * Carrying the tenant context ACROSS middleware that destroys it.
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 * `tenantContextMiddleware` opens the request's context with
 * `AsyncLocalStorage.run()`. ALS follows a request through every `await` and
 * every promise callback — which is exactly why it was chosen — but it does
 * NOT follow a callback that is invoked from an async resource created OUTSIDE
 * the context. The TCP socket is such a resource: it exists from the moment the
 * connection was accepted, long before any per-request `run()`.
 *
 * Any middleware that consumes the request STREAM therefore resumes the chain
 * from the socket's context, not the request's, and everything after it runs
 * with no store at all:
 *
 *   multer / busboy   `req.pipe(busboy)`, `next()` from the 'finish' event
 *   rate-limit-redis  `next()` from the Redis client's socket reply
 *
 * Measured, not assumed — with a valid signed `orgId` claim on the request:
 *
 *   before multer : 6a8441e8c4c17e061913e297
 *   after  multer : null
 *
 * The consequence is invisible under `TENANT_ENFORCEMENT=warn`, where reads are
 * not filtered and a missing context is merely recorded. It is NOT invisible to
 * object storage, which is unconditionally fail-closed: `putTenantFile()` finds
 * no organization and throws `StorageAccessDenied`. Every multipart upload
 * route on the platform sits behind this boundary.
 *
 * ── Why the context is re-entered from a STASH, not from the ambient store ──
 * The obvious version captures `getStore()` immediately before the offending
 * middleware and re-enters that. It breaks the moment TWO context-destroying
 * middlewares are chained — `uploadLimiter` (Redis) ahead of `multer` is
 * precisely that case — because by then the ambient store is already gone and
 * the wrapper captures nothing.
 *
 * So `tenantContextMiddleware` stashes the store it opened on the request
 * object itself, which no async boundary can lose, and this module re-enters
 * THAT. The stash is written only by the tenancy middleware, from a verified
 * claim or from configuration; it is never derived from anything the client
 * sends, and a symbol key keeps it out of reach of body/query parsing.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  getStore,
  isUnscoped,
  runWithTenant,
  withoutTenantScope,
} from './context';
import type { TenantContext } from './context';

type Store = ReturnType<typeof getStore>;

/** Symbol-keyed so no parsed body, query or header can ever collide with it. */
const TENANT_STORE = Symbol.for('central-be.tenancy.requestStore');

/**
 * Record the context opened for this request, so it can be re-entered after a
 * middleware that drops it. Called by `tenantContextMiddleware` only.
 */
export function stashTenantStore(
  req: Request,
  store: NonNullable<Store>,
): void {
  (req as unknown as Record<symbol, unknown>)[TENANT_STORE] = store;
}

/** The context opened for this request, or null when there never was one. */
export function stashedTenantStore(req: Request): NonNullable<Store> | null {
  const stored = (req as unknown as Record<symbol, unknown>)[TENANT_STORE];
  return (stored as NonNullable<Store> | undefined) ?? null;
}

/** Run `fn` inside the request's stashed context. A no-op when there is none. */
export function withStashedTenantContext<T>(req: Request, fn: () => T): T {
  const store = stashedTenantStore(req);
  if (!store) return fn();
  if (isUnscoped(store)) return withoutTenantScope(store.reason, fn);
  return runWithTenant(store as TenantContext, fn);
}

/**
 * Wrap a middleware that destroys the tenant context so the rest of the chain
 * runs back inside it.
 *
 *     router.post('/extract-image',
 *       authMiddleware,
 *       preservingTenantContext(upload.single('image')),
 *       handler);
 *
 * Restoring on the ERROR path too is deliberate: a multer rejection (file too
 * large, wrong type) reaches the error handler, and an error handler that logs
 * or records outside the tenant context attributes the failure to nobody.
 */
/**
 * Wrap a whole multer instance, so every route that uses it is covered.
 *
 * ── Why the instance and not the call sites ─────────────────────────────────
 * Seventeen routes call `upload.single(...)`, and every one of them loses the
 * tenant context the moment multer reads the request body. Wrapping them one by
 * one is seventeen chances to miss one, and the eighteenth route added next
 * month inherits the bug silently. Wrapping the instance means a caller cannot
 * opt out by accident: `upload.single('file')` is already correct.
 *
 * The returned object is the multer instance with its middleware factories
 * replaced. Everything else on it — `.storage`, limits, the fileFilter — is the
 * original, so behaviour is unchanged apart from the context surviving.
 */
export function preservingTenantContextOn<T extends object>(instance: T): T {
  const FACTORIES = ['single', 'array', 'fields', 'any', 'none'] as const;

  return new Proxy(instance, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (!(FACTORIES as readonly (string | symbol)[]).includes(prop)) {
        return value.bind(target);
      }
      return (...args: unknown[]) =>
        preservingTenantContext(
          (value as (...a: unknown[]) => RequestHandler).apply(target, args),
        );
    },
  });
}

export function preservingTenantContext(inner: RequestHandler): RequestHandler {
  return function preservedTenantContext(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    inner(req, res, (err?: unknown) =>
      withStashedTenantContext(req, () =>
        err === undefined ? next() : next(err),
      ),
    );
  };
}
