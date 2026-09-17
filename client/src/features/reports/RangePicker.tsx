import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface RangeValue {
  preset: string;
  from: string;
  to: string;
}

interface RangePickerProps {
  value: RangeValue;
  onChange: (value: RangeValue) => void;
  /** Dashboard keeps to quick presets; Reports offers the full set. */
  presets?: { value: string; label: string }[];
}

export const DASHBOARD_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'last7', label: '7 days' },
  { value: 'last30', label: '30 days' },
];

export const REPORT_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'thisYear', label: 'This year' },
];

/** Shared range control so both screens interpret dates identically. */
export function RangePicker({ value, onChange, presets = REPORT_PRESETS }: RangePickerProps) {
  const isCustom = value.preset === 'custom';

  return (
    <div className="flex flex-wrap items-end gap-2">
      {presets.map((preset) => (
        <Button
          key={preset.value}
          variant={value.preset === preset.value ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange({ ...value, preset: preset.value })}
        >
          {preset.label}
        </Button>
      ))}

      <Button
        variant={isCustom ? 'default' : 'outline'}
        size="sm"
        onClick={() => onChange({ ...value, preset: 'custom' })}
      >
        Custom
      </Button>

      {isCustom && (
        <>
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={value.from}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={value.to}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
              className="w-40"
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Turns the picker value into query params the reports API understands. */
export function rangeParams(value: RangeValue): Record<string, string> {
  if (value.preset !== 'custom') return { preset: value.preset };
  if (!value.from || !value.to) return { preset: 'last7' };
  return {
    preset: 'custom',
    from: new Date(value.from).toISOString(),
    to: new Date(`${value.to}T23:59:59`).toISOString(),
  };
}

export const isRangeReady = (value: RangeValue) =>
  value.preset !== 'custom' || Boolean(value.from && value.to);
