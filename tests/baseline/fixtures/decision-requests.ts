import type {
  DecisionRequest,
  DecisionOption,
  ProjectContext,
} from '../../../src/baseline/types.js';

// Fixed date for deterministic testing
const FIXED_DATE = new Date('2024-01-15T10:00:00.000Z');

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a valid DecisionOption with sensible defaults.
 * @param overrides - Partial option properties to override defaults
 */
export function createDecisionOption(
  overrides?: Partial<DecisionOption>
): DecisionOption {
  return {
    id: 'option-1',
    name: 'Default Option',
    description: 'A default option for testing',
    pros: ['Easy to use', 'Well documented'],
    cons: ['Limited features'],
    ...overrides,
  };
}

/**
 * Creates a valid DecisionRequest with sensible defaults.
 * @param overrides - Partial request properties to override defaults
 */
export function createDecisionRequest(
  overrides?: Partial<DecisionRequest>
): DecisionRequest {
  return {
    id: 'request-1',
    description: 'A default decision request for testing',
    options: [
      createDecisionOption({ id: 'opt-a', name: 'Option A' }),
      createDecisionOption({ id: 'opt-b', name: 'Option B' }),
    ],
    context: {
      name: 'Test Project',
      description: 'A test project',
      techStack: ['TypeScript', 'Node.js'],
      teamSize: 5,
      phase: 'development',
      domain: 'web-development',
    },
    requestedAt: FIXED_DATE,
    ...overrides,
  };
}

// ============================================================================
// Sample Fixtures
// ============================================================================

/**
 * A basic decision with 2 clear options.
 * About choosing between React and Vue for a frontend project.
 */
export const simpleDecisionRequest: DecisionRequest = {
  id: 'simple-frontend-framework',
  description:
    'Choose a frontend framework for building a new customer portal with interactive dashboards',
  options: [
    {
      id: 'react',
      name: 'React',
      description:
        'A JavaScript library for building user interfaces with a component-based architecture',
      pros: [
        'Large ecosystem with extensive third-party libraries',
        'Strong community support and abundant learning resources',
        'Flexible architecture allows custom solutions',
        'Excellent developer tooling (React DevTools)',
      ],
      cons: [
        'Steeper learning curve for beginners',
        'Requires additional libraries for routing and state management',
        'JSX syntax can be polarizing',
      ],
    },
    {
      id: 'vue',
      name: 'Vue.js',
      description:
        'A progressive JavaScript framework for building UIs with an approachable learning curve',
      pros: [
        'Gentle learning curve, easier for beginners',
        'Built-in state management and routing options',
        'Single-file components improve organization',
        'Excellent documentation',
      ],
      cons: [
        'Smaller ecosystem compared to React',
        'Fewer job opportunities in some markets',
        'Less flexibility in large-scale applications',
      ],
    },
  ],
  context: {
    name: 'Customer Portal',
    description: 'Internal customer-facing dashboard for analytics and account management',
    techStack: ['TypeScript', 'Node.js', 'PostgreSQL', 'Docker'],
    teamSize: 4,
    phase: 'planning',
    domain: 'fintech',
    additionalContext: {
      targetUsers: 'business customers',
      expectedTraffic: 'moderate',
    },
  },
  requestedAt: FIXED_DATE,
};

/**
 * A complex decision with 4 options and trade-offs.
 * About choosing a database with constraints.
 */
