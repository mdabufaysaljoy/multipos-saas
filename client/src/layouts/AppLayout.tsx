import * as React from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  Boxes,
  ChevronDown,
  CreditCard,
  FolderTree,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  RotateCcw,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Tags,
  Users,
  UsersRound,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Any one of these permissions reveals the item. */
  anyOf?: string[];
}

const NAV_SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Sell',
    items: [
      { to: '/pos', label: 'Point of sale', icon: ShoppingCart, anyOf: ['sales.create'] },
      { to: '/sales', label: 'Sales', icon: Receipt, anyOf: ['sales.view'] },
      { to: '/returns', label: 'Returns', icon: RotateCcw, anyOf: ['returns.view'] },
    ],
  },
  {
    heading: 'Catalogue',
    items: [
      { to: '/products', label: 'Products', icon: Tags, anyOf: ['products.view'] },
      { to: '/categories', label: 'Categories', icon: FolderTree, anyOf: ['categories.view'] },
      { to: '/inventory', label: 'Inventory', icon: Boxes, anyOf: ['inventory.view'] },
    ],
  },
  {
    heading: 'People',
    items: [
      { to: '/customers', label: 'Customers', icon: UsersRound, anyOf: ['customers.view'] },
      { to: '/staff', label: 'Staff', icon: Users, anyOf: ['staff.view'] },
      { to: '/roles', label: 'Roles', icon: ShieldCheck, anyOf: ['roles.view'] },
    ],
  },
  {
    heading: 'Business',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, anyOf: ['reports.view'] },
      { to: '/reports', label: 'Reports', icon: BarChart3, anyOf: ['reports.view'] },
      { to: '/subscription', label: 'Subscription', icon: CreditCard, anyOf: ['subscription.view'] },
      { to: '/settings', label: 'Settings', icon: Settings, anyOf: ['settings.view'] },
    ],
  },
];

export function AppLayout() {
  const { session, activeStore, can, logout, setActiveStore } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const entitlement = session?.entitlement;
  const showBillingBanner = entitlement && !entitlement.isUsable;
  const showTrialBanner = entitlement?.status === 'trial' && entitlement.daysRemaining <= 7;

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const initials = (session?.user.name ?? '?')
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const sidebar = (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2.5 border-b border-white/10 px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Store className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{session?.tenant?.name ?? 'Clothing POS'}</p>
          <p className="truncate text-xs text-white/50">{activeStore?.name ?? 'No store'}</p>
        </div>
        <button
          type="button"
          className="rounded p-1 text-white/60 hover:bg-white/10 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav className="scrollbar-thin flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {NAV_SECTIONS.map((section) => {
          const visible = section.items.filter((item) => !item.anyOf || item.anyOf.some(can));
          if (visible.length === 0) return null;
          return (
            <div key={section.heading}>
              <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
                {section.heading}
              </p>
              <div className="space-y-0.5">
                {visible.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        isActive ? 'bg-primary text-primary-foreground' : 'text-white/70 hover:bg-white/10 hover:text-white',
                      )
                    }
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-white/10 p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-white/10">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-white">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{session?.user.name}</p>
                <p className="truncate text-xs text-white/50">
                  {session?.user.role === 'admin' ? 'Administrator' : 'Staff'}
                </p>
              </div>
              <ChevronDown className="h-4 w-4 shrink-0 text-white/50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <p className="text-sm font-medium">{session?.user.name}</p>
              <p className="text-xs text-muted-foreground">{session?.user.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {(session?.stores.length ?? 0) > 1 && (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">Switch store</DropdownMenuLabel>
                {session?.stores.map((store) => (
                  <DropdownMenuItem key={store.id} onClick={() => setActiveStore(store.id)}>
                    <Store />
                    <span className="flex-1">{store.name}</span>
                    {store.id === activeStore?.id && <Badge variant="secondary">Active</Badge>}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={() => navigate('/settings')}>
              <Settings />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem destructive onClick={handleLogout}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-64">{sidebar}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4 lg:px-6">
          <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <div className="flex-1" />
          {can('sales.create') && location.pathname !== '/pos' && (
            <Button size="sm" onClick={() => navigate('/pos')}>
              <ShoppingCart />
              Open POS
            </Button>
          )}
        </header>

        {showBillingBanner && (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive lg:px-6">
            <strong className="font-semibold">
              {entitlement.status === 'suspended' ? 'Workspace suspended.' : 'Subscription expired.'}
            </strong>{' '}
            You can still view your data, but new sales and edits are blocked.{' '}
            <button className="font-semibold underline" onClick={() => navigate('/subscription')}>
              Review your plan
            </button>
          </div>
        )}

        {showTrialBanner && !showBillingBanner && (
          <div className="border-b border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning lg:px-6">
            Your trial ends in {entitlement.daysRemaining} day{entitlement.daysRemaining === 1 ? '' : 's'}.{' '}
            <button className="font-semibold underline" onClick={() => navigate('/subscription')}>
              Choose a plan
            </button>
          </div>
        )}

        <main className="scrollbar-thin flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
