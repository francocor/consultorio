import { FDI_CODES } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { ARCHES, mesialSide, moveFocus, setTooth, summarizeTooth } from './geometry.js';

describe('the arches of the chart', () => {
  it('lay out the four rows as a dentist reads them: the patient right is on the left of the screen', () => {
    expect(ARCHES.permanentUpper.map(String)).toEqual([
      '18',
      '17',
      '16',
      '15',
      '14',
      '13',
      '12',
      '11',
      '21',
      '22',
      '23',
      '24',
      '25',
      '26',
      '27',
      '28',
    ]);
    expect(ARCHES.permanentLower.slice(0, 3)).toEqual(['48', '47', '46']);
    expect(ARCHES.permanentLower.slice(-3)).toEqual(['36', '37', '38']);
    expect(ARCHES.primaryUpper).toEqual([
      '55',
      '54',
      '53',
      '52',
      '51',
      '61',
      '62',
      '63',
      '64',
      '65',
    ]);
    expect(ARCHES.primaryLower).toEqual([
      '85',
      '84',
      '83',
      '82',
      '81',
      '71',
      '72',
      '73',
      '74',
      '75',
    ]);
  });

  it('together cover every FDI tooth exactly once', () => {
    const all = [
      ...ARCHES.permanentUpper,
      ...ARCHES.permanentLower,
      ...ARCHES.primaryUpper,
      ...ARCHES.primaryLower,
    ];

    expect([...all].sort()).toEqual([...FDI_CODES].sort());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('mesialSide', () => {
  it('faces the midline: right of the drawing for the teeth drawn on the left, and the other way', () => {
    expect(mesialSide('11')).toBe('right');
    expect(mesialSide('18')).toBe('right');
    expect(mesialSide('41')).toBe('right');
    expect(mesialSide('21')).toBe('left');
    expect(mesialSide('38')).toBe('left');
    expect(mesialSide('55')).toBe('right');
    expect(mesialSide('61')).toBe('left');
    expect(mesialSide('75')).toBe('left');
    expect(mesialSide('85')).toBe('right');
  });
});

describe('moveFocus', () => {
  it('moves along the row with the arrows and stops at the ends', () => {
    expect(moveFocus('16', 'ArrowRight')).toBe('15');
    expect(moveFocus('16', 'ArrowLeft')).toBe('17');
    expect(moveFocus('18', 'ArrowLeft')).toBe('18');
    expect(moveFocus('28', 'ArrowRight')).toBe('28');
    expect(moveFocus('16', 'Home')).toBe('18');
    expect(moveFocus('16', 'End')).toBe('28');
  });

  it('goes from the upper to the lower arch with up and down, to the tooth below', () => {
    expect(moveFocus('16', 'ArrowDown')).toBe('46');
    expect(moveFocus('46', 'ArrowUp')).toBe('16');
    expect(moveFocus('26', 'ArrowDown')).toBe('36');
    expect(moveFocus('16', 'ArrowUp')).toBe('16');
    expect(moveFocus('55', 'ArrowDown')).toBe('85');
  });

  it('ignores any other key', () => {
    expect(moveFocus('16', 'a')).toBeNull();
  });
});

describe('summarizeTooth', () => {
  it('says nothing was recorded for an empty tooth', () => {
    expect(summarizeTooth(undefined)).toEqual({ condition: null, surfaces: [] });
    expect(summarizeTooth({})).toEqual({ condition: null, surfaces: [] });
  });

  it('lists the condition and the surfaces that carry a finding or a treatment', () => {
    expect(
      summarizeTooth({
        condition: 'caries',
        surfaces: {
          occlusal: { finding: 'caries', treatment: 'Restauración' },
          mesial: { treatment: 'Control' },
          distal: {},
        },
      }),
    ).toEqual({ condition: 'caries', surfaces: ['mesial', 'occlusal'] });
  });
});

describe('setTooth', () => {
  it('replaces the record of one tooth without touching the others', () => {
    const before = {
      '16': { condition: 'caries' as const },
      '26': { condition: 'healthy' as const },
    };

    const after = setTooth(before, '16', { condition: 'restoration' });

    expect(after).toEqual({ '16': { condition: 'restoration' }, '26': { condition: 'healthy' } });
    expect(before['16']).toEqual({ condition: 'caries' });
  });

  it('removes the tooth when nothing is left on it', () => {
    const before = {
      '16': { condition: 'caries' as const },
      '26': { condition: 'healthy' as const },
    };

    expect(setTooth(before, '16', {})).toEqual({ '26': { condition: 'healthy' } });
    expect(setTooth(before, '16', { surfaces: {} })).toEqual({ '26': { condition: 'healthy' } });
    expect(setTooth(before, '16', undefined)).toEqual({ '26': { condition: 'healthy' } });
  });

  it('drops a surface with nothing recorded and keeps the others', () => {
    const next = setTooth({}, '16', {
      surfaces: { occlusal: { finding: 'caries' }, mesial: {}, distal: { treatment: '' } },
    });

    expect(next).toEqual({ '16': { surfaces: { occlusal: { finding: 'caries' } } } });
  });
});
