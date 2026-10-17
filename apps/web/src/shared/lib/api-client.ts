import {
  ERROR_CATALOG,
  PatientSummaryDto,
  Problem,
  SeriesConflictExtension,
  SlotConflictExtension,
  errorCodeForStatus,
  type ErrorCode,
  type FieldError,
} from '@consultorio/contracts';
import type { ZodType } from 'zod';

/** Where the browser reaches the API. The reverse proxy (and the dev server) strips this prefix. */
export const API_BASE = '/api';

/**
 * Endpoints where a 401 is an answer to show ("wrong password", "link expired"), not a session that
 * ended. Everywhere else a 401 means the user has to sign in again.
 */
const CREDENTIAL_ENDPOINTS =
  /^\/(?:auth\/(?:login|2fa|password-reset|invitations|me)|operator\/(?:auth|me))/;

export type ApiErrorKind = 'problem' | 'network' | 'unexpected';

/**
 * Every failure of a request. The message is only a developer hint: screens show `i18nKey`
 * translated, plus the `requestId` so support can find the entry in the logs.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;
  readonly code: ErrorCode | null;
  readonly i18nKey: string;
  readonly requestId: string | null;
  readonly fieldErrors: readonly FieldError[];
  readonly retryAfterSeconds: number | null;
  /**
   * Members a problem carries besides the standard ones. Only the ones the app knows are kept and
   * each is validated: `existingPatient` of a duplicate-document conflict, `slotConflict` (the
   * taken time and the next free times) of a booking that lost the slot, and `seriesConflict`
   * (the sessions of a series that cannot be created).
   */
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(init: {
    status: number;
    kind: ApiErrorKind;
    code: ErrorCode | null;
    i18nKey: string;
    requestId?: string | null;
    fieldErrors?: readonly FieldError[];
    retryAfterSeconds?: number | null;
    extensions?: Record<string, unknown>;
  }) {
    super(init.i18nKey);
    this.name = 'ApiError';
    this.status = init.status;
    this.kind = init.kind;
    this.code = init.code;
    this.i18nKey = init.i18nKey;
    this.requestId = init.requestId ?? null;
    this.fieldErrors = init.fieldErrors ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.extensions = init.extensions ?? {};
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** The session ended (or never existed) on a call that needs one. */
  onUnauthorized?: () => void;
  /** The organization is read only: the write was refused with 402. */
  onReadOnly?: () => void;
  /** The session can only enroll the second factor. */
  onEnrollmentRequired?: () => void;
}

type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions<T> {
  body?: unknown;
  query?: Record<string, QueryValue>;
  schema?: ZodType<T>;
  signal?: AbortSignal;
}

export interface DownloadedFile {
  blob: Blob;
  filename: string | null;
}

export interface ApiClient {
  get: <T = unknown>(path: string, options?: RequestOptions<T>) => Promise<T>;
  post: <T = unknown>(path: string, options?: RequestOptions<T>) => Promise<T>;
  put: <T = unknown>(path: string, options?: RequestOptions<T>) => Promise<T>;
  patch: <T = unknown>(path: string, options?: RequestOptions<T>) => Promise<T>;
  delete: <T = unknown>(path: string, options?: RequestOptions<T>) => Promise<T>;
  /** Sends raw bytes (a logo) instead of JSON. */
  upload: <T = unknown>(
    method: 'PUT' | 'POST',
    path: string,
    file: Blob,
    options?: RequestOptions<T>,
  ) => Promise<T>;
  download: (path: string, options?: RequestOptions<unknown>) => Promise<DownloadedFile>;
}

function withQuery(path: string, query: Record<string, QueryValue> | undefined): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? path : `${path}?${text}`;
}

function retryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}

function filenameOf(response: Response): string | null {
  const header = response.headers.get('content-disposition');
  const match = header ? /filename="?([^";]+)"?/i.exec(header) : null;
  return match?.[1] ?? null;
}

interface ParsedProblem {
  problem: Problem;
  extensions: Record<string, unknown>;
}

