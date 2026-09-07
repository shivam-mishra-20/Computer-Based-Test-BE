/**
 * Raised when a database operation runs with no tenant context under enforce.
 *
 * Deliberately a distinct class: the error handler must be able to tell this
 * apart from an ordinary failure, because it means a code path exists that was
 * never scoped — a bug to fix, not a request to retry.
 */
export class TenantContextMissing extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING';
  readonly model: string;
  readonly operation: string;

  constructor(model: string, operation: string) {
    super(
      `No tenant context for ${model}.${operation}(). ` +
        `Every database operation must run inside runWithTenant(), or explicitly ` +
        `opt out via withoutTenantScope('<reason>'). Refusing to run unscoped.`,
    );
    this.name = 'TenantContextMissing';
    this.model = model;
    this.operation = operation;
  }
}

/** Raised when a write would attribute a document to the wrong organization. */
export class TenantMismatch extends Error {
  readonly code = 'TENANT_MISMATCH';

  constructor(model: string, expected: string, actual: string) {
    super(
      `Refusing to write ${model} belonging to org ${actual} from a context scoped ` +
        `to org ${expected}. This is a cross-tenant write attempt.`,
    );
    this.name = 'TenantMismatch';
  }
}
