import * as React from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { isPathAllowedForVertical } from '@/lib/verticalRoutes';
import { PageFallback } from '@/lib/lazyPage';
import {
  BarChart3,
  Boxes,
  Building2,
  ChevronDown,
  CreditCard,
  FolderTree,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Megaphone,
  Plus,
  UtensilsCrossed,
  Armchair,
  ChefHat,
  Calculator,
  Receipt,
  RotateCcw,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Tags,
  Users,
  UsersRound,
  Wallet,
  X,
  Pill,
  ShoppingBasket,
  Layers,
  LayoutGrid,
} from 'lucide-react';
import { toast } from 'sonner';
import { CreateWorkspaceDialog } from '@/features/workspaces/CreateWorkspaceDialog';
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
import { isPathUnlocked, isSubscriptionLocked } from '@/lib/subscriptionLock';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Any one of these permissions reveals the item. */
  anyOf?: string[];
  /**
   * Plan feature behind the page. Without it the item stays visible and
   * clickable, with a lock, so the user can see what an upgrade unlocks.
   */
  feature?: string;
  /** POS verticals the screen belongs to. Omitted means every vertical. */
  verticals?: string[];
  /** Only the account owner sees it (billing across workspaces). */
  ownerOnly?: boolean;
}

const NAV_SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Sell',
    items: [
      { to: '/pos', label: 'Point of sale', icon: ShoppingCart, anyOf: ['sales.create'] },
      { to: '/sales', label: 'Sales', icon: Receipt, anyOf: ['sales.view'], verticals: ['clothing'] },
      { to: '/returns', label: 'Returns', icon: RotateCcw, anyOf: ['returns.view'], verticals: ['clothing'] },
      { to: '/orders', label: 'Orders', icon: Receipt, anyOf: ['sales.view'], verticals: ['restaurant'] },
      { to: '/kitchen', label: 'Kitchen', icon: ChefHat, anyOf: ['sales.view'], verticals: ['restaurant'] },
      { to: '/shifts', label: 'Shifts', icon: Calculator, anyOf: ['sales.create', 'reports.view'], verticals: ['restaurant'] },
      { to: '/pharmacy-sales', label: 'Sales', icon: Receipt, anyOf: ['sales.view'], verticals: ['pharmacy'] },
      { to: '/shop-sales', label: 'Sales', icon: Receipt, anyOf: ['sales.view'], verticals: ['supershop'] },
    ],
  },
  {
    heading: 'Catalogue',
    items: [
      { to: '/catalogue', label: 'Products', icon: Tags, anyOf: ['products.view'], verticals: ['clothing'] },
      { to: '/categories', label: 'Categories', icon: FolderTree, anyOf: ['categories.view'], verticals: ['clothing'] },
      { to: '/inventory', label: 'Inventory', icon: Boxes, anyOf: ['inventory.view'], verticals: ['clothing'] },
      { to: '/menu', label: 'Menu', icon: UtensilsCrossed, anyOf: ['products.view'], verticals: ['restaurant'] },
      { to: '/tables', label: 'Tables', icon: Armchair, anyOf: ['sales.create', 'settings.edit'], verticals: ['restaurant'] },
      { to: '/medicines', label: 'Medicines', icon: Pill, anyOf: ['products.view'], verticals: ['pharmacy'] },
      { to: '/stock', label: 'Stock & expiry', icon: Boxes, anyOf: ['inventory.view'], verticals: ['pharmacy'] },
      { to: '/shop-products', label: 'Products & stock', icon: ShoppingBasket, anyOf: ['products.view'], verticals: ['supershop'] },
    ],
  },
  {
    heading: 'People',
    items: [
      { to: '/customers', label: 'Customers', icon: UsersRound, anyOf: ['customers.view'] },
      { to: '/marketing', label: 'Marketing', icon: Megaphone, anyOf: ['marketing.view'] },
      { to: '/staff', label: 'Staff', icon: Users, anyOf: ['staff.view'] },
      { to: '/roles', label: 'Roles', icon: ShieldCheck, anyOf: ['roles.view'] },
    ],
  },
  {
    heading: 'Business',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, anyOf: ['reports.view'] },
      { to: '/analytics', label: 'Advanced Analytics', icon: BarChart3, anyOf: ['reports.view'], feature: 'advancedReports' },
      { to: '/account', label: 'My POS', icon: LayoutGrid, ownerOnly: true },
      { to: '/billing', label: 'Billing', icon: Layers, ownerOnly: true },
      { to: '/subscription', label: 'Subscription', icon: CreditCard, anyOf: ['subscription.view'] },
      { to: '/wallet', label: 'Wallet', icon: Wallet, anyOf: ['wallet.view'] },
      { to: '/branches', label: 'Branches', icon: Building2, anyOf: ['settings.view'] },
      { to: '/settings', label: 'Settings', icon: Settings, anyOf: ['settings.view'] },
    ],
  },
];