/** Reads a problem+json body, keeping the extensions the app knows (each one validated). */
async function readProblem(response: Response): Promise<ParsedProblem | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { existingPatient, conflict, nextSlots, occurrences, ...standard } = body as Record<
    string,
    unknown
  >;
  const parsed = Problem.safeParse(standard);
  if (!parsed.success) return null;
  const patient = PatientSummaryDto.safeParse(existingPatient);
  const slot = SlotConflictExtension.safeParse({ conflict, nextSlots });
  const series = SeriesConflictExtension.safeParse({ occurrences });
  return {
    problem: parsed.data,
    extensions: {
      ...(patient.success ? { existingPatient: patient.data } : {}),
      ...(slot.success ? { slotConflict: slot.data } : {}),
      ...(series.success ? { seriesConflict: series.data } : {}),
    },
  };
}

async function errorFrom(response: Response): Promise<ApiError> {
  const headerId = response.headers.get('x-request-id');
  const parsed = await readProblem(response);
  if (parsed) {
    const { problem } = parsed;
    return new ApiError({
      status: response.status,
      kind: 'problem',
      code: problem.code,
      i18nKey: problem.i18nKey,
      requestId: problem.requestId,
      fieldErrors: problem.errors ?? [],
      retryAfterSeconds: retryAfter(response),
      extensions: parsed.extensions,
    });
  }
  const code = errorCodeForStatus(response.status);
  return new ApiError({
    status: response.status,
    kind: 'problem',
    code,
    i18nKey: ERROR_CATALOG[code].i18nKey,
    requestId: headerId,
    retryAfterSeconds: retryAfter(response),
  });
}

/**
 * The one door from the browser to the API: same-origin cookies, problem+json parsed into
 * `ApiError`, and the three status classes the whole app reacts to (401, 402, enrollment 403)
 * reported through hooks so the client itself knows nothing about routing or UI.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? API_BASE;

  async function send(
    method: string,
    path: string,
    init: { body?: BodyInit; contentType?: string; query?: Record<string, QueryValue> },
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const headers = new Headers({ accept: 'application/json' });
    if (init.contentType) headers.set('content-type', init.contentType);
    let response: Response;
    try {
      const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
      response = await doFetch(`${baseUrl}${withQuery(path, init.query)}`, {
        method,
        headers,
        credentials: 'same-origin',
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new ApiError({
        status: 0,
        kind: 'network',
        code: null,
        i18nKey: 'errors.network',
      });
    }

    if (response.ok) return response;

    const failure = await errorFrom(response);
    if (failure.status === 401 && !CREDENTIAL_ENDPOINTS.test(path)) options.onUnauthorized?.();
    if (failure.status === 402) options.onReadOnly?.();
    if (failure.code === 'two_factor_enrollment_required') options.onEnrollmentRequired?.();
    throw failure;
  }

  async function readJson<T>(response: Response, schema: ZodType<T> | undefined): Promise<T> {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text === '') return undefined as T;
    try {
      const data: unknown = JSON.parse(text);
      return schema ? schema.parse(data) : (data as T);
    } catch {
      throw new ApiError({
        status: response.status,
        kind: 'unexpected',
        code: null,
        i18nKey: 'errors.unexpected_response',
        requestId: response.headers.get('x-request-id'),
      });
    }
  }

  function json(method: string) {
    return async <T>(path: string, requestOptions: RequestOptions<T> = {}): Promise<T> => {
      const hasBody = requestOptions.body !== undefined;
      const response = await send(
        method,
        path,
        {
          ...(hasBody
            ? { body: JSON.stringify(requestOptions.body), contentType: 'application/json' }
            : {}),
          ...(requestOptions.query ? { query: requestOptions.query } : {}),
        },
        requestOptions.signal,
      );
      return readJson(response, requestOptions.schema);
    };
  }

  return {
    get: json('GET'),
    post: json('POST'),
    put: json('PUT'),
    patch: json('PATCH'),
    delete: json('DELETE'),
    async upload<T>(
      method: 'PUT' | 'POST',
      path: string,
      file: Blob,
      requestOptions: RequestOptions<T> = {},
    ) {
      const response = await send(
        method,
        path,
        { body: file, contentType: file.type || 'application/octet-stream' },
        requestOptions.signal,
      );
      return readJson(response, requestOptions.schema);
    },
    async download(path, requestOptions = {}) {
      const response = await send(
        'GET',
        path,
        requestOptions.query ? { query: requestOptions.query } : {},
        requestOptions.signal,
      );
      return { blob: await response.blob(), filename: filenameOf(response) };
    },
  };
}
