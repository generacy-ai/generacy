import { decodeJwt } from 'jose';

import { CredhelperError } from '../errors.js';

export interface SessionTokenClaims {
  sub: string;
  org_id: string;
  scope: string;
  iat: number;
  exp: number;
}

/**
 * Structural JWT parser — no signature verification.
 *
 * Uses jose.decodeJwt() to parse the token and validates claim shape.
 * Signature validation is deferred to generacy-cloud on actual use
 * (HS256 tokens cannot be verified without the shared secret).
 */
export class JwtParser {
  parse(token: string): SessionTokenClaims {
    let payload: Record<string, unknown>;
    try {
      payload = decodeJwt(token);
    } catch {
      throw new CredhelperError(
        'INVALID_TOKEN',
        'JWT is malformed or missing required claims (sub, org_id, scope, exp, iat)',
      );
    }

    const sub = payload['sub'];
    const org_id = payload['org_id'];
    const scope = payload['scope'];
    const iat = payload['iat'];
    const exp = payload['exp'];

    if (typeof sub !== 'string' || sub === '') {
      throw new CredhelperError(
        'INVALID_TOKEN',
        'JWT is malformed or missing required claims (sub, org_id, scope, exp, iat)',
      );
    }

    if (typeof org_id !== 'string' || org_id === '') {
      throw new CredhelperError(
        'INVALID_TOKEN',
        'JWT is malformed or missing required claims (sub, org_id, scope, exp, iat)',
      );
    }

    if (typeof iat !== 'number') {
      throw new CredhelperError(
        'INVALID_TOKEN',
        'JWT is malformed or missing required claims (sub, org_id, scope, exp, iat)',
      );
    }

    if (typeof exp !== 'number') {
      throw new CredhelperError(
        'INVALID_TOKEN',
        'JWT is malformed or missing required claims (sub, org_id, scope, exp, iat)',
      );
    }

    if (typeof scope !== 'string' || scope !== 'credhelper') {
      throw new CredhelperError(
        'INVALID_SCOPE',
        `JWT scope must be 'credhelper', got '${String(scope)}'`,
      );
    }

    if (exp <= Date.now() / 1000) {
      throw new CredhelperError(
        'EXPIRED_TOKEN',
        `JWT has expired (exp: ${exp})`,
      );
    }

    return { sub, org_id, scope, iat, exp };
  }
}
