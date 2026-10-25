import { z } from 'zod';

/**
 * The input of the commands that take a password. A password must never travel on the command line
 * (every process on the PC can list the arguments of another), so it comes from the environment of
 * the process or, with `--stdin`, from a JSON document on its standard input. Neither is ever
 * echoed: a problem names the field and says nothing about its value.
 */

export const DEFAULT_TIME_ZONE = 'America/Argentina/Buenos_Aires';

/** The time zones the database accepts (`location_time_zone_check`) that the runtime also knows. */
function isTimeZone(value: string): boolean {
  if (!/^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Control, format and separator characters: a name ends up in emails and screens as one visible line. */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const plainName = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !HIDDEN_CHARACTER.test(value));
const emailAddress = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** Same slug rule as `SINGLE_TENANT_SLUG`. */
const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/);
const password = z.string().min(1).max(1024);

const ProvisionInput = z.strictObject({
  organizationName: plainName(2, 80),
  ownerName: plainName(2, 100),
  ownerEmail: emailAddress,
  ownerPassword: password,
  timeZone: z.string().refine(isTimeZone).default(DEFAULT_TIME_ZONE),
  /** Must be the slug the install is pinned to; it is only checked, never chosen here. */
  slug: slug.optional(),
});
export type ProvisionInput = z.infer<typeof ProvisionInput>;

const ResetInput = z.strictObject({
  newPassword: password,
  /** Which owner, when the organization has more than one. */
  ownerEmail: emailAddress.optional(),
  /** Also remove the owner's second factor (the phone was lost). Off unless asked for. */
  clearSecondFactor: z.boolean().default(false),
});
export type ResetInput = z.infer<typeof ResetInput>;

export type InputRead<T> = { ok: true; value: T } | { ok: false; fields: string[] };

interface Source {
  env: NodeJS.ProcessEnv;
  /** The document read from the standard input, when the command was started with `--stdin`. */
  stdin?: string | undefined;
}

/** Variables that are set and not empty: an empty one means "not given". */
const given = (value: string | undefined) =>
  value === undefined || value === '' ? undefined : value;

function read<T>(
  schema: z.ZodType<T>,
  source: Source,
  fromEnv: () => Record<string, unknown>,
): InputRead<T> {
  let raw: unknown;
  if (source.stdin === undefined) {
    raw = Object.fromEntries(Object.entries(fromEnv()).filter(([, value]) => value !== undefined));
  } else {
    try {
      raw = JSON.parse(source.stdin);
    } catch {
      return { ok: false, fields: ['(input)'] };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, fields: ['(input)'] };
    }
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  // The names of the fields, nothing else: the issues of zod can quote the value.
  const fields = parsed.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.') || '(input)'],
  );
  return { ok: false, fields: [...new Set(fields)] };
}

export function readProvisionInput(source: Source): InputRead<ProvisionInput> {
  const { env } = source;
  return read(ProvisionInput, source, () => ({
    organizationName: given(env['PROVISION_ORGANIZATION_NAME']),
    ownerName: given(env['PROVISION_OWNER_NAME']),
    ownerEmail: given(env['PROVISION_OWNER_EMAIL']),
    ownerPassword: given(env['PROVISION_OWNER_PASSWORD']),
    timeZone: given(env['PROVISION_TIME_ZONE']),
    slug: given(env['PROVISION_SLUG']),
  }));
}

/** `RESET_CLEAR_SECOND_FACTOR`: `true` or `1` asks for it; anything that is not a yes or a no is refused. */
function booleanFlag(value: string | undefined): boolean | string | undefined {
  const text = given(value);
  if (text === undefined) return undefined;
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return text;
}

export function readResetInput(source: Source): InputRead<ResetInput> {
  const { env } = source;
  return read(ResetInput, source, () => ({
    newPassword: given(env['RESET_NEW_PASSWORD']),
    ownerEmail: given(env['RESET_OWNER_EMAIL']),
    clearSecondFactor: booleanFlag(env['RESET_CLEAR_SECOND_FACTOR']),
  }));
}
