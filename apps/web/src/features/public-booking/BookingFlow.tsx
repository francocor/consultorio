import type {
  PublicBookingPageDto,
  PublicHoldRequest,
  PublicSlotDto,
  PublicSubmissionRequest,
} from '@consultorio/contracts';
import { useMutation } from '@tanstack/react-query';
import { CalendarClock, X } from 'lucide-react';
import { useEffect, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';

import { bookingKeys, publicBookingApi } from './api/booking-api.js';
import { BookingForm, type BookingFormValues } from './components/BookingForm.js';
import { CodeStep } from './components/CodeStep.js';
import { ConfirmationScreen } from './components/ConfirmationScreen.js';
import { HoldCountdown } from './components/HoldCountdown.js';
import { OfferChoice } from './components/OfferChoice.js';
import { ProfessionalChoice } from './components/ProfessionalChoice.js';
import { SlotPicker } from './components/SlotPicker.js';
import { flowReducer, initialFlow } from './domain/flow.js';
import { longDayLabel, slotLabel } from './domain/slots.js';
import { useBotChallenge } from './hooks/use-bot-challenge.js';

/** The steps the visitor sees numbered: choose a time, give their data, confirm the code. */
const STEPS = 3;
const STEP_NUMBER = { choose: 1, details: 2, code: 3, done: 3 } as const;

function toRequest(values: BookingFormValues): Omit<PublicSubmissionRequest, 'challengeProof'> {
  const phone = values.phone.trim();
  const reason = values.reason.trim();
  return {
    givenNames: values.givenNames,
    familyName: values.familyName,
    document: { type: 'dni', number: values.documentNumber.replace(/[.\s]/g, '') },
    birthDate: values.birthDate,
    email: values.email.trim().toLowerCase(),
    ...(phone === '' ? {} : { phone }),
    whatsappOptIn: values.whatsappOptIn,
    dataProcessingConsent: values.consent,
    ...(reason === '' ? {} : { reason }),
  };
}

/**
 * The whole public booking, step by step: choose a professional (when the page is the
 * organization's), a type and place (when there is a choice), a day and a time; give the data;
 * confirm with the code that arrived by email; read the confirmation. A slot that was taken, or a
 * hold that ran out, sends the visitor back to the choice of time with a plain explanation.
 */
export function BookingFlow({
  slug,
  page,
  professionalSlug,
}: {
  slug: string;
  page: PublicBookingPageDto;
  /** The professional the address names, when it names one. */
  professionalSlug: string | null;
}) {
  const { t } = useTranslation(['booking', 'common']);
  const api = publicBookingApi(useApi());
  const proofs = useBotChallenge();
  const only = page.professionals.length === 1 ? (page.professionals[0]?.slug ?? null) : null;
  const [state, dispatch] = useReducer(flowReducer, initialFlow(professionalSlug ?? only));
  const [resent, setResent] = useState(false);
  // What was typed, kept when the visitor goes back from the code to fix the address.
  const [typed, setTyped] = useState<BookingFormValues | undefined>(undefined);

  const professional = page.professionals.find((entry) => entry.slug === state.professionalSlug);
  const typeId = state.typeId ?? professional?.types[0]?.id ?? null;
  const locationId = state.locationId ?? professional?.locations[0]?.id ?? null;
  const place = professional?.locations.find((entry) => entry.id === locationId);
  const heading =
    professional && page.scope === 'professional'
      ? t('booking:title.professional', { name: professional.name })
      : t('booking:title.organization');
  usePageTitle(state.step === 'done' ? t('booking:done.title.scheduled') : heading);

  // The proof the hold needs is solved while the visitor looks at the times.
  const { warm } = proofs;
  const choosing = state.step === 'choose' && professional !== undefined;
  useEffect(() => {
    if (choosing) warm();
  }, [choosing, warm]);

  const hold = useMutation({
    mutationFn: async (slot: PublicSlotDto) => {
      if (!professional || !typeId) throw new Error('Nothing chosen');
      const body: PublicHoldRequest = {
        professional: professional.slug,
        locationId: slot.locationId,
        appointmentTypeId: typeId,
        startsAt: slot.startsAt,
        challengeProof: await proofs.take(),
      };
      return { slot, hold: await api.hold(slug, body) };
    },
    onSuccess: ({ slot, hold: created }) => {
      setResent(false);
      dispatch({ type: 'held', slot, hold: created });
    },
    onError: (error) => {
      if (
        isApiError(error) &&
        (error.code === 'slot_taken' || error.code === 'slot_no_longer_available')
      ) {
        dispatch({ type: 'lost', reason: 'slot_taken' });
      }
    },
  });

  const submit = useMutation({
    mutationFn: async (values: BookingFormValues) => {
      if (!state.hold) throw new Error('No slot held');
      return api.submit(slug, state.hold.id, {
        ...toRequest(values),
        challengeProof: await proofs.take(),
      });
    },
    onSuccess: (answer) => {
      dispatch({ type: 'submitted', maskedEmail: answer.maskedEmail });
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'slot_no_longer_available') {
        dispatch({ type: 'lost', reason: 'hold_expired' });
      }
    },
  });

  const resend = useMutation({
    mutationFn: async () => {
      if (!state.hold) throw new Error('No slot held');
      return api.resend(slug, state.hold.id, await proofs.take());
    },
    onSuccess: () => {
      setResent(true);
    },
  });

  const confirm = useMutation({
    mutationFn: async (code: string) => {
      if (!state.hold) throw new Error('No slot held');
      return api.confirm(slug, state.hold.id, code);
    },
    onSuccess: (confirmation) => {
      dispatch({ type: 'confirmed', confirmation });
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'slot_no_longer_available') {
        dispatch({ type: 'lost', reason: 'hold_expired' });
      }
    },
  });

  if (state.step === 'done' && state.confirmation) {
    return <ConfirmationScreen confirmation={state.confirmation} />;
  }

  if (page.professionals.length === 0) {
    return (
      <EmptyState
        title={t('booking:choose.professional.empty.title')}
        description={t('booking:choose.professional.empty.description')}
      />
    );
  }

  const holdFailure =
    hold.isError &&
    !(
      isApiError(hold.error) &&
      (hold.error.code === 'slot_taken' || hold.error.code === 'slot_no_longer_available')
    )
      ? describeError(t, hold.error)
      : null;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('booking:step', { current: STEP_NUMBER[state.step], total: STEPS })}
        </p>
        <PageHeader
          className="mb-0"
          title={heading}
          description={state.step === 'choose' ? t('booking:description') : undefined}
        />
      </div>

      {state.notice ? (
        <Alert tone="warning">
          <div className="flex items-start justify-between gap-3">
            <AlertDescription>{t(`booking:notice.${state.notice}`)}</AlertDescription>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('booking:notice.dismiss')}
              onClick={() => {
                dispatch({ type: 'dismissNotice' });
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </Alert>
      ) : null}

      {page.requiresApproval && state.step === 'choose' ? (
        <Alert tone="info">
          <AlertDescription>{t('booking:choose.approval')}</AlertDescription>
        </Alert>
      ) : null}

      {state.step === 'choose' ? (
        <>
          {!professional ? (
            <ProfessionalChoice
              professionals={page.professionals}
              onChoose={(next) => {
                dispatch({ type: 'professional', slug: next });
              }}
            />
          ) : (
            <>
              {page.scope === 'organization' && page.professionals.length > 1 ? (
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{professional.name}</span>
                  <Button
                    variant="link"
                    onClick={() => {
                      dispatch({ type: 'professional', slug: null });
                    }}
                  >
                    {t('booking:choose.professional.change')}
                  </Button>
                </p>
              ) : null}
              {typeId && locationId ? (
                <>
                  <OfferChoice
                    professional={professional}
                    typeId={typeId}
                    locationId={locationId}
                    onChange={(choice) => {
                      dispatch({ type: 'pick', ...choice });
                    }}
                  />
                  {holdFailure ? (
                    <Alert tone="danger">
                      <AlertDescription>{holdFailure.message}</AlertDescription>
                    </Alert>
                  ) : null}
                  {place ? (
                    <SlotPicker
                      queryKey={bookingKeys.availability(
                        slug,
                        professional.slug,
                        typeId,
                        locationId,
                      )}
                      load={(range) =>
                        api.availability(slug, {
                          professional: professional.slug,
                          typeId,
                          locationId,
                          ...range,
                        })
                      }
                      timeZone={place.timeZone}
                      pending={hold.isPending}
                      onPick={(slot) => {
                        hold.mutate(slot);
                      }}
                    />
                  ) : null}
                </>
              ) : (
                <EmptyState
                  title={t('booking:choose.professional.empty.title')}
                  description={t('booking:choose.professional.empty.description')}
                />
              )}
            </>
          )}
        </>
      ) : null}

      {state.step === 'details' || state.step === 'code' ? (
        <>
          {state.hold && state.slot && place ? (
            <div className="grid gap-3 rounded-lg border bg-card p-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <CalendarClock className="size-4 shrink-0" aria-hidden="true" />
                {t('booking:hold.summary', {
                  day: longDayLabel(state.slot.date),
                  time: slotLabel(state.slot.startsAt, place.timeZone),
                })}
              </p>
              <p className="text-muted-foreground">
                {professional?.name} · {place.name}
              </p>
              <HoldCountdown
                expiresAt={state.hold.expiresAt}
                onExpire={() => {
                  dispatch({ type: 'lost', reason: 'hold_expired' });
                }}
              />
            </div>
          ) : null}

          {state.step === 'details' ? (
            <>
              <BookingForm
                pending={submit.isPending}
                error={submit.error}
                defaults={typed}
                onValues={setTyped}
                onOpen={proofs.warm}
                onSubmit={async (values) => {
                  await submit.mutateAsync(values).catch(() => undefined);
                }}
              />
              <Button
                variant="ghost"
                className="justify-self-start"
                onClick={() => {
                  dispatch({ type: 'back' });
                }}
              >
                {t('booking:details.back')}
              </Button>
            </>
          ) : null}

          {state.step === 'code' && state.maskedEmail ? (
            <CodeStep
              maskedEmail={state.maskedEmail}
              confirming={confirm.isPending}
              resending={resend.isPending}
              resent={resent && resend.isSuccess}
              error={confirm.error ?? (resend.isError ? resend.error : null)}
              onConfirm={async (code) => {
                await confirm.mutateAsync(code).catch(() => undefined);
              }}
              onResend={async () => {
                await resend.mutateAsync().catch(() => undefined);
              }}
              onChangeEmail={() => {
                confirm.reset();
                resend.reset();
                dispatch({ type: 'back' });
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
