import { useContext } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from './ConfirmDialog';

function NavigationGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const { t } = useTranslation();
  return <ConfirmDialog open={blocker.state === 'blocked'}
    onOpenChange={open => { if (!open && blocker.state === 'blocked') blocker.reset(); }}
    title={t('settings.leaveTitle', 'Leave without saving?')}
    description={t('settings.leaveBody', 'Your changes have not been saved. Stay here to save them, or discard them and leave.')}
    confirmLabel={t('settings.discard', 'Discard changes')} onConfirm={() => blocker.state === 'blocked' && blocker.proceed()} />;
}

export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  const router = useContext(UNSAFE_DataRouterContext);
  return router ? <NavigationGuard dirty={dirty} /> : null;
}
