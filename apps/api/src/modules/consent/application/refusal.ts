import { AccessRefused } from '../../access/index.js';

/** What a denial entry of the audit trail can say about the consent record it was about. */
export interface ConsentRefusalContext {
  resourceType?: string;
  resourceId?: string;
  patientId?: string;
}

/**
 * A refusal decided by the consent module. It is an `AccessRefused` (so the routes answer the
 * uniform 403 and write the deny entry), and it carries what was known about the record when it
 * was refused, so the entry can name the request and its patient instead of only the route.
 */
export class ConsentRefused extends AccessRefused {
  readonly context: ConsentRefusalContext;

  constructor(reason: string, context: ConsentRefusalContext = {}) {
    super(reason);
    this.name = 'ConsentRefused';
    this.context = context;
  }
}
