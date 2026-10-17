import {
  rolesInviterMayGrant,
  STAFF_ROLES,
  type Role,
  type StaffRole,
} from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { formatDate } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input } from '../../../shared/ui/input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { staffApi, staffKeys } from '../api/staff-api.js';

const Schema = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  displayName: z.string().trim().max(120),
  roles: z.array(z.enum(STAFF_ROLES)).min(1, 'staff.invite.error.noRoles'),
});
type Values = z.infer<typeof Schema>;

/** Invites a person by email. The roles offered are only those the inviter may hand out. */
export function InviteStaffDialog({
  open,
  onOpenChange,
  inviterRoles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inviterRoles: readonly Role[];
}) {
  const { t } = useTranslation(['staff', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const allowed: StaffRole[] = rolesInviterMayGrant(inviterRoles);
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { email: '', displayName: '', roles: [] },
  });
  const chosen = useWatch({ control: form.control, name: 'roles' });
  // Decision D19: when an admin brings a professional in, the owners get an email.
  const owesOwnersNotice = chosen.includes('professional') && !inviterRoles.includes('owner');

  const invite = useMutation({
    mutationFn: (values: Values) =>
      staffApi(api).invite({
        email: values.email,
        roles: values.roles,
        ...(values.displayName === '' ? {} : { displayName: values.displayName }),
      }),
    onSuccess: async (result, values) => {
      toast.success(
        t('staff:invite.sent', { email: values.email, date: formatDate(result.expiresAt) }),
      );
      form.reset();
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: staffKeys.all });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });

  const conflict = isApiError(invite.error) && invite.error.code === 'conflict';
  const otherFailure = invite.isError && fieldErrorCount(invite.error) === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          invite.reset();
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
                invite.mutate(values);
              })(event);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('staff:invite.title')}</DialogTitle>
              <DialogDescription>{t('staff:invite.description')}</DialogDescription>
            </DialogHeader>

            {otherFailure ? (
              <Alert tone="danger">
                <AlertDescription>
                  {conflict
                    ? t('staff:invite.error.conflict')
                    : describeError(t, invite.error).message}
                </AlertDescription>
              </Alert>
            ) : null}

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('staff:invite.email')}</FormLabel>
                  <FormControl>
                    <Input type="email" inputMode="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('staff:invite.name')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>{t('staff:invite.nameHelp')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="roles"
              render={({ field }) => (
                <FormItem>
                  <fieldset className="grid gap-2">
                    <legend className="mb-1 text-sm font-medium">{t('staff:invite.roles')}</legend>
                    <p className="text-sm text-muted-foreground">{t('staff:invite.rolesHelp')}</p>
                    {allowed.map((role) => (
                      <CheckboxCard
                        key={role}
                        checked={field.value.includes(role)}
                        onCheckedChange={(checked) => {
                          field.onChange(
                            checked
                              ? [...field.value, role]
                              : field.value.filter((current) => current !== role),
                          );
                        }}
                        title={t(`staff:role.${role}`)}
                        description={t(`staff:role.help.${role}`)}
                      />
                    ))}
                  </fieldset>
                  {owesOwnersNotice ? (
                    <Alert tone="info">
                      <AlertDescription>{t('staff:invite.professionalNotice')}</AlertDescription>
                    </Alert>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t('common:action.cancel')}
              </Button>
              <Button type="submit" loading={invite.isPending}>
                {t('staff:invite.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
