import type { DosageForm } from '@/types/pharmacy';

export const DOSAGE_FORM_LABELS: Record<DosageForm, string> = {
  tablet: 'Tablet',
  capsule: 'Capsule',
  syrup: 'Syrup',
  suspension: 'Suspension',
  injection: 'Injection',
  cream: 'Cream',
  ointment: 'Ointment',
  drops: 'Drops',
  inhaler: 'Inhaler',
  powder: 'Powder',
  other: 'Other',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Expiry dates are calendar dates; read them as such in every timezone. */
export function formatExpiry(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

const localToday = () => {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
};

/** Whole days until expiry: 0 = expires today, negative = expired. */
export function daysUntilExpiry(iso: string): number {
  return Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - localToday()) / 86_400_000);
}

export function expiryTone(iso: string): { label: string; variant: 'destructive' | 'warning' | 'secondary' } {
  const days = daysUntilExpiry(iso);
  if (days < 0) return { label: 'Expired', variant: 'destructive' };
  if (days === 0) return { label: 'Expires today', variant: 'warning' };
  if (days <= 90) return { label: `${days} day${days === 1 ? '' : 's'} left`, variant: 'warning' };
  return { label: formatExpiry(iso), variant: 'secondary' };
}

/** "Napa 500 mg tablet" */
export const medicineLabel = (medicine: { name: string; strength?: string; dosageForm?: string }) =>
  [medicine.name, medicine.strength, medicine.dosageForm ? DOSAGE_FORM_LABELS[medicine.dosageForm as DosageForm]?.toLowerCase() : '']
    .filter(Boolean)
    .join(' ');

/** Today's date as YYYY-MM-DD in the browser's timezone (for date inputs). */
export function todayInputValue(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
