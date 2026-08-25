import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/layouts/AppLayout';
import { ProtectedRoute, PublicOnlyRoute } from '@/routes/ProtectedRoute';
import { CategoriesPage } from '@/pages/CategoriesPage';
import { CreateReturnPage } from '@/pages/CreateReturnPage';
import { CustomersPage } from '@/pages/CustomersPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { InventoryPage } from '@/pages/InventoryPage';
import { LoginPage } from '@/pages/LoginPage';
import { OnboardingPage } from '@/pages/OnboardingPage';
import { PlatformPage } from '@/pages/PlatformPage';
import { PosPage } from '@/pages/PosPage';
import { ProductsPage } from '@/pages/ProductsPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { ReturnsPage } from '@/pages/ReturnsPage';
import { RolesPage } from '@/pages/RolesPage';
import { SalesPage } from '@/pages/SalesPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { StaffPage } from '@/pages/StaffPage';
import { SubscriptionPage } from '@/pages/SubscriptionPage';

export function AppRoutes() {
  return (
    <Routes>
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
              <PosPage />
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
          path="/products"
          element={
            <ProtectedRoute anyOf={['products.view']}>
              <ProductsPage />
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
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        {/* Reports and the dashboard share one screen for now. */}
        <Route
          path="/reports"
          element={
            <ProtectedRoute anyOf={['reports.view']}>
              <DashboardPage />
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
          path="/settings"
          element={
            <ProtectedRoute anyOf={['settings.view']}>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
      </Route>

      {/* A cashier has no dashboard, so land everyone on the POS. */}
      <Route path="/" element={<Navigate to="/pos" replace />} />
      <Route path="*" element={<Navigate to="/pos" replace />} />
    </Routes>
  );
}
