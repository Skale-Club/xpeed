import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Car, Plus, ChevronDown, Gauge, History, Settings, Wrench, Shield,
  LogOut, Loader2, User, AlertTriangle, Bluetooth, Activity, HeartPulse,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { useCarsContext } from '@/contexts/CarsContext';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { BrandLogo } from '@/components/BrandLogo';
import { useSettings } from '@/contexts/SettingsContext';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from '@/lib/logout';
import { formatPhone } from '@/lib/phone';
import { AddVehicleForm } from '@/components/AddVehicleForm';
import { CountryFlag } from '@/components/CountryFlag';
import { LANGUAGES, currentLanguage } from '@/lib/languages';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// Everyday places first; the technical Scanner only shows with "Advanced tools" on.
// On phones Home, Trips and Problems live in the bottom tab bar, so the menu
// ("More") only lists the rest.
const NAV_ITEMS = [
  { to: '/', i18nKey: 'nav.dashboard', icon: Gauge },
  { to: '/live', i18nKey: 'nav.live', icon: Activity },
  { to: '/fuel', i18nKey: 'fuel.title', icon: History },
  { to: '/trends', i18nKey: 'trends.title', icon: HeartPulse },
  { to: '/issues', i18nKey: 'nav.issues', icon: AlertTriangle },
  { to: '/codes', i18nKey: 'codes.title', icon: Bluetooth },
  { to: '/history', i18nKey: 'nav.history', icon: History },
  { to: '/maintenance', i18nKey: 'nav.maintenance', icon: Wrench },
  { to: '/cars', i18nKey: 'nav.cars', icon: Car },
];
const ADVANCED_ITEMS = [{ to: '/scanner', i18nKey: 'nav.scanner', icon: Bluetooth }];
const SETTINGS_ITEM = { to: '/settings', i18nKey: 'nav.settings', icon: Settings };
const IN_TAB_BAR = new Set(['/', '/history', '/issues']);

// Active page: yellow text and a short yellow bar at the left edge, no fill
// (same language as the phone tab bar).
const ACTIVE_ITEM =
  'relative h-9 rounded-lg data-[active=true]:bg-transparent data-[active=true]:font-semibold data-[active=true]:text-primary ' +
  'data-[active=true]:before:absolute data-[active=true]:before:left-0 data-[active=true]:before:top-1.5 data-[active=true]:before:bottom-1.5 ' +
  'data-[active=true]:before:w-[3px] data-[active=true]:before:rounded-full data-[active=true]:before:bg-primary';

