import type { AdfDocument, AdfNode, AdfTextNode, AdfParagraph } from '../types/events.js';

/**
 * Check if a value is an ADF document
 */
export function isAdfDocument(value: unknown): value is AdfDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    (value as AdfDocument).version === 1 &&
    'type' in value &&
    (value as AdfDocument).type === 'doc' &&
    'content' in value &&
    Array.isArray((value as AdfDocument).content)
  );
}

/**
 * Convert plain text to ADF document
 */
export function textToAdf(text: string): AdfDocument {
  // Split text into paragraphs by double newlines
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());

  const content: AdfNode[] = paragraphs.map((paragraph): AdfParagraph => {
    // Split paragraph into lines and create text nodes with hard breaks
    const lines = paragraph.split('\n');
    const inlineContent: (AdfTextNode | { type: 'hardBreak' })[] = [];

    lines.forEach((line, index) => {
      if (line.trim()) {
        inlineContent.push({ type: 'text', text: line });
      }
      if (index < lines.length - 1) {
        inlineContent.push({ type: 'hardBreak' });
      }
    });

    return {
      type: 'paragraph',
      content: inlineContent.length > 0 ? inlineContent : undefined,
    };
  });

  // If no content, create a single empty paragraph
  if (content.length === 0) {
    content.push({ type: 'paragraph' });
  }

  return {
    version: 1,
    type: 'doc',
    content,
  };
}

/**
 * Convert ADF document to plain text
 */
export function adfToText(doc: AdfDocument): string {
  const lines: string[] = [];

  function processNode(node: AdfNode | AdfTextNode | { type: string }): void {
    if (node.type === 'text' && 'text' in node) {
      lines.push((node as AdfTextNode).text);
      return;
    }

    if (node.type === 'hardBreak') {
      lines.push('\n');
      return;
    }

    if ('content' in node && Array.isArray(node.content)) {
      for (const child of node.content) {
        processNode(child as AdfNode | AdfTextNode | { type: string });
      }
    }

    // Add paragraph breaks
    if (node.type === 'paragraph' || node.type === 'heading') {
      lines.push('\n\n');
    }
  }

  for (const node of doc.content) {
    processNode(node);
  }

  return lines.join('').trim();
}

/**
 * Ensure a value is an ADF document, converting from string if necessary
 */
export function ensureAdf(value: string | AdfDocument): AdfDocument {
  if (isAdfDocument(value)) {
    return value;
  }
  return textToAdf(value);
}

/**
 * Create a simple ADF paragraph with text
 */
export function createAdfParagraph(text: string): AdfParagraph {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}

/**
 * Create an ADF document with a single paragraph
 */
export function createSimpleAdf(text: string): AdfDocument {
  return {
    version: 1,
    type: 'doc',
    content: [createAdfParagraph(text)],
  };
}
