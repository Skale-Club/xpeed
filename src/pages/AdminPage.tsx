import AppLayout from '@/components/AppLayout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Shield, AlertTriangle } from 'lucide-react';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { PageLoader } from '@/components/PageLoader';
import { useTranslation } from 'react-i18next';
import AIProviderSection from '@/components/admin/AIProviderSection';

export default function AdminPage() {
  const { t } = useTranslation();
  const { isAdmin, loading: adminLoading } = useAdminStatus();

  if (adminLoading) return <PageLoader />;
  // Not an admin: say nothing about admins, e-mails or how to become one.
  if (!isAdmin) return (
    <AppLayout>
      <div className="max-w-md mx-auto pt-12 text-center space-y-2">
        <h2 className="text-lg font-bold text-foreground">{t('adminPage.notAvailable', 'Not available')}</h2>
        <p className="text-sm text-muted-foreground">{t('adminPage.notAvailableBody', 'There is nothing to see on this page.')}</p>
      </div>
    </AppLayout>
  );

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold text-foreground">Super-Admin Panel</h2>
        </div>

        <Alert>
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription className="text-xs">
            These settings are <strong>global</strong>. They affect every user of the system. Secret values
            (OpenRouter API key) are stored in the database and consumed only by trusted Edge Functions.
          </AlertDescription>
        </Alert>

        <AIProviderSection />

        {/* The logo has one source so the site, the icons and the Android app always match. */}
        <Alert>
          <AlertDescription className="text-xs">
            Logo and icons come from <code>branding/mark.svg</code> in the project. Edit it, run <code>npm run brand</code> and
            deploy: the site, favicon, home-screen icons, link preview and Android app icon all change together.
          </AlertDescription>
        </Alert>
      </div>
    </AppLayout>
  );
}
