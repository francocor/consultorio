import { z } from 'zod';

const Email = z.string().trim().pipe(z.email().max(254));
/** Raw action tokens are 43 characters; the bound only keeps hostile input small. */
const Token = z.string().min(1).max(256);
/** New passwords are checked by the password policy; this only bounds the size of the request. */
const NewPassword = z.string().min(1).max(1024);

/** Asks for a reset link. The answer is the same whether or not the account exists. */
export const PasswordResetRequest = z.strictObject({ email: Email });
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

/** Sets a new password with the token from the emailed link. */
export const PasswordResetCompleteRequest = z.strictObject({
  token: Token,
  password: NewPassword,
});
export type PasswordResetCompleteRequest = z.infer<typeof PasswordResetCompleteRequest>;

/** Accepts a staff invitation: the invitee chooses their own password. */
export const InvitationAcceptRequest = z.strictObject({
  token: Token,
  password: NewPassword,
});
export type InvitationAcceptRequest = z.infer<typeof InvitationAcceptRequest>;