export function AppSidebar() {
  const location = useLocation();
  const { user } = useAuth();
  // The name given at onboarding, else the start of the e-mail or the phone number.
  const contact = user?.email || (user?.phone ? formatPhone(`+${user.phone.replace(/^\+/, '')}`) : '');
  const displayName = (user?.user_metadata?.full_name as string | undefined)?.trim() || user?.email?.split('@')[0] || contact || 'User';
  const { cars, selectedCar, selectedCarId, selectCar, refresh } = useCarsContext();
  const { isAdmin } = useAdminStatus();
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { setOpenMobile, isMobile } = useSidebar();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const currentLang = currentLanguage(i18n.resolvedLanguage);

  const handleNavClick = () => {
    if (isMobile) setOpenMobile(false);
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    await logout(queryClient);
  };

  const { advancedTools } = useSettings();
  const navItems = [...NAV_ITEMS, ...(advancedTools ? ADVANCED_ITEMS : []), SETTINGS_ITEM]
    .filter((item) => !(isMobile && IN_TAB_BAR.has(item.to)));
  const adminActive = location.pathname.startsWith('/admin');

  return (
    <Sidebar collapsible="icon">
      {/* Logo */}
      <SidebarHeader className="border-b border-sidebar-border">
        <Link to="/" className="flex items-center gap-3 px-2 py-2" onClick={handleNavClick}>
          <BrandLogo />
          <div className="group-data-[collapsible=icon]:hidden">
            <p className="text-sm font-bold leading-none tracking-tight">Xpeed</p>
            <p className="text-[10px] text-sidebar-foreground/50 uppercase tracking-widest font-medium mt-0.5">
              {t('sidebar.tagline', 'Your car, simply')}
            </p>
          </div>
        </Link>

        {/* Car Selector */}
        {cars.length > 0 && (
          <div className="px-2 pb-2 group-data-[collapsible=icon]:hidden">
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full gap-2 text-sm justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Car className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="truncate">{selectedCar ? selectedCar.name : t('sidebar.selectCar', 'Choose your car')}</span>
                    </div>
                    <ChevronDown className="w-3 h-3 flex-shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{t('sidebar.selectCar', 'Choose your car')}</div>
                  <DropdownMenuSeparator />
                  {cars.map((car) => (
                    <DropdownMenuItem
                      key={car.id}
                      onClick={() => selectCar(car.id)}
                      className={selectedCarId === car.id ? 'bg-accent' : ''}
                    >
                      <Car className="w-3.5 h-3.5 mr-2" />
                      <span className="truncate">{car.name}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DialogTrigger asChild>
                    <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                      <Plus className="w-3.5 h-3.5 mr-2" />
                      {t('sidebar.addCar', 'Add a car')}
                    </DropdownMenuItem>
                  </DialogTrigger>
                </DropdownMenuContent>
              </DropdownMenu>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t('sidebar.addCar', 'Add a car')}</DialogTitle>
                  <DialogDescription className="sr-only">
                    {t('sidebar.addCarHint', 'Each car keeps its own trips and problems.')}
                  </DialogDescription>
                </DialogHeader>
                <AddVehicleForm
                  onSuccess={() => { setIsAddDialogOpen(false); refresh(); }}
                  onCancel={() => setIsAddDialogOpen(false)}
                />
              </DialogContent>
            </Dialog>
          </div>
        )}
      </SidebarHeader>

      {/* Navigation */}
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
            {t('nav.navigation', 'Navigation')}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const active =
                  location.pathname === item.to ||
                  (item.to !== '/' && location.pathname.startsWith(item.to));
                const label = t(item.i18nKey, item.i18nKey.split('.').pop() ?? '');
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={active} tooltip={label} className={ACTIVE_ITEM}>
                      <Link to={item.to} onClick={handleNavClick}>
                        <item.icon />
                        <span>{label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Footer: Admin (if admin) + Language + User */}
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          {/* Admin Panel — only visible to admins */}
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={adminActive} tooltip={t('nav.admin', 'Admin')} className={ACTIVE_ITEM}>
                <Link to="/admin" onClick={handleNavClick}>
                  <Shield />
                  <span>{t('nav.admin', 'Admin')}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}

          {/* Language Switcher */}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip={currentLang.label}>
                  <CountryFlag iso={currentLang.iso} className="!h-4 !w-5" />
                  <span className="group-data-[collapsible=icon]:hidden">{currentLang.label}</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-44">
                {LANGUAGES.map((l) => (
                  <DropdownMenuItem
                    key={l.code}
                    onClick={() => i18n.changeLanguage(l.code)}
                    className={`gap-2 ${currentLang.code === l.code ? 'bg-accent' : ''}`}
                  >
                    <CountryFlag iso={l.iso} />
                    {l.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>

          {/* User Menu */}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip={displayName} className="h-auto py-1.5">
                  <User />
                  <span className="min-w-0">
                    <span className="block truncate">{displayName}</span>
                    {contact && contact !== displayName && (
                      <span className="block truncate text-xs text-sidebar-foreground/60">{contact}</span>
                    )}
                  </span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-52">
                <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">
                  {contact}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} disabled={isLoggingOut}>
                  {isLoggingOut ? (
                    <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                  ) : (
                    <LogOut className="w-3.5 h-3.5 mr-2" />
                  )}
                  {t('sidebar.signOut', 'Sign out')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
