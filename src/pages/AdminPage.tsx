import AppLayout from '@/components/AppLayout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Shield, AlertTriangle } from 'lucide-react';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { PageLoader } from '@/components/PageLoader';
import BrandingSection from '@/components/admin/BrandingSection';
import AIProviderSection from '@/components/admin/AIProviderSection';

export default function AdminPage() {
  const { isAdmin, loading: adminLoading } = useAdminStatus();

  if (adminLoading) return <PageLoader />;
  if (!isAdmin) return (
    <AppLayout>
      <div className="max-w-md mx-auto pt-12 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-destructive" />
          <h2 className="text-lg font-mono font-bold text-foreground">Admin Access Required</h2>
        </div>
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription className="text-xs space-y-2">
            <p>Your account is not marked as admin in the database.</p>
            <p className="font-mono bg-destructive/10 rounded px-2 py-1 mt-2 select-all">
              UPDATE public.car_profiles SET is_admin = true WHERE user_id = (SELECT id FROM auth.users WHERE email = 'skale.club@gmail.com' LIMIT 1);
            </p>
            <p>Run the SQL above no <strong>Supabase Dashboard → SQL Editor</strong>, depois recarregue a página.</p>
          </AlertDescription>
        </Alert>
      </div>
    </AppLayout>
  );

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-mono font-bold text-foreground">Super-Admin Panel</h2>
        </div>

        <Alert>
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription className="text-xs">
            These settings are <strong>global</strong>. They affect every user of the system. Secret values
            (OpenRouter API key) are stored in the database and consumed only by trusted Edge Functions.
          </AlertDescription>
        </Alert>

        <AIProviderSection />

        <BrandingSection />
      </div>
    </AppLayout>
  );
}
