import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import AdoptionLevel from '@site/src/components/AdoptionLevel';
import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <h1 className="hero__title">{siteConfig.title}</h1>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/docs/getting-started">
            Get Started - 15 min
          </Link>
        </div>
      </div>
    </header>
  );
}

const adoptionLevels = [
  {
    level: 1,
    title: 'Agency Only',
    description:
      'Start with local agent enhancement. Add tools and context to your AI coding assistant without any external dependencies.',
    components: ['Agency'],
    link: '/docs/getting-started/adoption-levels',
    difficulty: 'beginner' as const,
  },
  {
    level: 2,
    title: 'Agency + Humancy',
    description:
      'Add human oversight to your workflow. Review gates, approvals, and audit trails for your agentic processes.',
    components: ['Agency', 'Humancy'],
    link: '/docs/getting-started/adoption-levels',
    difficulty: 'intermediate' as const,
  },
  {
    level: 3,
    title: 'Local Orchestration',
    description:
      'Run the full Generacy stack locally. Orchestrate workflows, manage queues, and integrate with external services.',
    components: ['Agency', 'Humancy', 'Generacy'],
    link: '/docs/guides/generacy/overview',
    difficulty: 'intermediate' as const,
  },
  {
    level: 4,
    title: 'Cloud Deployment',
    description:
      'Deploy Generacy for your team or enterprise. Scalable orchestration with cloud integrations.',
    components: ['Agency', 'Humancy', 'Generacy', 'Cloud'],
    link: '/docs/guides/generacy/overview',
    difficulty: 'advanced' as const,
  },
];

function AdoptionPath() {
  return (
    <section className={styles.adoptionPath}>
      <div className="container">
        <h2 className={styles.sectionTitle}>Progressive Adoption</h2>
        <p className={styles.sectionSubtitle}>
          Start simple and grow your agentic capabilities at your own pace.
        </p>
        <div className={styles.adoptionGrid}>
          {adoptionLevels.map((level) => (
            <AdoptionLevel key={level.level} {...level} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className={styles.featureGrid}>
          <div className="feature-card">
            <h3>Agent Enhancement</h3>
            <p>
              Extend your AI coding assistant with custom tools, context
              providers, and project-specific capabilities.
            </p>
          </div>
          <div className="feature-card">
            <h3>Human Oversight</h3>
            <p>
              Keep humans in the loop with review gates, approval workflows, and
              comprehensive audit trails.
            </p>
          </div>
          <div className="feature-card">
            <h3>Workflow Orchestration</h3>
            <p>
              Coordinate complex multi-agent workflows with queues, scheduling,
              and external service integrations.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): JSX.Element {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`Welcome to ${siteConfig.title}`}
      description="Build more with agents. Keep humans in the loop.">
      <HomepageHeader />
      <main>
        <AdoptionPath />
        <Features />
      </main>
    </Layout>
  );
}
