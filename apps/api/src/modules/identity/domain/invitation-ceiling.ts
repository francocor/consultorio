/**
 * Who may hand out which staff role. The rule lives in `@consultorio/contracts`, so the web app
 * shows the same choices the API accepts, and the access module applies the same ceiling to role
 * changes as invitations apply to new members.
 */
export { canGrantRoles, rolesInviterMayGrant } from '@consultorio/contracts';
