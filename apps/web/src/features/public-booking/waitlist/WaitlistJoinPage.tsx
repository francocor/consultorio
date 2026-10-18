import type {
  PublicBookingPageDto,
  PublicWaitlistJoinedResponse,
  PublicWaitlistJoinRequest,
} from '@consultorio/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatDate } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { Skeleton } from '../../../shared/ui/skeleton.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { preferencesBody, type Preferences } from '../../waitlist/index.js';
import { bookingKeys, publicBookingApi } from '../api/booking-api.js';
import { UnavailablePage } from '../components/UnavailablePage.js';
import { useBotChallenge } from '../hooks/use-bot-challenge.js';

import { waitlistJoinApi } from './api/join-api.js';
import { JoinCodeStep } from './JoinCodeStep.js';
import { JoinForm, type JoinFormValues } from './JoinForm.js';

/** What the visitor typed, kept when they come back from the code step to fix the address. */
interface Typed {
  values: JoinFormValues;
  preferences: Preferences;
}

type Step =
  | { name: 'form' }
  | { name: 'code'; id: string; maskedEmail: string }
  | { name: 'done'; email: string; result: PublicWaitlistJoinedResponse };

/**
 * `/book/{slug}/p/{professionalSlug}/waitlist`: the page where a visitor who found no free time
 * asks to be offered one when it frees up. It loads what the professional's link exposes (the same
 * answer as the booking page), lets the visitor confirm the type and the place, takes their data and
 * the agreement to be written to, and ends with the code that proves the address. An address that
 * does not work is the generic unavailable page.
 */
