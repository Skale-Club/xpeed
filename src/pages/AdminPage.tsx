import AppLayout from '@/components/AppLayout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Shield, AlertTriangle, Palette } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { PageLoader } from '@/components/PageLoader';
import { useTranslation } from 'react-i18next';
import AIProviderSection from '@/components/admin/AIProviderSection';
import { AccountAIProviderSection } from '@/components/admin/AccountAIProviderSection';
import { RacingAdmin } from '@/components/social/RacingAdmin';
import { ProblemsSection } from '@/components/social/ProblemsSection';
import { PageHeader } from '@/components/ui/page-header';

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
        <PageHeader
          icon={Shield}
          title="Super-Admin Panel"
          actions={
          <Button asChild variant="outline" size="sm" className="ml-auto">
            <Link to="/admin/design"><Palette />Design system</Link>
          </Button>
          }
        />

        <Alert>
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription className="text-xs">
            The <strong>platform provider</strong> is the default across Xpeed. Its API key is stored in the
            database and consumed only by trusted Edge Functions.
          </AlertDescription>
        </Alert>

        <AIProviderSection />
        <AccountAIProviderSection />

        {/* What broke for people: errors reported by the site and by Xpeed Companion, to Xpeed's own server. Admins only. */}
        <ProblemsSection />

        {/* Racing games: the reports to decide on, the lap inspector and the plausibility recheck. Admins only. */}
        <RacingAdmin />

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