export function AppLayout() {
  const { session, activeStore, can, isAccountOwner, logout, setActiveStore, switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = React.useState(false);

  const handleSwitchWorkspace = async (workspaceId: string) => {
    setSwitching(true);
    try {
      await switchWorkspace(workspaceId);
      // Every screen belongs to one workspace, so start from its dashboard.
      navigate('/dashboard', { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not switch workspace');
    } finally {
      setSwitching(false);
    }
  };

  React.useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const entitlement = session?.entitlement;
  const showBillingBanner = entitlement && !entitlement.isUsable;
  // The trial is 7 days, so warning at 7 would make this permanent chrome.
  // Three days is the point where it is genuinely a warning.
  const showTrialBanner = entitlement?.status === 'trial' && entitlement.daysRemaining <= 3;
  // Without a plan, everything except the wallet and subscription is shown as
  // locked rather than hidden - the owner should see what paying unlocks.
  const locked = isSubscriptionLocked(entitlement);

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
        {/* Store logo when one is set, otherwise the default mark. */}
        {activeStore?.logoUrl ? (
          <img
            src={activeStore.logoUrl}
            alt=""
            className="h-8 w-8 shrink-0 rounded-md bg-white object-contain p-0.5"
          />
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Store className="h-4 w-4" />
          </div>
        )}
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
          const vertical = session?.tenant?.vertical ?? 'clothing';
          const visible = section.items.filter(
            (item) =>
              (!item.anyOf || item.anyOf.some(can)) &&
              (!item.verticals || item.verticals.includes(vertical)) &&
              (!item.ownerOnly || isAccountOwner),
          );
          if (visible.length === 0) return null;
          return (
            <div key={section.heading}>
              <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
                {section.heading}
              </p>
              <div className="space-y-0.5">
                {visible.map((item) => {
                  if (locked && !isPathUnlocked(item.to)) {
                    return (
                      <div
                        key={item.to}
                        aria-disabled="true"
                        title="Activate a subscription to unlock this section"
                        className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-white/25"
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span className="flex-1">{item.label}</span>
                        <Lock className="h-3.5 w-3.5 shrink-0" />
                      </div>
                    );
                  }
                  return (
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
                      <span className="flex-1">{item.label}</span>
                      {item.feature && !entitlement?.features?.[item.feature] && (
                        <Lock className="h-3.5 w-3.5 shrink-0 opacity-60" aria-label="Upgrade to unlock" />
                      )}
                    </NavLink>
                  );
                })}
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
            {(session?.workspaces?.length ?? 0) > 1 && (
              <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">Switch workspace</DropdownMenuLabel>
                {session?.workspaces.map((workspace) => (
                  <DropdownMenuItem
                    key={workspace.id}
                    disabled={workspace.isActive || workspace.status === 'suspended' || switching}
                    onClick={() => void handleSwitchWorkspace(workspace.id)}
                  >
                    <Building2 />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{workspace.name}</span>
                      <span className="block text-xs capitalize text-muted-foreground">{workspace.vertical} POS</span>
                    </span>
                    {workspace.isActive && <Badge variant="secondary">Active</Badge>}
                    {workspace.status === 'suspended' && <Badge variant="destructive">Suspended</Badge>}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            {session?.user.role === 'admin' && (
              <>
                {/* Shown to administrators; the server allows only the account owner. */}
                <DropdownMenuItem onClick={() => setCreatingWorkspace(true)}>
                  <Plus />
                  New workspace
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
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
      <CreateWorkspaceDialog open={creatingWorkspace} onOpenChange={setCreatingWorkspace} />
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
            Only your wallet and subscription are available until you activate a plan.{' '}
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
          {/* A screen from another POS vertical is never rendered; the API refuses it too. */}
          {isPathAllowedForVertical(location.pathname, session?.tenant?.vertical) ? (
            // Inside the shell, so the sidebar stays put while a page's code loads.
            <React.Suspense fallback={<PageFallback />}>
              <Outlet />
            </React.Suspense>
          ) : (
            <Navigate to="/pos" replace />
          )}
        </main>
      </div>
    </div>
  );
}
