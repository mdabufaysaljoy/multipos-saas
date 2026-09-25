import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/layouts/AppLayout';
import { PublicLayout } from '@/layouts/PublicLayout';
import { ProtectedRoute, PublicOnlyRoute } from '@/routes/ProtectedRoute';
import { lazyPage } from '@/lib/lazyPage';

// Layouts and route guards load up front; every page is its own chunk, fetched
// the first time its route is visited. The Suspense boundaries live in the
// layouts (around <Outlet>) and in main.tsx for pages outside any layout.

// Public site
const HomePage = lazyPage(() => import('@/pages/public/HomePage'), 'HomePage');
const PricingPage = lazyPage(() => import('@/pages/public/PricingPage'), 'PricingPage');
const PublicProductsPage = lazyPage(() => import('@/pages/public/ProductsPage'), 'PublicProductsPage');
const ContactPage = lazyPage(() => import('@/pages/public/ContactPage'), 'ContactPage');
const PosProductPage = lazyPage(() => import('@/pages/public/PosProductPage'), 'PosProductPage');
const FeaturesPage = lazyPage(() => import('@/pages/public/FeaturesPage'), 'FeaturesPage');

// Sign-in and setup
const LoginPage = lazyPage(() => import('@/pages/LoginPage'), 'LoginPage');
const RegisterPage = lazyPage(() => import('@/pages/RegisterPage'), 'RegisterPage');
const OnboardingPage = lazyPage(() => import('@/pages/OnboardingPage'), 'OnboardingPage');

// Platform administration
const PlatformPage = lazyPage(() => import('@/pages/PlatformPage'), 'PlatformPage');
const WorkspacePage = lazyPage(() => import('@/pages/WorkspacePage'), 'WorkspacePage');
const PlatformAccountPage = lazyPage(() => import('@/pages/PlatformAccountPage'), 'PlatformAccountPage');

// Vertical-aware screens (each loads only its own vertical's page)
const VerticalPos = lazyPage(() => import('@/routes/VerticalPos'), 'VerticalPos');
const VerticalDashboard = lazyPage(() => import('@/routes/VerticalDashboard'), 'VerticalDashboard');
const VerticalAnalytics = lazyPage(() => import('@/routes/VerticalAnalytics'), 'VerticalAnalytics');

// Clothing POS
const SalesPage = lazyPage(() => import('@/pages/SalesPage'), 'SalesPage');
const ReturnsPage = lazyPage(() => import('@/pages/ReturnsPage'), 'ReturnsPage');
const CreateReturnPage = lazyPage(() => import('@/pages/CreateReturnPage'), 'CreateReturnPage');
const ProductsPage = lazyPage(() => import('@/pages/ProductsPage'), 'ProductsPage');
const CategoriesPage = lazyPage(() => import('@/pages/CategoriesPage'), 'CategoriesPage');
const InventoryPage = lazyPage(() => import('@/pages/InventoryPage'), 'InventoryPage');

// Restaurant POS
const MenuPage = lazyPage(() => import('@/pages/restaurant/MenuPage'), 'MenuPage');
const TablesPage = lazyPage(() => import('@/pages/restaurant/TablesPage'), 'TablesPage');
const OrdersPage = lazyPage(() => import('@/pages/restaurant/OrdersPage'), 'OrdersPage');
const KitchenPage = lazyPage(() => import('@/pages/restaurant/KitchenPage'), 'KitchenPage');
const ShiftsPage = lazyPage(() => import('@/pages/restaurant/ShiftsPage'), 'ShiftsPage');

// Pharmacy POS
const MedicinesPage = lazyPage(() => import('@/pages/pharmacy/MedicinesPage'), 'MedicinesPage');
const StockPage = lazyPage(() => import('@/pages/pharmacy/StockPage'), 'StockPage');
const PharmacySalesPage = lazyPage(() => import('@/pages/pharmacy/PharmacySalesPage'), 'PharmacySalesPage');

// Supershop POS
const ShopProductsPage = lazyPage(() => import('@/pages/supershop/ShopProductsPage'), 'ShopProductsPage');
const ShopInventoryPage = lazyPage(() => import('@/pages/supershop/ShopInventoryPage'), 'ShopInventoryPage');
const ShopReturnsPage = lazyPage(() => import('@/pages/supershop/ShopReturnsPage'), 'ShopReturnsPage');
const ShopCategoriesPage = lazyPage(() => import('@/pages/supershop/ShopCategoriesPage'), 'ShopCategoriesPage');
const PharmacyCategoriesPage = lazyPage(() => import('@/pages/pharmacy/PharmacyCategoriesPage'), 'PharmacyCategoriesPage');
const MenuCategoriesPage = lazyPage(() => import('@/pages/restaurant/MenuCategoriesPage'), 'MenuCategoriesPage');
const PharmacyReturnsPage = lazyPage(() => import('@/pages/pharmacy/PharmacyReturnsPage'), 'PharmacyReturnsPage');
const RestaurantRefundsPage = lazyPage(() => import('@/pages/restaurant/RestaurantRefundsPage'), 'RestaurantRefundsPage');
const ShopSalesPage = lazyPage(() => import('@/pages/supershop/ShopSalesPage'), 'ShopSalesPage');

