import type { Runner } from './runner.js';

/** What the bundle's one-shot commands answer, from "Exit codes" in docs/desktop/design.md. */
export const EXIT = { ok: 0, failed: 1, invalidInput: 2, invalidConfig: 3, refused: 4 } as const;

export class ApiCommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    /** The JSON line the command wrote to its standard error, when it wrote one. */
    readonly body: Record<string, unknown> | null,
    /** The tail of the standard error, for the log. The commands never print a secret. */
    readonly stderr: string,
  ) {
    super(`${command} failed (${exitCode === null ? 'killed' : `exit ${String(exitCode)}`})`);
    this.name = 'ApiCommandError';
  }

  /** `invalid_input`, `password_rejected`, `email_in_use`... */
  get reason(): string | null {
    const value = this.body?.['error'];
    return typeof value === 'string' ? value : null;
  }

  /** For `password_rejected`: `too_short`, `common`... */
  get passwordIssues(): string[] {
    const issues = this.body?.['issues'];
    return Array.isArray(issues)
      ? issues.filter((item): item is string => typeof item === 'string')
      : [];
  }

  /** For `invalid_input`: the names of the fields. */
  get fields(): string[] {
    const fields = this.body?.['fields'];
    return Array.isArray(fields)
      ? fields.filter((item): item is string => typeof item === 'string')
      : [];
  }
}

export interface ProvisionInput {
  organizationName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  timeZone: string;
}

export interface ProvisionResult {
  result: 'created' | 'exists';
  tenantId: string;
  slug: string;
}

export interface ResetPasswordInput {
  newPassword: string;
  clearSecondFactor: boolean;
}

export interface ResetPasswordResult {
  email: string;
  secondFactorCleared: boolean;
  /** True when the notice to the owner was written to the outbox. */
  ownerNotified: boolean;
}

export interface ApiCommandsOptions {
  runner: Runner;
  /** The Electron executable: with `ELECTRON_RUN_AS_NODE=1` it is a Node 24. */
  nodeExe: string;
  /** `main.js` of the API bundle. */
  mainJs: string;
  /** The folder the bundle expects as its working directory (it finds `assets/` from there). */
  cwd: string;
}

function lastJson(text: string): Record<string, unknown> | null {
  const line = text
    .trim()
    .split(/\r?\n/)
    .filter((candidate) => candidate.trim() !== '')
    .at(-1);
  if (line === undefined) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The one-shot commands of the API bundle. Passwords travel on the standard input as JSON and never in
 * an argument or in the environment of the child; nothing here logs the input.
 */
export function createApiCommands(options: ApiCommandsOptions) {
  async function run(
    command: string,
    env: NodeJS.ProcessEnv,
    input: Record<string, unknown> | undefined,
    timeoutMs: number,
  ) {
    const result = await options.runner(
      options.nodeExe,
      [options.mainJs, command, ...(input ? ['--stdin'] : [])],
      {
        cwd: options.cwd,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        input: input ? JSON.stringify(input) : undefined,
        timeoutMs,
      },
    );
    if (result.code !== EXIT.ok) {
      throw new ApiCommandError(
        command,
        result.code,
        lastJson(result.stderr),
        result.stderr.trim().split(/\r?\n/).slice(-8).join('\n'),
      );
    }
    return result.stdout;
  }

  return {
    /** Applies the pending migrations and loads the catalogs. Safe to repeat. Returns its progress lines. */
    async migrate(env: NodeJS.ProcessEnv): Promise<string> {
      return run('migrate', env, undefined, 10 * 60_000);
    },

    async provision(env: NodeJS.ProcessEnv, input: ProvisionInput): Promise<ProvisionResult> {
      const stdout = await run('provision', env, { ...input }, 10 * 60_000);
      const body = lastJson(stdout);
      const result = body?.['result'];
      const tenantId = body?.['tenantId'];
      const slug = body?.['slug'];
      if (
        (result !== 'created' && result !== 'exists') ||
        typeof tenantId !== 'string' ||
        typeof slug !== 'string'
      ) {
        throw new ApiCommandError('provision', EXIT.ok, null, 'unexpected output');
      }
      return { result, tenantId, slug };
    },

    async resetPassword(
      env: NodeJS.ProcessEnv,
      input: ResetPasswordInput,
    ): Promise<ResetPasswordResult> {
      const stdout = await run('reset-password', env, { ...input }, 5 * 60_000);
      const body = lastJson(stdout);
      const email = body?.['email'];
      if (body?.['result'] !== 'reset' || typeof email !== 'string') {
        throw new ApiCommandError('reset-password', EXIT.ok, null, 'unexpected output');
      }
      return {
        email,
        secondFactorCleared: body['secondFactorCleared'] === true,
        ownerNotified: body['ownerNotified'] === true,
      };
    },
  };
}

export type ApiCommands = ReturnType<typeof createApiCommands>;
