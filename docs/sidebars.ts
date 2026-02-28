import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting Started',
      link: {
        type: 'generated-index',
        description: 'Start using Generacy with our progressive guides.',
      },
      collapsed: false,
      items: [
        'getting-started/quick-start',
        'getting-started/installation',
        'getting-started/level-1-agency-only',
        'getting-started/level-2-agency-humancy',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      link: {
        type: 'generated-index',
        description: 'Learn how to use each component of the Generacy ecosystem.',
      },
      items: [
        {
          type: 'category',
          label: 'Agency',
          items: [
            'guides/agency/overview',
            'guides/agency/configuration',
          ],
        },
        {
          type: 'category',
          label: 'Humancy',
          items: [
            'guides/humancy/overview',
            'guides/humancy/configuration',
          ],
        },
        {
          type: 'category',
          label: 'Generacy',
          items: [
            'guides/generacy/overview',
            'guides/generacy/configuration',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Plugin Development',
      link: {
        type: 'generated-index',
        description: 'Extend Generacy with custom plugins.',
      },
      items: [
        'plugins/developing-plugins',
        'plugins/agency-plugins',
        'plugins/humancy-plugins',
        'plugins/generacy-plugins',
        'plugins/manifest-reference',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      link: {
        type: 'generated-index',
        description: 'API and configuration reference documentation.',
      },
      items: [
        {
          type: 'category',
          label: 'API',
          items: [
            'reference/api/index',
          ],
        },
        {
          type: 'category',
          label: 'Configuration',
          items: [
            'reference/config/agency',
            'reference/config/humancy',
            'reference/config/generacy',
            'reference/config/orchestrator',
            'reference/config/environment-variables',
            'reference/config/docker-compose',
          ],
        },
        {
          type: 'category',
          label: 'CLI',
          items: [
            'reference/cli/commands',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      link: {
        type: 'generated-index',
        description: 'System architecture and design documentation.',
      },
      items: [
        'architecture/overview',
        'architecture/contracts',
        'architecture/security',
      ],
    },
  ],
};

export default sidebars;