export const complexDecisionRequest: DecisionRequest = {
  id: 'database-selection',
  description:
    'Select a primary database for a new e-commerce platform requiring high availability and flexible data modeling',
  options: [
    {
      id: 'postgresql',
      name: 'PostgreSQL',
      description:
        'An advanced open-source relational database with strong ACID compliance',
      pros: [
        'Strong data integrity with ACID compliance',
        'Advanced querying capabilities with window functions',
        'Excellent JSON support for semi-structured data',
        'Mature ecosystem with extensive tooling',
        'Strong community and commercial support options',
      ],
      cons: [
        'Horizontal scaling requires additional setup (Citus, partitioning)',
        'Can be complex for simple use cases',
        'Requires schema migrations for changes',
      ],
      metadata: {
        type: 'relational',
        license: 'PostgreSQL License',
        scalingModel: 'vertical-primary',
      },
    },
    {
      id: 'mongodb',
      name: 'MongoDB',
      description:
        'A document-oriented NoSQL database designed for flexibility and scalability',
      pros: [
        'Flexible schema for evolving data models',
        'Native horizontal scaling with sharding',
        'Rich query language for document operations',
        'Built-in replication for high availability',
      ],
      cons: [
        'Weaker transactional guarantees (improved in recent versions)',
        'Potential for data inconsistency if not careful',
        'Memory usage can be higher than relational DBs',
        'Commercial license concerns for some features',
      ],
      metadata: {
        type: 'document',
        license: 'SSPL',
        scalingModel: 'horizontal',
      },
    },
    {
      id: 'redis',
      name: 'Redis',
      description:
        'An in-memory data structure store used as database, cache, and message broker',
      pros: [
        'Extremely fast read/write operations',
        'Rich data structure support',
        'Built-in pub/sub messaging',
        'Excellent for caching and session management',
      ],
      cons: [
        'Limited by available memory',
        'Persistence options have trade-offs',
        'Not suitable as primary database for complex queries',
        'Data modeling requires different approach',
      ],
      metadata: {
        type: 'in-memory',
        license: 'BSD',
        scalingModel: 'cluster',
      },
    },
    {
      id: 'dynamodb',
      name: 'Amazon DynamoDB',
      description:
        'A fully managed NoSQL database service with seamless scalability',
      pros: [
        'Fully managed with automatic scaling',
        'Consistent single-digit millisecond latency',
        'Built-in security and encryption',
        'Tight AWS ecosystem integration',
      ],
      cons: [
        'Vendor lock-in to AWS',
        'Complex pricing model can be expensive at scale',
        'Limited query flexibility compared to SQL',
        'Requires careful capacity planning',
      ],
      metadata: {
        type: 'key-value',
        license: 'proprietary',
        scalingModel: 'managed',
      },
    },
  ],
  context: {
    name: 'ShopFlow E-Commerce Platform',
    description: 'Multi-tenant e-commerce platform with product catalog, orders, and inventory',
    techStack: ['TypeScript', 'Node.js', 'Kubernetes', 'AWS'],
    teamSize: 12,
    phase: 'development',
    domain: 'e-commerce',
    additionalContext: {
      expectedScale: '100k daily active users',
      dataCompliance: 'PCI-DSS required',
    },
  },
  constraints: {
    deadline: new Date('2024-06-01T00:00:00.000Z'),
    budget: { amount: 50000, currency: 'USD' },
    requiredFeatures: [
      'ACID transactions',
      'high availability',
      'backup and recovery',
    ],
    excludedTechnologies: ['Oracle', 'Microsoft SQL Server'],
  },
  requestedAt: FIXED_DATE,
};

/**
 * Edge case with only 1 option.
 * Used to test behavior with minimal options.
 */
export const singleOptionRequest: DecisionRequest = {
  id: 'single-option-decision',
  description: 'Confirm the use of TypeScript for the new API service',
  options: [
    {
      id: 'typescript',
      name: 'TypeScript',
      description:
        'A typed superset of JavaScript that compiles to plain JavaScript',
      pros: [
        'Static type checking catches errors early',
        'Better IDE support and autocompletion',
        'Improved code maintainability',
        'Strong ecosystem and community',
      ],
      cons: [
        'Additional compilation step required',
        'Learning curve for type system',
        'Configuration complexity',
      ],
    },
  ],
  context: {
    name: 'API Service',
    description: 'Backend API service for mobile application',
    techStack: ['Node.js', 'Express', 'PostgreSQL'],
    teamSize: 3,
    phase: 'planning',
    domain: 'mobile-backend',
  },
  requestedAt: FIXED_DATE,
};

/**
 * Decision where options have trade-offs (performance vs simplicity).
 * Tests handling of conflicting factors.
 */
