import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stethoscope, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { formatDate } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Select } from '../../../shared/ui/input.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { staffApi, staffKeys } from '../../staff/api/staff-api.js';
import { patientKeys, patientsApi } from '../api/patients-api.js';

import { Section } from './Section.js';

/**
 * Who looks after the patient. An explicit assignment lets a professional record the anamnesis
 * before the first appointment; whoever administers patients decides, never the professional.
 */
export function CareTab({ patientId, canAssign }: { patientId: string; canAssign: boolean }) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const assignments = useQuery({
    queryKey: patientKeys.assignments(patientId),
    queryFn: () => patientsApi(api).assignments(patientId),
  });

  const unassign = useMutation({
    mutationFn: (professionalId: string) => patientsApi(api).unassign(patientId, professionalId),
    onSuccess: async () => {
      toast.success(t('patients:care.removed'));
      await queryClient.invalidateQueries({ queryKey: patientKeys.assignments(patientId) });
    },
    onError: (error) => {
      toast.error(describeError(t, error).message);
    },
  });

  if (assignments.isPending) return <ListSkeleton rows={2} />;
  if (assignments.isError) {
    return (
      <ErrorState
        error={assignments.error}
        onRetry={() => {
          void assignments.refetch();
        }}
      />
    );
  }
  const addButton = canAssign ? (
    <Button
      onClick={() => {
        setAdding(true);
      }}
    >
      <UserPlus aria-hidden="true" />
      {t('patients:care.add')}
    </Button>
  ) : null;

  return (
    <>
      {assignments.data.length === 0 ? (
        <EmptyState
          icon={Stethoscope}
          title={t('patients:care.empty')}
          description={t('patients:care.description')}
          action={addButton}
        />
      ) : (
        <Section
          title={t('patients:care.title')}
          description={t('patients:care.description')}
          action={addButton}
        >
          <ul className="grid gap-3">
            {assignments.data.map((assignment) => {
              const name = assignment.professionalName ?? assignment.professionalId;
              return (
                <li
                  key={assignment.professionalId}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="grid gap-0.5">
                    <span className="font-medium">{name}</span>
                    <span className="text-sm text-muted-foreground">
                      {t('patients:care.assignedOn', { date: formatDate(assignment.assignedAt) })}
                    </span>
                  </div>
                  {canAssign ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('patients:care.remove', { name })}
                      onClick={() => {
                        unassign.mutate(assignment.professionalId);
                      }}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      <AssignDialog patientId={patientId} open={adding} onOpenChange={setAdding} />
    </>
  );
}

const Schema = z.object({ professionalId: z.string().min(1, 'validation.required') });
type Values = z.infer<typeof Schema>;

function AssignDialog({
  patientId,
  open,
  onOpenChange,
}: {
  patientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { professionalId: '' },
  });

  const staff = useQuery({
    queryKey: staffKeys.list(false),
    queryFn: () => staffApi(api).list(false),
    enabled: open,
  });
  const professionals = (staff.data ?? []).flatMap((member) =>
    member.professional?.status === 'active'
      ? [
          {
            id: member.professional.id,
            name: member.displayName ?? member.email ?? member.professional.id,
          },
        ]
      : [],
  );

  const assign = useMutation({
    mutationFn: (values: Values) => patientsApi(api).assign(patientId, values.professionalId),
    onSuccess: async () => {
      toast.success(t('patients:care.assigned'));
      form.reset();
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: patientKeys.assignments(patientId) });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, { professionalId: 'professionalId' });
    },
  });
  const failed = assign.isError && fieldErrorCount(assign.error) === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          assign.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <Form {...form}>
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                assign.mutate(values);
              })(event);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('patients:care.add')}</DialogTitle>
              <DialogDescription>{t('patients:care.description')}</DialogDescription>
            </DialogHeader>
            {staff.isError ? <ErrorState error={staff.error} /> : null}
            {failed ? (
              <Alert tone="danger">
                <AlertDescription>
                  {isApiError(assign.error) && assign.error.status === 403
                    ? t('patients:care.selfDenied')
                    : describeError(t, assign.error).message}
                </AlertDescription>
              </Alert>
            ) : null}
            {staff.isSuccess && professionals.length === 0 ? (
              <Alert tone="info">
                <AlertDescription>{t('patients:care.noneAvailable')}</AlertDescription>
              </Alert>
            ) : (
              <FormField
                control={form.control}
                name="professionalId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('patients:care.label')}</FormLabel>
                    <FormControl>
                      <Select {...field} disabled={staff.isPending}>
                        <option value="">{t('patients:care.choose')}</option>
                        {professionals.map((professional) => (
                          <option key={professional.id} value={professional.id}>
                            {professional.name}
                          </option>
                        ))}
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t('common:action.cancel')}
              </Button>
              <Button type="submit" loading={assign.isPending}>
                {t('patients:care.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
