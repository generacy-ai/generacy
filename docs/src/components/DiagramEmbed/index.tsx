import React from 'react';
import styles from './styles.module.css';

interface DiagramEmbedProps {
  src: string;
  alt: string;
  caption?: string;
  width?: string | number;
}

export default function DiagramEmbed({
  src,
  alt,
  caption,
  width = '100%',
}: DiagramEmbedProps): JSX.Element {
  return (
    <figure className={styles.diagramContainer}>
      <img
        src={src}
        alt={alt}
        className={styles.diagram}
        style={{ width: typeof width === 'number' ? `${width}px` : width }}
        loading="lazy"
      />
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
    </figure>
  );
}
