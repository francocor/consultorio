import { win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDataPaths } from './paths.js';

const base = {
  localAppData: 'C:\\Users\\Ana\\AppData\\Local',
  documents: 'C:\\Users\\Ana\\Documents',
};

describe('the folders of an install', () => {
  it('keeps the data in %LOCALAPPDATA%\\Consulvia, which never roams, and the backups in Documents\\Consulvia\\Copias', () => {
    const paths = resolveDataPaths({ env: {}, ...base });

    expect(paths.root).toBe(win32.join(base.localAppData, 'Consulvia'));
    expect(paths.pgdata).toBe(win32.join(base.localAppData, 'Consulvia', 'pgdata'));
    expect(paths.files).toBe(win32.join(base.localAppData, 'Consulvia', 'files'));
    expect(paths.outbox).toBe(win32.join(base.localAppData, 'Consulvia', 'outbox'));
    expect(paths.logs).toBe(win32.join(base.localAppData, 'Consulvia', 'logs'));
    expect(paths.configFile).toBe(win32.join(base.localAppData, 'Consulvia', 'config.json'));
    expect(paths.backups).toBe(win32.join(base.documents, 'Consulvia', 'Copias'));
  });

  it('moves the data with CONSULVIA_DATA_DIR and the backups with CONSULVIA_BACKUP_DIR', () => {
    const paths = resolveDataPaths({
      env: { CONSULVIA_DATA_DIR: 'D:\\Prueba\\datos', CONSULVIA_BACKUP_DIR: 'D:\\Prueba\\copias' },
      ...base,
    });

    expect(paths.root).toBe('D:\\Prueba\\datos');
    expect(paths.pgdata).toBe(win32.join('D:\\Prueba\\datos', 'pgdata'));
    expect(paths.backups).toBe('D:\\Prueba\\copias');
    // The browser profile follows the data, so a test install never shares a lock with a real one.
    expect(paths.electronProfile).toBe(win32.join('D:\\Prueba\\datos', 'electron-profile'));
  });

  it('ignores an empty override and refuses a relative one', () => {
    expect(resolveDataPaths({ env: { CONSULVIA_DATA_DIR: '' }, ...base }).root).toBe(
      win32.join(base.localAppData, 'Consulvia'),
    );
    expect(() => resolveDataPaths({ env: { CONSULVIA_DATA_DIR: 'datos' }, ...base })).toThrow(
      /absolute/,
    );
  });
});
