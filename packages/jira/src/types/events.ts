/**
 * ADF (Atlassian Document Format) text node mark types
 */
export type AdfMark =
  | { type: 'strong' }
  | { type: 'em' }
  | { type: 'code' }
  | { type: 'strike' }
  | { type: 'underline' }
  | { type: 'link'; attrs: { href: string; title?: string } }
  | { type: 'textColor'; attrs: { color: string } }
  | { type: 'subsup'; attrs: { type: 'sub' | 'sup' } };

/**
 * ADF text node
 */
export interface AdfTextNode {
  type: 'text';
  text: string;
  marks?: AdfMark[];
}

/**
 * ADF hard break node
 */
export interface AdfHardBreak {
  type: 'hardBreak';
}

/**
 * ADF mention node
 */
export interface AdfMention {
  type: 'mention';
  attrs: {
    id: string;
    text: string;
    accessLevel?: string;
  };
}

/**
 * ADF emoji node
 */
export interface AdfEmoji {
  type: 'emoji';
  attrs: {
    shortName: string;
    id?: string;
    text?: string;
  };
}

/**
 * ADF inline card node
 */
export interface AdfInlineCard {
  type: 'inlineCard';
  attrs: {
    url: string;
  };
}

/**
 * ADF inline node types
 */
export type AdfInlineNode = AdfTextNode | AdfHardBreak | AdfMention | AdfEmoji | AdfInlineCard;

/**
 * ADF paragraph node
 */
export interface AdfParagraph {
  type: 'paragraph';
  content?: AdfInlineNode[];
}

/**
 * ADF heading node
 */
export interface AdfHeading {
  type: 'heading';
  attrs: { level: 1 | 2 | 3 | 4 | 5 | 6 };
  content?: AdfInlineNode[];
}

/**
 * ADF code block node
 */
export interface AdfCodeBlock {
  type: 'codeBlock';
  attrs?: { language?: string };
  content?: AdfTextNode[];
}

/**
 * ADF list item node
 */
export interface AdfListItem {
  type: 'listItem';
  content: AdfNode[];
}

/**
 * ADF bullet list node
 */
export interface AdfBulletList {
  type: 'bulletList';
  content: AdfListItem[];
}

/**
 * ADF ordered list node
 */
export interface AdfOrderedList {
  type: 'orderedList';
  attrs?: { order?: number };
  content: AdfListItem[];
}

/**
 * ADF table cell node
 */
export interface AdfTableCell {
  type: 'tableCell' | 'tableHeader';
  attrs?: {
    colspan?: number;
    rowspan?: number;
    colwidth?: number[];
    background?: string;
  };
  content: AdfNode[];
}

/**
 * ADF table row node
 */
export interface AdfTableRow {
  type: 'tableRow';
  content: AdfTableCell[];
}

/**
 * ADF table node
 */
export interface AdfTable {
  type: 'table';
  attrs?: {
    isNumberColumnEnabled?: boolean;
    layout?: 'default' | 'wide' | 'full-width';
  };
  content: AdfTableRow[];
}

/**
 * ADF panel node
 */
export interface AdfPanel {
  type: 'panel';
  attrs: {
    panelType: 'info' | 'note' | 'warning' | 'success' | 'error';
  };
  content: AdfNode[];
}

/**
 * ADF blockquote node
 */
export interface AdfBlockquote {
  type: 'blockquote';
  content: AdfNode[];
}

/**
 * ADF rule (horizontal line) node
 */
export interface AdfRule {
  type: 'rule';
}

/**
 * ADF media single node
 */
export interface AdfMediaSingle {
  type: 'mediaSingle';
  attrs?: {
    layout?: 'center' | 'wrap-left' | 'wrap-right' | 'wide' | 'full-width';
  };
  content: AdfMedia[];
}

/**
 * ADF media node
 */
export interface AdfMedia {
  type: 'media';
  attrs: {
    id: string;
    type: 'file' | 'link' | 'external';
    collection: string;
    width?: number;
    height?: number;
  };
}

/**
 * All ADF block node types
 */
export type AdfNode =
  | AdfParagraph
  | AdfHeading
  | AdfCodeBlock
  | AdfBulletList
  | AdfOrderedList
  | AdfTable
  | AdfPanel
  | AdfBlockquote
  | AdfRule
  | AdfMediaSingle;

/**
 * ADF document structure
 */
export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

/**
 * Jira comment with visibility options
 */
export interface JiraComment {
  id: string;
  self: string;
  author: {
    accountId: string;
    displayName: string;
    avatarUrls: Record<string, string>;
  };
  body: AdfDocument;
  created: string;
  updated: string;
  visibility: CommentVisibility | null;
}

/**
 * Comment visibility restriction
 */
export interface CommentVisibility {
  type: 'group' | 'role';
  value: string;
}

/**
 * Parameters for adding a comment
 */
export interface AddCommentParams {
  body: string | AdfDocument;
  visibility?: CommentVisibility;
}
