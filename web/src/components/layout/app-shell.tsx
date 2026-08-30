import { BarChart3, KeyRound, LogOut, Menu, Moon, Settings, Sun, Waypoints } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/auth-store';
import { useThemeStore } from '../../stores/theme-store';
import { Logo } from '../shared/logo';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';

const navigation = [
  { to: '/', label: 'نظرة عامة', icon: BarChart3 },
  { to: '/models', label: 'إدارة النماذج', icon: Waypoints },
  { to: '/keys', label: 'مفاتيح API', icon: KeyRound },
  { to: '/settings', label: 'الإعدادات', icon: Settings },
];

function Navigation({ onSelect }: { onSelect?: () => void }) {
  return (
    <nav className="space-y-1 px-3" aria-label="التنقل الرئيسي">
      {navigation.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          onClick={onSelect}
          className={({ isActive }) =>
            cn(
              'flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors duration-150',
              isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
            )
          }
        >
          <Icon className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function SidebarFooter() {
  const navigate = useNavigate();
  const logout = useAuthStore((state) => state.logout);
  const { theme, setTheme } = useThemeStore();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="mt-auto border-t border-border p-3">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={theme === 'dark' ? 'تفعيل الوضع الفاتح' : 'تفعيل الوضع الداكن'}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
        <Button variant="ghost" className="flex-1 justify-start text-muted-foreground" onClick={handleLogout}>
          <LogOut />
          تسجيل الخروج
        </Button>
      </div>
    </div>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 right-0 z-40 hidden w-60 flex-col border-l border-border bg-card md:flex">
        <div className="flex h-16 items-center border-b border-border px-5">
          <Logo />
        </div>
        <div className="py-4">
          <Navigation />
        </div>
        <SidebarFooter />
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur-md md:hidden">
        <Logo />
        <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="فتح القائمة">
          <Menu />
        </Button>
      </header>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="right" className="max-w-72">
          <SheetTitle className="sr-only">القائمة الرئيسية</SheetTitle>
          <div className="flex h-16 items-center border-b border-border px-5">
            <Logo />
          </div>
          <div className="py-4">
            <Navigation onSelect={() => setMobileOpen(false)} />
          </div>
          <SidebarFooter />
        </SheetContent>
      </Sheet>

      <main className="md:mr-60">
        <div className="mx-auto w-full max-w-[1440px] p-4 sm:p-6 lg:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
