import picomatch from 'picomatch';

import type { DockerRule, CompiledDockerRule, AllowlistMatchResult } from './types.js';

/**
 * Compile a single DockerRule into a CompiledDockerRule with precomputed
 * regex and optional name glob matcher.
 */
function compileRule(rule: DockerRule): CompiledDockerRule {
  const method = rule.method.toUpperCase();
  const hasId = rule.path.includes('{id}');

  // Escape all regex-special characters, then replace the escaped {id}
  // placeholder with a capture group that matches a single path segment.
  const regexStr = rule.path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace('\\{id\\}', '([^/]+)');

  const pathRegex = new RegExp(`^${regexStr}$`);

  const nameMatcher = rule.name != null ? picomatch(rule.name) : null;

  return { original: rule, method, pathRegex, hasId, nameMatcher };
}

/**
 * Compiles an array of `DockerRule` definitions into regex patterns and
 * provides efficient matching of incoming Docker API requests against
 * the allowlist. First matching rule wins.
 */
export class DockerAllowlistMatcher {
  private readonly compiled: CompiledDockerRule[];

  constructor(rules: DockerRule[]) {
    this.compiled = rules.map((rule) => compileRule(rule));
  }

  /**
   * Match an HTTP method + path against the compiled allowlist.
   *
   * This performs method and path matching only — it does **not** verify the
   * container name. When the matching rule carries a `name` glob the result
   * will include `needsNameCheck: true` so that the caller can resolve the
   * container name and finish validation via {@link matchWithName}.
   */
  match(
    method: string,
    path: string,
  ): AllowlistMatchResult & { containerId?: string; needsNameCheck?: boolean } {
    const upperMethod = method.toUpperCase();

    for (const compiled of this.compiled) {
      if (compiled.method !== upperMethod) continue;

      const m = compiled.pathRegex.exec(path);
      if (m === null) continue;

      const containerId = compiled.hasId ? m[1] : undefined;

      if (compiled.nameMatcher !== null) {
        return {
          allowed: true,
          rule: compiled.original,
          containerId,
          needsNameCheck: true,
        };
      }

      return {
        allowed: true,
        rule: compiled.original,
        containerId,
      };
    }

    return {
      allowed: false,
      reason: `No allowlist rule matched ${method.toUpperCase()} ${path}`,
    };
  }

  /**
   * Match an HTTP method + path, then verify the container name against the
   * rule's `name` glob (if present).
   *
   * - If the matching rule has no `name` field the request is allowed
   *   regardless of `containerName`.
   * - If the matching rule has a `name` glob and `containerName` is `null`
   *   the request is **denied** (fail-closed).
   * - If the matching rule has a `name` glob the container name is tested
   *   against it; a mismatch denies the request.
   */
  matchWithName(
    method: string,
    path: string,
    containerName: string | null,
  ): AllowlistMatchResult {
    const result = this.match(method, path);

    if (!result.allowed) {
      return result;
    }

    // Rule matched but has no name constraint — allow unconditionally.
    if (!result.needsNameCheck) {
      return { allowed: true, rule: result.rule, containerId: result.containerId };
    }

    // Rule requires a name check but we have no name to check against.
    if (containerName === null) {
      return {
        allowed: false,
        reason: `Rule requires container name match but container name could not be resolved`,
      };
    }

    // Find the compiled rule so we can access the name matcher.
    const compiled = this.compiled.find((c) => c.original === result.rule);
    if (compiled?.nameMatcher == null) {
      // Defensive: should never happen since needsNameCheck was true.
      return {
        allowed: false,
        reason: 'Internal error: compiled rule missing name matcher',
      };
    }

    if (!compiled.nameMatcher(containerName)) {
      return {
        allowed: false,
        reason: `Container name "${containerName}" does not match rule pattern "${compiled.original.name ?? ''}"`,
      };
    }

    return { allowed: true, rule: result.rule, containerId: result.containerId };
  }
}