// Shared workspace screens
const CustomersPage = lazyPage(() => import('@/pages/CustomersPage'), 'CustomersPage');
const LoyaltyPage = lazyPage(() => import('@/pages/LoyaltyPage'), 'LoyaltyPage');
const DataExportPage = lazyPage(() => import('@/pages/DataExportPage'), 'DataExportPage');
const ProductImportPage = lazyPage(() => import('@/pages/ProductImportPage'), 'ProductImportPage');
const SuppliersPage = lazyPage(() => import('@/pages/SuppliersPage'), 'SuppliersPage');
const MarketingPage = lazyPage(() => import('@/pages/MarketingPage'), 'MarketingPage');
const StaffPage = lazyPage(() => import('@/pages/StaffPage'), 'StaffPage');
const RolesPage = lazyPage(() => import('@/pages/RolesPage'), 'RolesPage');
const WalletPage = lazyPage(() => import('@/pages/WalletPage'), 'WalletPage');
const SubscriptionPage = lazyPage(() => import('@/pages/SubscriptionPage'), 'SubscriptionPage');
const BillingOverviewPage = lazyPage(() => import('@/pages/BillingOverviewPage'), 'BillingOverviewPage');
const AccountDashboardPage = lazyPage(() => import('@/pages/AccountDashboardPage'), 'AccountDashboardPage');
const InvoicePage = lazyPage(() => import('@/pages/InvoicePage'), 'InvoicePage');
const AccountReceiptPage = lazyPage(() => import('@/pages/ReceiptPage'), 'AccountReceiptPage');
const WorkspaceReceiptPage = lazyPage(() => import('@/pages/ReceiptPage'), 'WorkspaceReceiptPage');
const BranchesPage = lazyPage(() => import('@/pages/BranchesPage'), 'BranchesPage');
const SettingsPage = lazyPage(() => import('@/pages/SettingsPage'), 'SettingsPage');

