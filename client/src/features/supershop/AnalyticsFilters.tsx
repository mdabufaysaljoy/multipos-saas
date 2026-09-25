import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FilterX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDebounced } from '@/components/SearchInput';
import { staffApi, storeApi } from '@/api/endpoints';
import { shopCategoriesApi } from '@/api/posCategories';
import { shopBrandsApi } from '@/api/shopBrands';
import { supershopApi } from '@/api/supershop';
import { tendersFromConfig } from '@/types/domain';

/** Every filter off. */
export const NO_FILTERS: AnalyticsFilterValue = {
  branch: 'current',
  staffId: '',
  category: '',
  brand: '',
  productId: '',
  paymentMethod: '',
  customerId: '',
};

export interface AnalyticsFilterValue {
  /** 'current', 'all', or a branch id. */
  branch: string;
  staffId: string;
  category: string;
  brand: string;
  productId: string;
  paymentMethod: string;
  customerId: string;
}

/** Only what is set, in the shape the report endpoint takes. */
export function analyticsParams(value: AnalyticsFilterValue): Record<string, string> {
  const params: Record<string, string> = { branch: value.branch };
  if (value.staffId) params.staffId = value.staffId;
  if (value.category) params.category = value.category;
  if (value.brand) params.brand = value.brand;
  if (value.productId) params.productId = value.productId;
  if (value.paymentMethod) params.paymentMethod = value.paymentMethod;
  if (value.customerId) params.customerId = value.customerId;
  return params;
}

export const hasAnyFilter = (value: AnalyticsFilterValue) =>
  value.branch !== 'current' || Boolean(value.staffId || value.category || value.brand || value.productId || value.paymentMethod || value.customerId);

const ANY = '__any__';
const asValue = (raw: string) => (raw === ANY ? '' : raw);

/**
 * The filter bar above Advanced Analytics.
 *
 * Branch, staff, payment method and customer choose which SALES are counted.
 * Department, brand and product choose which LINES are of interest - the server
 * says plainly which it applied, and reports those lines on their own.
 *
 * The branch list comes from the REPORT, not from this screen: the server
 * decides which branches this user may look at, so a picker cannot offer one
 * they are not allowed.
 */
export function AnalyticsFilters({
  value,
  onChange,
  branches,
  customers,
}: {
  value: AnalyticsFilterValue;
  onChange: (next: AnalyticsFilterValue) => void;
  /** Branches the server says this user may choose between. */
  branches: { _id: string; name: string }[];
  /** Customers who actually bought in this period. */
  customers: { customerId: string; name: string }[];
}) {
  const set = (patch: Partial<AnalyticsFilterValue>) => onChange({ ...value, ...patch });

  const { data: staff } = useQuery({ queryKey: ['staff', 'analytics'], queryFn: () => staffApi.list({ limit: 100 }), staleTime: 60_000 });
  const { data: departments } = useQuery({ queryKey: ['supershop', 'categories', 'analytics'], queryFn: () => shopCategoriesApi.list(), staleTime: 60_000 });
  const { data: brands } = useQuery({ queryKey: ['supershop', 'brands', 'analytics'], queryFn: () => shopBrandsApi.list(), staleTime: 60_000 });
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig, staleTime: 60_000 });

  // The product picker searches the whole catalogue rather than only what sold.
  const [productTerm, setProductTerm] = React.useState('');
  const productSearch = useDebounced(productTerm);
  const { data: products } = useQuery({
    queryKey: ['supershop', 'products', 'analytics', productSearch],
    queryFn: () => supershopApi.products({ limit: 20, ...(productSearch ? { search: productSearch } : {}) }),
    staleTime: 30_000,
  });
  const chosenProduct = (products?.items ?? []).find((row) => row._id === value.productId);

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {branches.length > 1 && (
          <div className="space-y-1">
            <Label className="text-xs">Branch</Label>
            <Select value={value.branch} onValueChange={(next) => set({ branch: next })}>
              <SelectTrigger className="h-8" aria-label="Filter by branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">This branch</SelectItem>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((row) => (
                  <SelectItem key={row._id} value={row._id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-xs">Staff</Label>
          <Select value={value.staffId || ANY} onValueChange={(next) => set({ staffId: asValue(next) })}>
            <SelectTrigger className="h-8" aria-label="Filter by staff">
              <SelectValue placeholder="Anyone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Anyone</SelectItem>
              {(staff?.items ?? []).map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Department</Label>
          <Select value={value.category || ANY} onValueChange={(next) => set({ category: asValue(next) })}>
            <SelectTrigger className="h-8" aria-label="Filter by department">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All departments</SelectItem>
              {(departments ?? []).map((row) => (
                <SelectItem key={row.slug} value={row.name}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Brand</Label>
          <Select value={value.brand || ANY} onValueChange={(next) => set({ brand: asValue(next) })}>
            <SelectTrigger className="h-8" aria-label="Filter by brand">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All brands</SelectItem>
              {(brands ?? []).map((row) => (
                <SelectItem key={row.slug} value={row.name}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Payment</Label>
          <Select value={value.paymentMethod || ANY} onValueChange={(next) => set({ paymentMethod: asValue(next) })}>
            <SelectTrigger className="h-8" aria-label="Filter by payment method">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any method</SelectItem>
              {tendersFromConfig(posConfig).map((tender) => (
                <SelectItem key={tender.key} value={tender.key}>
                  {tender.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Customer</Label>
          <Select value={value.customerId || ANY} onValueChange={(next) => set({ customerId: asValue(next) })}>
            <SelectTrigger className="h-8" aria-label="Filter by customer">
              <SelectValue placeholder="Anyone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any customer</SelectItem>
              {customers.map((row) => (
                <SelectItem key={row.customerId} value={row.customerId}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs" htmlFor="an-product">
            Product
          </Label>
          <Input
            id="an-product"
            className="h-8"
            list="an-product-options"
            value={chosenProduct ? chosenProduct.name : productTerm}
            placeholder="Any product"
            onChange={(event) => {
              const next = event.target.value;
              setProductTerm(next);
              const picked = (products?.items ?? []).find((row) => row.name === next);
              set({ productId: picked ? picked._id : '' });
            }}
          />
          <datalist id="an-product-options">
            {(products?.items ?? []).map((row) => (
              <option key={row._id} value={row.name} />
            ))}
          </datalist>
        </div>
      </div>

      {hasAnyFilter(value) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setProductTerm('');
            onChange(NO_FILTERS);
          }}
        >
          <FilterX />
          Clear filters
        </Button>
      )}
    </div>
  );
}
