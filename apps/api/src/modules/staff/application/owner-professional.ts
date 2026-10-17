import type { OwnerProfessionalRequest, ProfessionalDto, Role } from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { addProfessionalRoleToOwner } from '../../access/index.js';

import type { ProfileService } from './profile.js';

export interface ActivateOwnerProfessionalInput {
  actor: AuditActor & { userId: string };
  membershipId: string;
  /** Roles of the session, only used to authorize the profile write that follows. */
  roles: readonly Role[];
  country: string;
  request: OwnerProfessionalRequest;
}

export interface OwnerProfessionalService {
  /**
   * An owner acts as a health professional (decision D21, revised 2026-10-17). The owner MAY do
   * it at any time, provided the professional profile is complete, and completing it grants the
   * `professional` role. Everything happens in the caller's transaction: if the registration is
   * malformed or taken by someone else, the role is not added either.
   *
   * It is the one sanctioned way a person adds a role to themselves, and it adds `professional`
   * and nothing else. Whoever is not an ACTIVE OWNER now (read from the database, not from the
   * session) is refused.
   */
  activate(tx: Tx, input: ActivateOwnerProfessionalInput): Promise<ProfessionalDto>;
}

export function createOwnerProfessionalService(deps: {
  profiles: ProfileService;
}): OwnerProfessionalService {
  return {
    async activate(tx, input) {
      await addProfessionalRoleToOwner(tx, {
        actor: input.actor,
        membershipId: input.membershipId,
      });
      return deps.profiles.save(tx, {
        actor: input.actor,
        actorMembershipId: input.membershipId,
        actorRoles: [...new Set<Role>([...input.roles, 'professional'])],
        targetMembershipId: input.membershipId,
        country: input.country,
        request: {
          fullName: input.request.fullName,
          specialties: input.request.specialties,
          matricula: input.request.matricula,
        },
      });
    },
  };
}
