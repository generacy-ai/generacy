/**
 * Project reference (lightweight)
 */
export interface ProjectRef {
  id: string;
  key: string;
  name: string;
  self: string;
}

/**
 * Full project representation
 */
export interface Project {
  id: string;
  key: string;
  name: string;
  self: string;
  description?: string;
  lead?: {
    accountId: string;
    displayName: string;
  };
  projectTypeKey: string;
  simplified: boolean;
  style: 'classic' | 'next-gen';
  isPrivate: boolean;
  avatarUrls: {
    '16x16': string;
    '24x24': string;
    '32x32': string;
    '48x48': string;
  };
}

/**
 * Agile board representation
 */
export interface Board {
  id: number;
  self: string;
  name: string;
  type: 'scrum' | 'kanban' | 'simple';
  location?: {
    projectId: number;
    projectKey: string;
    projectName: string;
  };
}
