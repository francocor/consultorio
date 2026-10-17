import {
  FDI_PERMANENT,
  FDI_PRIMARY,
  type Odontogram,
  type ToothRecord,
  type ToothSurface,
} from '@consultorio/contracts';

/**
 * The layout of the odontogram, as pure data. A chart is read the way a dentist faces the patient:
 * the patient's right side (quadrants 1 and 4, 5 and 8) is on the LEFT of the drawing, and within
 * each quadrant the teeth run from the back (8 or 5) to the front (1).
 */
const BACK_TO_FRONT = (quadrant: number, last: number) =>
  Array.from({ length: last }, (_, index) => `${String(quadrant)}${String(last - index)}`);
const FRONT_TO_BACK = (quadrant: number, last: number) =>
  Array.from({ length: last }, (_, index) => `${String(quadrant)}${String(index + 1)}`);

export const ARCHES = {
  permanentUpper: [...BACK_TO_FRONT(1, 8), ...FRONT_TO_BACK(2, 8)],
  permanentLower: [...BACK_TO_FRONT(4, 8), ...FRONT_TO_BACK(3, 8)],
  primaryUpper: [...BACK_TO_FRONT(5, 5), ...FRONT_TO_BACK(6, 5)],
  primaryLower: [...BACK_TO_FRONT(8, 5), ...FRONT_TO_BACK(7, 5)],
} as const;

export type ArchName = keyof typeof ARCHES;

const ROWS: readonly (readonly string[])[] = [
  ARCHES.permanentUpper,
  ARCHES.permanentLower,
  ARCHES.primaryUpper,
  ARCHES.primaryLower,
];

/** The permanent and primary codes, so the chart and the contract agree (a test compares). */
export const ALL_TEETH: readonly string[] = [...FDI_PERMANENT, ...FDI_PRIMARY];

/** Quadrants drawn on the left of the chart: the mesial face of their teeth looks to the right. */
const LEFT_QUADRANTS = new Set(['1', '4', '5', '8']);

/** Which side of a tooth's drawing is its mesial face (the one toward the midline). */
export function mesialSide(code: string): 'left' | 'right' {
  return LEFT_QUADRANTS.has(code.charAt(0)) ? 'right' : 'left';
}

/** Where the keyboard focus goes from a tooth, or null when the key does nothing here. */
export function moveFocus(code: string, key: string): string | null {
  const rowIndex = ROWS.findIndex((row) => row.includes(code));
  const row = ROWS[rowIndex];
  if (!row) return null;
  const column = row.indexOf(code);
  const last = row.length - 1;
  switch (key) {
    case 'ArrowLeft':
      return row[Math.max(0, column - 1)] ?? code;
    case 'ArrowRight':
      return row[Math.min(last, column + 1)] ?? code;
    case 'Home':
      return row[0] ?? code;
    case 'End':
      return row[last] ?? code;
    case 'ArrowDown':
    case 'ArrowUp': {
      // The rows come in pairs: upper then lower arch, permanent then primary.
      const pair = rowIndex % 2 === 0 ? rowIndex + 1 : rowIndex - 1;
      const goingDown = key === 'ArrowDown';
      if (goingDown !== (rowIndex % 2 === 0)) return code;
      return ROWS[pair]?.[column] ?? code;
    }
    default:
      return null;
  }
}

function hasContent(
  value: { finding?: string | undefined; treatment?: string | undefined } | undefined,
) {
  return value !== undefined && (value.finding !== undefined || (value.treatment ?? '') !== '');
}

export interface ToothSummary {
  condition: ToothRecord['condition'] | null;
  /** The surfaces with a finding or a treatment, in the order of the chart. */
  surfaces: ToothSurface[];
}

const SURFACE_ORDER: readonly ToothSurface[] = [
  'mesial',
  'distal',
  'occlusal',
  'vestibular',
  'lingual',
];

export function summarizeTooth(record: ToothRecord | undefined): ToothSummary {
  return {
    condition: record?.condition ?? null,
    surfaces: SURFACE_ORDER.filter((surface) => hasContent(record?.surfaces?.[surface])),
  };
}

/** The odontogram with one tooth replaced. A tooth with nothing left on it is removed. */
export function setTooth(
  chart: Odontogram,
  code: string,
  record: ToothRecord | undefined,
): Odontogram {
  const others = Object.fromEntries(Object.entries(chart).filter(([key]) => key !== code));
  if (!record) return others;
  const surfaces = Object.fromEntries(
    SURFACE_ORDER.flatMap((surface) => {
      const entry = record.surfaces?.[surface];
      if (!entry) return [];
      const kept = {
        ...(entry.finding === undefined ? {} : { finding: entry.finding }),
        ...((entry.treatment ?? '') === '' ? {} : { treatment: entry.treatment }),
      };
      return Object.keys(kept).length === 0 ? [] : [[surface, kept] as const];
    }),
  );
  const next: ToothRecord = {
    ...(record.condition === undefined ? {} : { condition: record.condition }),
    ...(Object.keys(surfaces).length === 0 ? {} : { surfaces }),
    ...((record.note ?? '') === '' ? {} : { note: record.note }),
  };
  return Object.keys(next).length === 0 ? others : { ...others, [code]: next };
}
