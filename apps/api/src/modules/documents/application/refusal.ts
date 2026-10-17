import { AccessRefused } from '../../access/index.js';

/** What a denial entry of the audit trail can say about the document it was about. */
export interface RefusalContext {
  resourceId?: string;
  patientId?: string;
}

/**
 * A refusal decided by the documents module. It is an `AccessRefused` (so the routes answer the
 * uniform 403 and write the deny entry), and it carries what was known about the document when it
 * was refused, so the entry can name the document and its patient instead of only the route.
 */
export class DocumentRefused extends AccessRefused {
  readonly context: RefusalContext;

  constructor(reason: string, context: RefusalContext = {}) {
    super(reason);
    this.name = 'DocumentRefused';
    this.context = context;
  }
}
