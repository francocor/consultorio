// @ts-expect-error -- deliberately wrong: this package is not installed and must never be used
import { persistQueryClient } from '@tanstack/react-query-persist-client';

/** Deliberately wrong: the query cache would be written to the device. */
export const persist: unknown = persistQueryClient;
