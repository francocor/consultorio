import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What ships next to the shell. The installed app and the staging folder of a development run have the
 * same layout, so the code never asks which one it is in:
 *
 *   api/dist/main.js, api/dist/migrations, api/assets, api/node_modules   the API bundle and its modules
 *   web/                                                                   apps/web/dist
 *   postgres/bin, postgres/lib, postgres/share                             PostgreSQL 17 (initdb, pg_ctl, postgres)
 *   tools/                                                                 pg_dump.exe, pg_restore.exe and their DLLs
 *   sql/01-roles.sql                                                       the role script of infra/postgres/init
 *   icons/                                                                 tray.png, window.png
 */
export interface Resources {
  root: string;
  apiDir: string;
  mainJs: string;
  webRoot: string;
  pgBinDir: string;
  pgDump: string;
  pgRestore: string;
  rolesSql: string;
  passwordList: string;
  migrationsJournal: string;
  trayIcon: string;
  windowIcon: string;
}

export function resolveResources(root: string): Resources {
  const apiDir = join(root, 'api');
  return {
    root,
    apiDir,
    mainJs: join(apiDir, 'dist', 'main.js'),
    webRoot: join(root, 'web'),
    pgBinDir: join(root, 'postgres', 'bin'),
    pgDump: join(root, 'tools', 'pg_dump.exe'),
    pgRestore: join(root, 'tools', 'pg_restore.exe'),
    rolesSql: join(root, 'sql', '01-roles.sql'),
    passwordList: join(apiDir, 'assets', 'common-passwords-100k.txt'),
    migrationsJournal: join(apiDir, 'dist', 'migrations', 'meta', '_journal.json'),
    trayIcon: join(root, 'icons', 'tray.png'),
    windowIcon: join(root, 'icons', 'window.png'),
  };
}

/** The files the shell cannot run without; the names of the missing ones, for a message that says what is wrong. */
export function missingResources(resources: Resources): string[] {
  const required = [
    resources.mainJs,
    join(resources.webRoot, 'index.html'),
    join(resources.pgBinDir, 'initdb.exe'),
    join(resources.pgBinDir, 'pg_ctl.exe'),
    join(resources.pgBinDir, 'postgres.exe'),
    resources.pgDump,
    resources.pgRestore,
    resources.rolesSql,
    resources.passwordList,
    resources.migrationsJournal,
  ];
  return required.filter((path) => !existsSync(path));
}

/** How many migrations the bundle carries: a backup of a newer database cannot be restored by this app. */
export function migrationCountOf(resources: Resources): number {
  const journal = JSON.parse(readFileSync(resources.migrationsJournal, 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}
