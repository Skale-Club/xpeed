import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Upload, BarChart3, History, Settings, Gauge, SlidersHorizontal, Car, Plus, ChevronDown, Loader2, LogOut, User, Wrench, Shield } from 'lucide-react';
import { AddVehicleForm } from '@/components/AddVehicleForm';
import { useAuth } from '@/contexts/AuthContext';
import { useCarsContext } from '@/contexts/CarsContext';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from '@/hooks/use-toast';
import { ChatBubble } from '@/components/ChatBubble';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from '@/lib/logout';

const NAV_ITEMS = [
  { to: '/', i18nKey: 'nav.dashboard', icon: Gauge },
  { to: '/history', i18nKey: 'nav.history', icon: History },
  { to: '/cars', i18nKey: 'nav.cars', icon: Car },
  { to: '/maintenance', i18nKey: 'nav.maintenance', icon: Wrench },
  { to: '/settings', i18nKey: 'nav.settings', icon: Settings },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { cars, selectedCar, selectedCarId, loading: carsLoading, selectCar, refresh } = useCarsContext();
  const { isAdmin } = useAdminStatus();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const { toast } = useToast();

  const handleLogout = async () => {
    setIsLoggingOut(true);
    await logout(queryClient);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container flex items-center justify-between h-14 px-4">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-3">
              <div className="w-9 h-9 flex items-center justify-center">
                <img src="/logo.svg" alt="Car Insights AI Logo" className="w-full h-full" />
              </div>
              <div>
                <h1 className="text-base font-bold text-foreground leading-none tracking-tight">Car Insights AI</h1>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium opacity-70">Vehicle Diagnostics</p>
              </div>
            </Link>

            {/* Car Selector */}
            {cars.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2 font-mono text-xs">
                    <Car className="w-3.5 h-3.5" />
                    <span className="max-w-[120px] truncate">
                      {selectedCar ? selectedCar.name : 'Select Car'}
                    </span>
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    Select Vehicle
                  </div>
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
                  <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                    <DialogTrigger asChild>
                      <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                        <Plus className="w-3.5 h-3.5 mr-2" />
                        Add New Car
                      </DropdownMenuItem>
                    </DialogTrigger>
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
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <nav className="flex items-center gap-1">
            {[...NAV_ITEMS, ...(isAdmin ? [{ to: '/admin', i18nKey: 'nav.admin', icon: Shield }] : [])].map(item => {
              const active = location.pathname === item.to ||
                (item.to !== '/' && location.pathname.startsWith(item.to));
              const label = t(item.i18nKey, item.i18nKey.split('.').pop() ?? '');
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${active
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                >
                  <item.icon className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </Link>
              );
            })}
            <LanguageSwitcher />
            
            {/* User Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2 ml-2">
                  <User className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline text-xs">
                    {user?.email?.split('@')[0] || 'User'}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">
                  {user?.email}
                </div>
                <DropdownMenuSeparator />
                {isAdmin && (
                  <DropdownMenuItem asChild>
                    <Link to="/admin" className="flex items-center">
                      <Shield className="w-3.5 h-3.5 mr-2" />
                      Admin Panel
                    </Link>
                  </DropdownMenuItem>
                )}
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
          </nav>
        </div>
      </header>

      {/* Main */}
      <main className="container px-4 py-6">
        {children}
      </main>

      {/* Disclaimer */}
      <footer className="border-t border-border py-3 px-4 text-center">
        <p className="text-[10px] text-muted-foreground">
          This is a data-based hint, not a diagnosis. If you have warning lights or symptoms, consult a professional.
        </p>
      </footer>

      {/* Chat Bubble */}
      <ChatBubble />
    </div>
  );
}
