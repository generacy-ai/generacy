/**
 * Principle Matcher Service
 *
 * Matches decision domains to relevant principles from the knowledge store.
 * Supports domain-based matching, weight ranking, and "unless" exception handling.
 */

import type {
  DecisionRequest,
  Principle,
  AppliedPrinciple,
  PrincipleMatcherService as IPrincipleMatcherService,
} from '../types/index.js';

/**
 * Service for matching principles to decision requests based on domain overlap
 */
export class PrincipleMatcherService implements IPrincipleMatcherService {
  /**
   * Match principles to a decision request
   *
   * @param request - The decision request containing target domains
   * @param principles - Available principles to match
   * @returns Array of applied principles sorted by weight (descending)
   */
  match(request: DecisionRequest, principles: Principle[]): AppliedPrinciple[] {
    if (!principles.length || !request.domain.length) {
      return [];
    }

    const requestDomains = new Set(request.domain.map((d) => d.toLowerCase()));

    // Filter active principles that match at least one domain
    const matchedPrinciples = principles.filter((principle) => {
      if (!principle.active) return false;
      if (!principle.domains.length) return false;

      const principleDomains = principle.domains.map((d) => d.toLowerCase());
      return principleDomains.some((d) => requestDomains.has(d));
    });

    // Calculate relevance and create AppliedPrinciple objects
    const appliedPrinciples = matchedPrinciples.map((principle) => {
      const relevance = this.calculateRelevance(principle, request);
      const relevanceText = this.generateRelevanceText(principle, request);

      return {
        principleId: principle.id,
        principleText: principle.content,
        relevance: relevanceText,
        weight: principle.weight,
        strength: relevance,
      } satisfies AppliedPrinciple;
    });

    // Sort by weight descending
    return appliedPrinciples.sort((a, b) => b.weight - a.weight);
  }

  /**
   * Calculate relevance score based on domain overlap
   *
   * @param principle - The principle being evaluated
   * @param request - The decision request
   * @returns Relevance score between 0 and 1
   */
  private calculateRelevance(principle: Principle, request: DecisionRequest): number {
    const requestDomains = new Set(request.domain.map((d) => d.toLowerCase()));
    const principleDomains = principle.domains.map((d) => d.toLowerCase());

    // Count how many principle domains match request domains
    const matchingDomains = principleDomains.filter((d) => requestDomains.has(d)).length;

    // Relevance = (matched domains / total request domains)
    // This gives higher relevance to principles that cover more of the request's domains
    const relevance = matchingDomains / request.domain.length;

    return Math.min(1, Math.max(0, relevance));
  }

  /**
   * Generate human-readable relevance explanation
   *
   * @param principle - The principle being evaluated
   * @param request - The decision request
   * @returns Relevance explanation text
   */
  private generateRelevanceText(principle: Principle, request: DecisionRequest): string {
    const requestDomains = new Set(request.domain.map((d) => d.toLowerCase()));
    const principleDomains = principle.domains.map((d) => d.toLowerCase());

    const matchingDomains = principleDomains.filter((d) => requestDomains.has(d));

    if (matchingDomains.length === 1) {
      return `Applies to the "${matchingDomains[0]}" domain of this decision`;
    }

    return `Applies to ${matchingDomains.length} domains: ${matchingDomains.join(', ')}`;
  }

  /**
   * Check if a principle's "unless" exceptions apply to the current context
   *
   * @param principle - The principle with potential exceptions
   * @param request - The decision request with context
   * @returns True if an exception applies (principle should not be used)
   */
  checkUnlessExceptions(principle: Principle, request: DecisionRequest): boolean {
    if (!principle.exceptions || principle.exceptions.length === 0) {
      return false;
    }

    // Check if any exception keywords appear in the request context
    const questionLower = request.question.toLowerCase();
    const metadataStr = request.metadata
      ? JSON.stringify(request.metadata).toLowerCase()
      : '';

    for (const exception of principle.exceptions) {
      const exceptionLower = exception.toLowerCase();
      if (questionLower.includes(exceptionLower) || metadataStr.includes(exceptionLower)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Match principles with exception checking
   *
   * @param request - The decision request
   * @param principles - Available principles
   * @returns Applied principles excluding those with triggered exceptions
   */
  matchWithExceptions(
    request: DecisionRequest,
    principles: Principle[]
  ): AppliedPrinciple[] {
    const matched = this.match(request, principles);

    // Filter out principles whose exceptions apply
    return matched.filter((applied) => {
      const principle = principles.find((p) => p.id === applied.principleId);
      if (!principle) return true;
      return !this.checkUnlessExceptions(principle, request);
    });
  }
}
