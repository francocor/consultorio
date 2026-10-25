import { sep } from 'node:path';

/** The environment variables Windows sets to the folders OneDrive syncs. */
const ONEDRIVE_VARIABLES = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'];

/** Folder names that mean "this one is synced to the internet". */
const SYNCED_SEGMENT = /^(?:onedrive(?: - .*)?|dropbox|google drive|icloud ?drive)$/i;

const lowerWithSeparators = (path: string) => path.replaceAll('/', sep).toLowerCase();

/**
 * True when `path` is inside a folder that a cloud service syncs (OneDrive, mostly: Windows moves Documents
 * under it when "folder backup" is on). The backups are encrypted, so this is a notice and not a refusal.
 */
export function isCloudSynced(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = lowerWithSeparators(path);
  for (const name of ONEDRIVE_VARIABLES) {
    const root = env[name];
    if (root === undefined || root === '') continue;
    const prefix = lowerWithSeparators(root).replace(/[\\/]+$/, '');
    if (normalized === prefix || normalized.startsWith(prefix + sep)) return true;
  }
  return normalized.split(sep).some((segment) => SYNCED_SEGMENT.test(segment));
}
