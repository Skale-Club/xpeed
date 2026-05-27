import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Car, Plus, ChevronDown, Gauge, History, Settings, Wrench, Shield,
  LogOut, Loader2, User, Languages, AlertTriangle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { useCarsContext } from '@/contexts/CarsContext';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { useBrand } from '@/hooks/use-brand';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from '@/lib/logout';
import { AddVehicleForm } from '@/components/AddVehicleForm';
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

const NAV_ITEMS = [
  { to: '/', i18nKey: 'nav.dashboard', icon: Gauge },
  { to: '/issues', i18nKey: 'nav.issues', icon: AlertTriangle },
  { to: '/history', i18nKey: 'nav.history', icon: History },
  { to: '/cars', i18nKey: 'nav.cars', icon: Car },
  { to: '/maintenance', i18nKey: 'nav.maintenance', icon: Wrench },
  { to: '/settings', i18nKey: 'nav.settings', icon: Settings },
];

const LANGS = [
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'pt-BR', label: 'Português', flag: '🇧🇷' },
  { code: 'es-ES', label: 'Español', flag: '🇪🇸' },
];

export function AppSidebar() {
  const location = useLocation();
  const { user } = useAuth();
  const { cars, selectedCar, selectedCarId, selectCar, refresh } = useCarsContext();
  const { isAdmin } = useAdminStatus();
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { setOpenMobile, isMobile } = useSidebar();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const brand = useBrand();
  const currentLang = LANGS.find((l) => i18n.resolvedLanguage?.startsWith(l.code.split('-')[0])) || LANGS[0];

  const handleNavClick = () => {
    if (isMobile) setOpenMobile(false);
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    await logout(queryClient);
  };

  const navItems = NAV_ITEMS;
  const adminActive = location.pathname.startsWith('/admin');

  return (
    <Sidebar collapsible="icon">
      {/* Logo */}
      <SidebarHeader className="border-b border-sidebar-border">
        <Link to="/" className="flex items-center gap-3 px-2 py-2" onClick={handleNavClick}>
          <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center">
            <img src={brand.logo_url} alt="Xpeed" className="w-full h-full object-contain" />
          </div>
          <div className="group-data-[collapsible=icon]:hidden">
            <p className="text-sm font-bold leading-none tracking-tight">Xpeed</p>
            <p className="text-[10px] text-sidebar-foreground/50 uppercase tracking-widest font-medium mt-0.5">
              Vehicle Diagnostics
            </p>
          </div>
        </Link>

        {/* Car Selector */}
        {cars.length > 0 && (
          <div className="px-2 pb-2 group-data-[collapsible=icon]:hidden">
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full gap-2 font-mono text-xs justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Car className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="truncate">{selectedCar ? selectedCar.name : 'Select Car'}</span>
                    </div>
                    <ChevronDown className="w-3 h-3 flex-shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Select Vehicle</div>
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
                      Add New Car
                    </DropdownMenuItem>
                  </DialogTrigger>
                </DropdownMenuContent>
              </DropdownMenu>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New Vehicle</DialogTitle>
                  <DialogDescription>
                    Register a new vehicle to track its OBD2 data separately.
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
                    <SidebarMenuButton asChild isActive={active} tooltip={label}>
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
              <SidebarMenuButton asChild isActive={adminActive} tooltip={t('nav.admin', 'Admin')}>
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
                  <Languages />
                  <span className="group-data-[collapsible=icon]:hidden">
                    {currentLang.flag} {currentLang.label}
                  </span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-44">
                {LANGS.map((l) => (
                  <DropdownMenuItem
                    key={l.code}
                    onClick={() => i18n.changeLanguage(l.code)}
                    className={i18n.language === l.code ? 'bg-accent' : ''}
                  >
                    <span className="mr-2">{l.flag}</span>
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
                <SidebarMenuButton tooltip={user?.email?.split('@')[0] || 'User'}>
                  <User />
                  <span>{user?.email?.split('@')[0] || 'User'}</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-52">
                <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">
                  {user?.email}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} disabled={isLoggingOut}>
                  {isLoggingOut ? (
                    <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                  ) : (
                    <LogOut className="w-3.5 h-3.5 mr-2" />
                  )}
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
