import { useSearch } from '@tanstack/react-router';

/** The single-use token of an emailed link (`?token=`), or undefined when it is missing. */
export function useTokenParam(): string | undefined {
  const search: unknown = useSearch({ strict: false });
  const token =
    typeof search === 'object' && search !== null && 'token' in search ? search.token : undefined;
  return typeof token === 'string' && token !== '' ? token : undefined;
}
