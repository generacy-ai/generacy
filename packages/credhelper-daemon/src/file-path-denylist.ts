import path from 'node:path';

const DENIED_PREFIXES = [
  '/etc/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/proc/',
  '/sys/',
  '/dev/',
  '/boot/',
  '/run/generacy-credhelper/',
  '/var/lib/generacy-credhelper/',
  '/run/generacy-control-plane/',
] as const;

/**
 * Returns true if the given absolute path is in a restricted system directory.
 * Resolves `..` traversal and normalizes before checking.
 */
export function isPathDenied(absPath: string): boolean {
  const resolved = path.resolve(absPath);

  // Deny root itself — must be in a subdirectory
  if (resolved === '/') {
    return true;
  }

  // Ensure trailing slash for prefix comparison
  const withSlash = resolved.endsWith('/') ? resolved : resolved + '/';

  for (const prefix of DENIED_PREFIXES) {
    if (withSlash.startsWith(prefix) || resolved === prefix.slice(0, -1)) {
      return true;
    }
  }

  return false;
}
