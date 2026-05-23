/**
 * Parsed components from a GitHub PR URL.
 */
export interface ParsedPRUrl {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parse a GitHub PR URL into its components.
 * Returns null if the URL doesn't match the expected format.
 */
export function parsePRUrl(url: string): ParsedPRUrl | null {
  const match = url.match(/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<number>\d+)/);
  if (!match?.groups) return null;
  return {
    owner: match.groups['owner']!,
    repo: match.groups['repo']!,
    number: parseInt(match.groups['number']!, 10),
  };
}