export const conflictingFactorsRequest: DecisionRequest = {
  id: 'performance-vs-simplicity',
  description:
    'Choose an approach for implementing real-time updates in the dashboard',
  options: [
    {
      id: 'websocket',
      name: 'WebSocket with Custom Protocol',
      description:
        'Implement custom WebSocket protocol for maximum control and performance',
      pros: [
        'Lowest latency for real-time updates',
        'Full control over the protocol',
        'Most efficient bandwidth usage',
        'Bidirectional communication',
      ],
      cons: [
        'Complex implementation and maintenance',
        'Requires custom reconnection logic',
        'More difficult to debug',
        'Team has limited WebSocket experience',
      ],
      metadata: {
        complexity: 'high',
        performance: 'excellent',
        teamFamiliarity: 'low',
      },
    },
    {
      id: 'polling',
      name: 'HTTP Long Polling',
      description:
        'Use HTTP long polling for updates with simple implementation',
      pros: [
        'Simple to implement and understand',
        'Works through all proxies and firewalls',
        'Easy to debug with standard HTTP tools',
        'Team has extensive HTTP experience',
      ],
      cons: [
        'Higher latency compared to WebSockets',
        'More server resource usage',
        'Not truly real-time',
        'Potential for connection overhead',
      ],
      metadata: {
        complexity: 'low',
        performance: 'moderate',
        teamFamiliarity: 'high',
      },
    },
    {
      id: 'sse',
      name: 'Server-Sent Events (SSE)',
      description:
        'Use SSE for server-to-client streaming with moderate complexity',
      pros: [
        'Built-in browser support',
        'Automatic reconnection',
        'Simpler than WebSockets',
        'Good for one-way updates',
      ],
      cons: [
        'One-way communication only (server to client)',
        'Limited browser connection pool',
        'May need polyfills for older browsers',
        'Less efficient for bidirectional needs',
      ],
      metadata: {
        complexity: 'medium',
        performance: 'good',
        teamFamiliarity: 'medium',
      },
    },
  ],
  context: {
    name: 'Analytics Dashboard',
    description: 'Real-time analytics dashboard showing live metrics',
    techStack: ['React', 'Node.js', 'Redis'],
    teamSize: 5,
    phase: 'development',
    domain: 'analytics',
    additionalContext: {
      updateFrequency: 'every 2-5 seconds',
      criticality: 'medium - not mission critical',
    },
  },
  requestedAt: FIXED_DATE,
};

/**
 * Request with minimal project context.
 * Tests handling of sparse context.
 */
export const minimalContextRequest: DecisionRequest = {
  id: 'minimal-context-decision',
  description: 'Choose a logging library for the application',
  options: [
    {
      id: 'winston',
      name: 'Winston',
      description: 'A versatile logging library for Node.js',
      pros: ['Multiple transport support', 'Widely used'],
      cons: ['Can be verbose to configure'],
    },
    {
      id: 'pino',
      name: 'Pino',
      description: 'A fast JSON logger for Node.js',
      pros: ['Very fast', 'Low overhead'],
      cons: ['JSON-only output by default'],
    },
  ],
  context: {
    name: 'Backend Service',
  },
  requestedAt: FIXED_DATE,
};

/**
 * Request with strict constraints.
 * Tests constraint handling with deadline, budget, required features, and exclusions.
 */
export const constrainedRequest: DecisionRequest = {
  id: 'constrained-cloud-provider',
  description: 'Select a cloud provider for hosting the new microservices platform',
  options: [
    {
      id: 'aws',
      name: 'Amazon Web Services (AWS)',
      description:
        'Comprehensive cloud platform with the widest range of services',
      pros: [
        'Most extensive service catalog',
        'Mature and battle-tested',
        'Strong enterprise support',
        'Global infrastructure',
      ],
      cons: [
        'Complex pricing structure',
        'Steep learning curve',
        'Can be expensive without optimization',
      ],
    },
    {
      id: 'gcp',
      name: 'Google Cloud Platform (GCP)',
      description:
        'Cloud platform with strong data analytics and ML capabilities',
      pros: [
        'Excellent Kubernetes support (GKE)',
        'Strong data and ML services',
        'Competitive pricing',
        'Good developer experience',
      ],
      cons: [
        'Smaller service catalog than AWS',
        'Less enterprise adoption',
        'Fewer regions globally',
      ],
    },
    {
      id: 'azure',
      name: 'Microsoft Azure',
      description:
        'Enterprise-focused cloud platform with strong hybrid capabilities',
      pros: [
        'Strong enterprise integration',
        'Excellent hybrid cloud support',
        'Good for Microsoft stack',
        'Strong compliance certifications',
      ],
      cons: [
        'Can be complex to navigate',
        'Some services lag behind AWS',
        'Portal UX could be improved',
      ],
    },
  ],
  context: {
    name: 'Microservices Platform',
    description: 'Event-driven microservices architecture for financial services',
    techStack: ['Kubernetes', 'Go', 'gRPC', 'Kafka'],
    teamSize: 20,
    phase: 'planning',
    domain: 'financial-services',
    additionalContext: {
      currentHosting: 'on-premises data center',
      migrationPriority: 'gradual over 18 months',
    },
  },
  constraints: {
    deadline: new Date('2024-03-31T00:00:00.000Z'),
    budget: { amount: 200000, currency: 'USD' },
    requiredFeatures: [
      'SOC 2 compliance',
      'HIPAA compliance',
      'managed Kubernetes',
      'private networking',
      'multi-region support',
    ],
    excludedTechnologies: [
      'IBM Cloud',
      'Oracle Cloud',
      'Alibaba Cloud',
    ],
  },
  requestedAt: FIXED_DATE,
};

// ============================================================================
// Exports
// ============================================================================

export {
  FIXED_DATE,
};