export function AppRoutes() {
  return (
    <Routes>
      {/* ------------------------------------------- public marketing site */}
      <Route element={<PublicLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/products" element={<PublicProductsPage />} />
        <Route path="/products/:slug" element={<PosProductPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        {/* Features live on the home page; keep the nav link meaningful. */}
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/contact" element={<ContactPage />} />
      </Route>

      {/* ---------------------------------------------------------- public */}
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnlyRoute>
            <RegisterPage />
          </PublicOnlyRoute>
        }
      />

      {/* Onboarding sits outside the app shell: there is no store yet, so the
          sidebar would have nothing to point at. */}
      <Route
        path="/onboarding"
        element={
          <ProtectedRoute>
            <OnboardingPage />
          </ProtectedRoute>
        }
      />

      {/* ------------------------------------------------- platform admin */}
      <Route
        path="/platform"
        element={
          <ProtectedRoute platformAdmin>
            <PlatformPage />
          </ProtectedRoute>
        }
      />
      {/* Managing ONE workspace. The tenant is explicit in the URL. */}
      <Route
        path="/platform/workspaces/:tenantId"
        element={
          <ProtectedRoute platformAdmin>
            <WorkspacePage />
          </ProtectedRoute>
        }
      />
      {/* Support view of ONE customer account. Read-only; every read is audited with a reason. */}
      <Route
        path="/platform/accounts/:accountId"
        element={
          <ProtectedRoute platformAdmin>
            <PlatformAccountPage />
          </ProtectedRoute>
        }
      />

      {/* ------------------------------------------------------ tenant app */}
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route
          path="/pos"
          element={
            <ProtectedRoute anyOf={['sales.create']}>
              <VerticalPos />
            </ProtectedRoute>
          }
        />
        {/* Restaurant POS screens. The layout keeps other verticals out. */}
        <Route
          path="/menu"
          element={
            <ProtectedRoute anyOf={['products.view']}>
              <MenuPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/tables"
          element={
            <ProtectedRoute anyOf={['sales.create', 'settings.edit']}>
              <TablesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/orders"
          element={
            <ProtectedRoute anyOf={['sales.view']}>
              <OrdersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/kitchen"
          element={
            <ProtectedRoute anyOf={['sales.view']}>
              <KitchenPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/shifts"
          element={
            <ProtectedRoute anyOf={['sales.create', 'reports.view']}>
              <ShiftsPage />
            </ProtectedRoute>
          }
        />
        {/* Pharmacy POS screens. The layout keeps other verticals out. */}
        <Route
          path="/medicines"
          element={
            <ProtectedRoute anyOf={['products.view']}>
              <MedicinesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/stock"
          element={
            <ProtectedRoute anyOf={['inventory.view']}>
              <StockPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pharmacy-sales"
          element={
            <ProtectedRoute anyOf={['sales.view']}>
              <PharmacySalesPage />
            </ProtectedRoute>
          }
        />
        {/* Supershop POS screens. The layout keeps other verticals out. */}
        <Route
          path="/shop-products"
          element={
            <ProtectedRoute anyOf={['products.view']}>
              <ShopProductsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/shop-inventory"
          element={
            <ProtectedRoute anyOf={['inventory.view']}>
              <ShopInventoryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/shop-categories"
          element={
            <ProtectedRoute anyOf={['products.view', 'categories.view']}>
              <ShopCategoriesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pharmacy-categories"
          element={
            <ProtectedRoute anyOf={['products.view', 'categories.view']}>
              <PharmacyCategoriesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/menu-categories"
          element={
            <ProtectedRoute anyOf={['products.view', 'categories.view']}>
              <MenuCategoriesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/shop-returns"
          element={
            <ProtectedRoute anyOf={['returns.view']}>
              <ShopReturnsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pharmacy-returns"
          element={
            <ProtectedRoute anyOf={['returns.view']}>
              <PharmacyReturnsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/refunds"
          element={
            <ProtectedRoute anyOf={['returns.view']}>
              <RestaurantRefundsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/shop-sales"
          element={
            <ProtectedRoute anyOf={['sales.view']}>
              <ShopSalesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sales"
          element={
            <ProtectedRoute anyOf={['sales.view']}>
              <SalesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/returns"
          element={
            <ProtectedRoute anyOf={['returns.view']}>
              <ReturnsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/returns/new/:saleId"
          element={
            <ProtectedRoute anyOf={['returns.create']}>
              <CreateReturnPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/catalogue"
          element={
            <ProtectedRoute anyOf={['products.view']}>
              <ProductsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/catalogue/import"
          element={
            <ProtectedRoute anyOf={['products.import']}>
              <ProductImportPage />
            </ProtectedRoute>
          }
        />
        {/* Shows its own locked state on plans without supplier management. */}
        <Route
          path="/suppliers"
          element={
            <ProtectedRoute anyOf={['suppliers.view']}>
              <SuppliersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/categories"
          element={
            <ProtectedRoute anyOf={['categories.view']}>
              <CategoriesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/inventory"
          element={
            <ProtectedRoute anyOf={['inventory.view']}>
              <InventoryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/customers"
          element={
            <ProtectedRoute anyOf={['customers.view']}>
              <CustomersPage />
            </ProtectedRoute>
          }
        />
        {/* Shows its own locked state on plans without the loyalty program. */}
        <Route
          path="/loyalty"
          element={
            <ProtectedRoute anyOf={['loyalty.view', 'loyalty.manage']}>
              <LoyaltyPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/marketing"
          element={
            <ProtectedRoute anyOf={['marketing.view']}>
              <MarketingPage />
            </ProtectedRoute>
          }
        />
        {/* Old path kept so existing links do not 404. */}
        <Route path="/messaging" element={<Navigate to="/marketing" replace />} />
        <Route
          path="/staff"
          element={
            <ProtectedRoute anyOf={['staff.view']}>
              <StaffPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/roles"
          element={
            <ProtectedRoute anyOf={['roles.view']}>
              <RolesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute anyOf={['reports.view']}>
              <VerticalDashboard />
            </ProtectedRoute>
          }
        />
        {/* Advanced Analytics is detailed analysis; the Dashboard is the quick
            overview. The page itself shows a locked state on plans without it. */}
        <Route
          path="/analytics"
          element={
            <ProtectedRoute anyOf={['reports.view']}>
              <VerticalAnalytics />
            </ProtectedRoute>
          }
        />
        <Route path="/reports" element={<Navigate to="/analytics" replace />} />
        {/* Shows its own locked state on plans without data export. */}
        <Route
          path="/data-export"
          element={
            <ProtectedRoute anyOf={['reports.export']}>
              <DataExportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/wallet"
          element={
            <ProtectedRoute anyOf={['wallet.view']}>
              <WalletPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/account"
          element={
            <ProtectedRoute accountOwner>
              <AccountDashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/billing"
          element={
            <ProtectedRoute accountOwner>
              <BillingOverviewPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/billing/invoices/:invoiceId"
          element={
            <ProtectedRoute accountOwner>
              <InvoicePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/billing/receipts/:receiptId"
          element={
            <ProtectedRoute accountOwner>
              <AccountReceiptPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/wallet/receipts/:topUpId"
          element={
            <ProtectedRoute anyOf={['wallet.view']}>
              <WorkspaceReceiptPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/subscription"
          element={
            <ProtectedRoute anyOf={['subscription.view']}>
              <SubscriptionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/branches"
          element={
            <ProtectedRoute anyOf={['settings.view']}>
              <BranchesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute anyOf={['settings.view']}>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
      </Route>

      {/* Unknown signed-in routes fall back to the POS. */}
      <Route path="*" element={<Navigate to="/pos" replace />} />
    </Routes>
  );
}
