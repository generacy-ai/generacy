/**
 * Artifact-related types for the Cloud Build plugin.
 */

export interface Artifact {
  path: string;
  bucket: string;
  size: number;
  contentType?: string;
  generation?: string;
  md5Hash?: string;
  crc32c?: string;
  updated: Date;
}

export interface MavenArtifact {
  repository: string;
  path: string;
  artifactId: string;
  groupId: string;
  version?: string;
}

export interface PythonPackage {
  repository: string;
  paths: string[];
}

export interface NpmPackage {
  repository: string;
  packagePath: string;
}

export interface ArtifactObjects {
  location: string;
  paths: string[];
  timing?: {
    startTime: Date;
    endTime: Date;
  };
}

export interface BuildArtifacts {
  images?: string[];
  objects?: ArtifactObjects;
  mavenArtifacts?: MavenArtifact[];
  pythonPackages?: PythonPackage[];
  npmPackages?: NpmPackage[];
}

/** Maximum artifact size for Buffer download (100MB) */
export const MAX_ARTIFACT_SIZE_BYTES = 100 * 1024 * 1024;
