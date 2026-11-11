import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../app/providers.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { Skeleton } from '../../shared/ui/skeleton.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';

import { bookingKeys, publicBookingApi } from './api/booking-api.js';
import { BookingFlow } from './BookingFlow.js';
import { UnavailablePage } from './components/UnavailablePage.js';

/**
 * `/book/{slug}` (the organization) and `/book/{slug}/p/{professionalSlug}` (one professional). It
 * loads what the link exposes and hands it to the flow. An address that does not work is the generic
 * unavailable page: the API answers every such case with the same 404.
 */
export function BookingPage({
  slug,
  professionalSlug,
}: {
  slug: string;
  professionalSlug: string | null;
}) {
  const api = publicBookingApi(useApi());
  const page = useQuery({
    queryKey: bookingKeys.page(slug, professionalSlug),
    queryFn: () =>
      professionalSlug === null
        ? api.organizationPage(slug)
        : api.professionalPage(slug, professionalSlug),
    retry: false,
    staleTime: 30_000,
  });

  if (page.isPending) {
    return (
      <div role="status" aria-busy="true" className="grid gap-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (page.isError) {
    if (isApiError(page.error) && page.error.status === 404) return <UnavailablePage />;
    return (
      <ErrorState
        error={page.error}
        onRetry={() => {
          void page.refetch();
        }}
      />
    );
  }
  return <BookingFlow slug={slug} page={page.data} professionalSlug={professionalSlug} />;
}
