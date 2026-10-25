import { describe, expect, it } from 'vitest';

import { isCloudSynced } from './cloud-folders.js';

const BS = String.fromCharCode(92);
const win = (...parts: string[]) => parts.join(BS);

describe('a folder that a cloud service syncs', () => {
  it('is recognised by the folder OneDrive says it syncs', () => {
    const env = { OneDrive: win('C:', 'Users', 'Ana', 'OneDrive') };

    expect(
      isCloudSynced(win('C:', 'Users', 'Ana', 'OneDrive', 'Documentos', 'Consulvia'), env),
    ).toBe(true);
    expect(isCloudSynced(win('C:', 'Users', 'Ana', 'OneDrive'), env)).toBe(true);
  });

  it('is recognised by its name, when the variable is not there', () => {
    expect(isCloudSynced(win('D:', 'OneDrive - Clínica Norte', 'Copias'), {})).toBe(true);
    expect(isCloudSynced(win('C:', 'Users', 'Ana', 'Dropbox', 'Copias'), {})).toBe(true);
    expect(isCloudSynced(win('C:', 'Users', 'Ana', 'Google Drive', 'Copias'), {})).toBe(true);
  });

  it('is not triggered by a folder that only starts like one', () => {
    const env = { OneDrive: win('C:', 'Users', 'Ana', 'OneDrive') };

    expect(isCloudSynced(win('C:', 'Users', 'Ana', 'OneDriveCopias', 'x'), env)).toBe(false);
    expect(isCloudSynced(win('C:', 'Users', 'Ana', 'Documents', 'Consulvia', 'Copias'), env)).toBe(
      false,
    );
    expect(isCloudSynced(win('C:', 'Users', 'Ana', 'Documents'), {})).toBe(false);
  });
});
