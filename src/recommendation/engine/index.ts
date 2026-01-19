/**
 * Recommendation Engine Module
 *
 * Exports all engine components for the Protégé Recommendation system.
 */

// Main engine
export { ProtegeRecommendationEngine } from './protege-engine.js';

// Supporting services
export { PrincipleMatcherService } from './principle-matcher.js';
export { ContextIntegratorService } from './context-integrator.js';
export { PhilosophyApplierService } from './philosophy-applier.js';
export { ReasoningGeneratorService } from './reasoning-generator.js';
