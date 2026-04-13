import { mkdir, chmod, chown, rm, writeFile } from 'node:fs/promises';

/** Create directory recursively, then set mode */
export async function mkdirSafe(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true });
  await chmod(path, mode);
}

/** Remove directory recursively, ignoring ENOENT */
export async function rmSafe(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Write file and set mode */
export async function writeFileSafe(path: string, content: string, mode: number): Promise<void> {
  await writeFile(path, content, { mode });
}

/** Change ownership, ignoring EPERM in non-root contexts */
export async function chownSafe(path: string, uid: number, gid: number): Promise<void> {
  try {
    await chown(path, uid, gid);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    // Silently ignore EPERM - daemon may not be running as root
  }
}