export function WaitlistJoinPage({
  slug,
  professionalSlug,
  typeId,
  locationId,
}: {
  slug: string;
  professionalSlug: string;
  /** The type the visitor was choosing a time for, when they came from the booking page. */
  typeId: string | undefined;
  locationId: string | undefined;
}) {
  const api = publicBookingApi(useApi());
  const page = useQuery({
    queryKey: bookingKeys.page(slug, professionalSlug),
    queryFn: () => api.professionalPage(slug, professionalSlug),
    retry: false,
    staleTime: 30_000,
  });

  if (page.isPending) {
    return (
      <div role="status" aria-busy="true" className="grid gap-4">
        <Skeleton className="h-8 w-2/3" />
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
  return (
    <JoinFlow
      slug={slug}
      professionalSlug={professionalSlug}
      page={page.data}
      typeId={typeId}
      locationId={locationId}
    />
  );
}

function JoinFlow({
  slug,
  professionalSlug,
  page,
  typeId: wantedType,
  locationId: wantedLocation,
}: {
  slug: string;
  professionalSlug: string;
  page: PublicBookingPageDto;
  typeId: string | undefined;
  locationId: string | undefined;
}) {
  const { t } = useTranslation(['waitlist', 'booking', 'common']);
  const api = waitlistJoinApi(useApi());
  const proofs = useBotChallenge();
  const professional = page.professionals[0];
  const [typeId, setTypeId] = useState(
    professional?.types.find((type) => type.id === wantedType)?.id ??
      professional?.types[0]?.id ??
      '',
  );
  // "" means any place. A place that is not one of the link's own is not carried over.
  const [placeId, setPlaceId] = useState(
    professional?.locations.find((place) => place.id === wantedLocation)?.id ?? '',
  );
  const [step, setStep] = useState<Step>({ name: 'form' });
  const [typed, setTyped] = useState<Typed | undefined>(undefined);
  const [resent, setResent] = useState(false);

  usePageTitle(step.name === 'done' ? t('waitlist:join.done.title') : t('waitlist:join.title'));

  // The proof the form needs is solved while the visitor looks at it.
  const { warm } = proofs;
  useEffect(() => {
    if (step.name === 'form') warm();
  }, [step.name, warm]);

  const join = useMutation({
    mutationFn: async ({ values, preferences }: Typed) => {
      const body: PublicWaitlistJoinRequest = {
        professional: professionalSlug,
        appointmentTypeId: typeId,
        ...(placeId === '' ? {} : { locationId: placeId }),
        ...preferencesBody(preferences),
        givenNames: values.givenNames,
        familyName: values.familyName,
        document: { type: 'dni', number: values.documentNumber.replace(/[.\s]/g, '') },
        birthDate: values.birthDate,
        email: values.email.trim().toLowerCase(),
        ...(values.phone.trim() === '' ? {} : { phone: values.phone.trim() }),
        channels: values.whatsapp ? ['email', 'whatsapp'] : ['email'],
        offersOptIn: values.optIn,
        dataProcessingConsent: values.consent,
        challengeProof: await proofs.take(),
      };
      return api.join(slug, body);
    },
    onSuccess: (answer) => {
      setResent(false);
      setStep({ name: 'code', id: answer.id, maskedEmail: answer.maskedEmail });
    },
  });
  const resend = useMutation({
    mutationFn: async () => {
      if (step.name !== 'code') throw new Error('No request to continue');
      return api.resend(slug, step.id, await proofs.take());
    },
    onSuccess: () => {
      setResent(true);
    },
  });
  const confirm = useMutation({
    mutationFn: async (code: string) => {
      if (step.name !== 'code') throw new Error('No request to continue');
      return api.confirm(slug, step.id, code);
    },
    onSuccess: (result) => {
      setStep({ name: 'done', email: typed?.values.email ?? '', result });
    },
  });

  if (!professional || professional.types.length === 0) return <UnavailablePage />;
  const back = `/book/${slug}/p/${professionalSlug}`;

  if (step.name === 'done') {
    return (
      <section aria-labelledby="join-done" className="grid gap-4">
        <div className="grid justify-items-start gap-2">
          <span className="grid size-10 place-content-center rounded-full bg-success-soft text-success-soft-foreground">
            <CircleCheck className="size-5" aria-hidden="true" />
          </span>
          <h1 id="join-done" className="font-display text-2xl font-semibold tracking-tight">
            {t('waitlist:join.done.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('waitlist:join.done.description', {
              email: step.email,
              date: formatDate(step.result.expiresAt),
            })}
          </p>
        </div>
        <p className="text-sm">{t('waitlist:join.done.how')}</p>
        <Button asChild variant="outline">
          <a href={back}>{t('waitlist:join.done.back')}</a>
        </Button>
      </section>
    );
  }

  return (
    <div className="grid gap-5">
      <PageHeader
        className="mb-0"
        title={t('waitlist:join.title')}
        description={t('waitlist:join.description', { name: professional.name })}
      />

      {step.name === 'form' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="join-type">{t('waitlist:join.type')}</Label>
              <Select
                id="join-type"
                value={typeId}
                onChange={(event) => {
                  setTypeId(event.target.value);
                }}
              >
                {professional.types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="join-place">{t('waitlist:join.place')}</Label>
              <Select
                id="join-place"
                value={placeId}
                onChange={(event) => {
                  setPlaceId(event.target.value);
                }}
              >
                <option value="">{t('waitlist:join.anyPlace')}</option>
                {professional.locations.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <Alert tone="info">
            <AlertDescription>{t('waitlist:join.how')}</AlertDescription>
          </Alert>
          <JoinForm
            pending={join.isPending}
            error={join.error}
            defaults={typed}
            onOpen={warm}
            onSubmit={async (values, preferences) => {
              const next = { values, preferences };
              setTyped(next);
              await join.mutateAsync(next).catch(() => undefined);
            }}
          />
        </>
      ) : (
        <JoinCodeStep
          maskedEmail={step.maskedEmail}
          confirming={confirm.isPending}
          resending={resend.isPending}
          resent={resent}
          error={confirm.error ?? resend.error}
          onConfirm={async (code) => {
            await confirm.mutateAsync(code).catch(() => undefined);
          }}
          onResend={async () => {
            await resend.mutateAsync().catch(() => undefined);
          }}
          onChangeEmail={() => {
            confirm.reset();
            resend.reset();
            join.reset();
            setStep({ name: 'form' });
          }}
        />
      )}
    </div>
  );
}
