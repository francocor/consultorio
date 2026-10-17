import type { PatientSearchQuery, PatientSearchResponse } from '@consultorio/contracts';
import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { toPatientSummary } from './mapping.js';

const MAX_TOKENS = 5;
const MAX_TOKEN_LENGTH = 40;

/** Escapes the characters that mean something to LIKE, so a typed `%` is just a percent sign. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function tokensOf(query: string | undefined): string[] {
  return (query ?? '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .slice(0, MAX_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_LENGTH));
}

interface Cursor {
  family: string;
  given: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.family, cursor.given, cursor.id])).toString(
    'base64url',
  );
}

function decodeCursor(text: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((part) => typeof part === 'string')
    ) {
      const [family, given, id] = parsed as [string, string, string];
      return { family, given, id };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new AppError('validation_failed', [{ path: 'cursor', i18nKey: 'errors.field_invalid' }]);
}

/** One typed word has to match the name, the start of the document or the phone digits. */
function wordMatch(token: string): SQL {
  const name = sql`${patient.searchName} like '%' || lower(app.f_unaccent(${likeLiteral(token)})) || '%'`;
  const digits = token.replace(/\D/g, '');
  const matches: SQL[] = [name];
  if (digits.length >= 3 && digits.length === token.replace(/[\s.\-+()]/g, '').length) {
    // A number: a document starts with it, or a phone contains it.
    matches.push(sql`${patient.nationalId} like ${likeLiteral(digits) + '%'}`);
    matches.push(sql`${patient.phoneDigits} like ${'%' + likeLiteral(digits) + '%'}`);
  }
  return or(...matches) ?? name;
}

/**
 * The registry search (patients, "Search and listing"): by name, document and phone, within the
 * organization, minimal columns only, accents and case ignored, one page at a time. It never looks
 * at clinical content, and it does not need to: nothing clinical lives in these columns.
 */
export async function searchPatients(
  tx: Tx,
  query: PatientSearchQuery,
): Promise<PatientSearchResponse> {
  const conditions: (SQL | undefined)[] = tokensOf(query.q).map(wordMatch);
  if (query.status !== 'all') conditions.push(eq(patient.status, query.status));
  if (query.cursor !== undefined) {
    const after = decodeCursor(query.cursor);
    conditions.push(
      sql`(${patient.familyName}, ${patient.givenNames}, ${patient.id}) > (${after.family}, ${after.given}, ${after.id}::uuid)`,
    );
  }

  const rows = await tx
    .select()
    .from(patient)
    .where(and(...conditions))
    .orderBy(asc(patient.familyName), asc(patient.givenNames), asc(patient.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    patients: page.map(toPatientSummary),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ family: last.familyName, given: last.givenNames, id: last.id })
        : null,
  };
}
