import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDataPaths } from './paths.js';

const base = {
  localAppData: 'C:\\Users\\Ana\\AppData\\Local',
  documents: 'C:\\Users\\Ana\\Documents',
};

describe('the folders of an install', () => {
  it('keeps the data in %LOCALAPPDATA%\\Consulvia, which never roams, and the backups in Documents\\Consulvia\\Copias', () => {
    const paths = resolveDataPaths({ env: {}, ...base });

    expect(paths.root).toBe(join(base.localAppData, 'Consulvia'));
    expect(paths.pgdata).toBe(join(base.localAppData, 'Consulvia', 'pgdata'));
    expect(paths.files).toBe(join(base.localAppData, 'Consulvia', 'files'));
    expect(paths.outbox).toBe(join(base.localAppData, 'Consulvia', 'outbox'));
    expect(paths.logs).toBe(join(base.localAppData, 'Consulvia', 'logs'));
    expect(paths.configFile).toBe(join(base.localAppData, 'Consulvia', 'config.json'));
    expect(paths.backups).toBe(join(base.documents, 'Consulvia', 'Copias'));
  });

  it('moves the data with CONSULVIA_DATA_DIR and the backups with CONSULVIA_BACKUP_DIR', () => {
    const paths = resolveDataPaths({
      env: { CONSULVIA_DATA_DIR: 'D:\\Prueba\\datos', CONSULVIA_BACKUP_DIR: 'D:\\Prueba\\copias' },
      ...base,
    });

    expect(paths.root).toBe('D:\\Prueba\\datos');
    expect(paths.pgdata).toBe(join('D:\\Prueba\\datos', 'pgdata'));
    expect(paths.backups).toBe('D:\\Prueba\\copias');
    // The browser profile follows the data, so a test install never shares a lock with a real one.
    expect(paths.electronProfile).toBe(join('D:\\Prueba\\datos', 'electron-profile'));
  });

  it('ignores an empty override and refuses a relative one', () => {
    expect(resolveDataPaths({ env: { CONSULVIA_DATA_DIR: '' }, ...base }).root).toBe(
      join(base.localAppData, 'Consulvia'),
    );
    expect(() => resolveDataPaths({ env: { CONSULVIA_DATA_DIR: 'datos' }, ...base })).toThrow(
      /absolute/,
    );
  });
});
