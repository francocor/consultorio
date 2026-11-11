import {
  LoginResponse,
  RecoveryCodesResponse,
  SessionList,
  TwoFactorEnrollStartResponse,
  type LoginRequest,
  type TwoFactorVerifyRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const SESSIONS_QUERY_KEY = ['auth', 'sessions'] as const;

/** The calls of the account area: sign in, recover access, second factor and sessions. */
export function authApi(api: ApiClient) {
  return {
    login: (body: LoginRequest) => api.post('/auth/login', { body, schema: LoginResponse }),
    verifyTwoFactor: (body: TwoFactorVerifyRequest) =>
      api.post('/auth/2fa', { body, schema: LoginResponse }),
    requestReset: (email: string) => api.post('/auth/password-reset/request', { body: { email } }),
    completeReset: (token: string, password: string) =>
      api.post('/auth/password-reset/complete', { body: { token, password } }),
    acceptInvitation: (token: string, password: string) =>
      api.post('/auth/invitations/accept', { body: { token, password } }),
    enrollStart: (password?: string) =>
      api.post('/auth/2fa/enroll/start', {
        body: password === undefined ? {} : { password },
        schema: TwoFactorEnrollStartResponse,
      }),
    enrollConfirm: (code: string) =>
      api.post('/auth/2fa/enroll/confirm', { body: { code }, schema: RecoveryCodesResponse }),
    regenerateRecoveryCodes: (password: string) =>
      api.post('/auth/2fa/recovery-codes', { body: { password }, schema: RecoveryCodesResponse }),
    disableTwoFactor: (password: string) => api.post('/auth/2fa/disable', { body: { password } }),
    sessions: () => api.get('/auth/sessions', { schema: SessionList }),
    revokeSession: (id: string) => api.delete(`/auth/sessions/${id}`),
  };
}
