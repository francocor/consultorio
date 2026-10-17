export type { NoteStatus } from '@consultorio/contracts';

/** Why a reader may open an entry: wrote it, treats the patient, or reads it through sharing. */
export type ReadBasisName = 'author' | 'treating' | 'shared';
