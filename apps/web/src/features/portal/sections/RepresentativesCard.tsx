import type { PortalLinkDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatCalendarDay } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { toast } from '../../../shared/ui/toaster.js';
import { portalApi, portalKeys } from '../api/portal-api.js';

/**
 * Who represents the patient. An adult who was a minor sees here the people who looked at their
 * record, authorizes the one whose access was paused when they turned 18, or ends it. Nothing shows
 * for somebody who has no representative.
 */
export function RepresentativesCard({ link }: { link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const queryClient = useQueryClient();
  const key = portalKeys.section(link.id, 'representatives');
  const query = useQuery({ queryKey: key, queryFn: () => api.representatives() });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const authorize = useMutation({
    mutationFn: (id: string) => api.authorizeLink(id),
    onSuccess: async () => {
      toast.success(t('representatives.authorized'));
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeLink(id),
    onSuccess: async () => {
      toast.success(t('representatives.revoked'));
      await refresh();
    },
  });
  const error = authorize.error ?? revoke.error;

  if (!query.data || query.data.representatives.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('representatives.title')}</CardTitle>
        <CardDescription>{t('representatives.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, error).message}</AlertDescription>
          </Alert>
        ) : null}
        <ul className="grid gap-3">
          {query.data.representatives.map((representative) => (
            <li key={representative.id} className="grid gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {t(`subject.relation.${representative.relation}`)}
                </span>
                <span className="tabular break-all text-sm text-muted-foreground">
                  {representative.maskedEmail}
                </span>
                <Badge tone={representative.status === 'suspended' ? 'warning' : 'success'}>
                  {t(`representatives.status.${representative.status}`)}
                </Badge>
              </div>
              {representative.status === 'suspended' ? (
                <p className="text-sm text-muted-foreground">
                  {t('representatives.suspendedHint', {
                    date: formatCalendarDay(representative.majorityReviewOn),
                  })}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {representative.status === 'suspended' ? (
                  <Button
                    size="sm"
                    loading={authorize.isPending}
                    onClick={() => {
                      authorize.mutate(representative.id);
                    }}
                  >
                    {t('representatives.authorize')}
                  </Button>
                ) : null}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      {t('representatives.end')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('representatives.endDialog.title')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('representatives.endDialog.description')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('representatives.endDialog.keep')}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          revoke.mutate(representative.id);
                        }}
                      >
                        {t('representatives.endDialog.confirm')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
