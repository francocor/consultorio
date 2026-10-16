import type { AuditAction } from '@consultorio/contracts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The audit actions a state-changing route writes. A route that changes nothing worth an audit
     * entry says `'none'`. The audit-coverage policy test (S1.23) fails a mutating route that
     * declares neither, so a new endpoint cannot ship without a decision about its audit trail.
     */
    audits?: readonly AuditAction[] | 'none';
  }
}

export {};
