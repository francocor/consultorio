/**
 * Clinical records are kept for at least 10 years after the patient's last encounter (Ley 26.529
 * and the platform contract). The hard-delete exceptions are listed in the tenancy capability.
 */
export const AR_RETENTION = { clinicalYearsAfterLastEncounter: 10 } as const;
