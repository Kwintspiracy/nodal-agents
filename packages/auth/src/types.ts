// Core auth types: AuthSession, AuthProvider interface, typed errors.
// No user-facing strings — callers discriminate by error class + code field.

// ─── Session ──────────────────────────────────────────────────────────────────

export interface AuthSession {
  userId: string;
  entityId: string;
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface AuthProvider {
  /**
   * Resolve a request to a session, or null if unauthenticated.
   */
  getSession(req: Request): Promise<AuthSession | null>;

  /**
   * Optional: handle auth-specific routes (login, signup, callback, logout…).
   * Return null to let the caller handle the request normally.
   */
  handleAuthRequest?(req: Request): Promise<Response | null>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

export type AuthErrorCode = 'AUTH_REQUIRED';
export type NoEntityErrorCode = 'NO_ENTITY';

export class AuthError extends Error {
  readonly code: AuthErrorCode = 'AUTH_REQUIRED';
  constructor() {
    super('AUTH_REQUIRED');
    this.name = 'AuthError';
  }
}

export class NoEntityError extends Error {
  readonly code: NoEntityErrorCode = 'NO_ENTITY';
  constructor() {
    super('NO_ENTITY');
    this.name = 'NoEntityError';
  }
}
