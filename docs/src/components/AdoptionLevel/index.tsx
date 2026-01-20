import React from 'react';
import Link from '@docusaurus/Link';
import clsx from 'clsx';
import styles from './styles.module.css';

interface AdoptionLevelProps {
  level: number;
  title: string;
  description: string;
  components: string[];
  link: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
}

const difficultyLabels = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

export default function AdoptionLevel({
  level,
  title,
  description,
  components,
  link,
  difficulty,
}: AdoptionLevelProps): JSX.Element {
  return (
    <div className={clsx('adoption-card', styles.card)}>
      <span className={clsx('badge', `badge-${difficulty}`, styles.badge)}>
        {difficultyLabels[difficulty]}
      </span>
      <h3 className={styles.title}>
        Level {level}: {title}
      </h3>
      <p className={styles.description}>{description}</p>
      <div className={styles.components}>
        {components.map((component) => (
          <span key={component} className={styles.component}>
            {component}
          </span>
        ))}
      </div>
      <Link className="button button--primary button--sm" to={link}>
        Get Started
      </Link>
    </div>
  );
}
