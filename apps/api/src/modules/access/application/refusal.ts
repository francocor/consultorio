/**
 * A request the rules forbid. The route turns it into the uniform 403 and writes a deny entry to
 * the audit log (on its own connection, so the rollback of the request cannot erase it). The reason
 * is for the audit trail only: it never reaches the caller.
 */
export class AccessRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AccessRefused';
  }
}
