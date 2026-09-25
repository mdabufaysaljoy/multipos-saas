import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { LoyaltyCardSticker } from '@/features/loyalty/LoyaltyCardSticker';
import type { LabelSettings } from '@/types/domain';
import { BarcodeLabel } from './BarcodeLabel';

interface LabelSettingsCardProps {
  value: LabelSettings;
  storeName: string;
  currency: string;
  readOnly: boolean;
  /** The store's VAT switch, so the preview matches what is printed. */
  vatEnabled: boolean;
  /** Loyalty card size is only relevant where the loyalty program exists. */
  showLoyaltyCard: boolean;
  onChange: (labels: LabelSettings) => void;
}

const PRODUCT_WIDTHS = [38, 48, 58] as const;
const CARD_WIDTHS = [48, 58, 85] as const;

/**
 * Barcode label sizes for this branch. Saved with the rest of the settings
 * (needs settings.edit); every label print dialog reads them from the POS config.
 */
export function LabelSettingsCard({ value, storeName, currency, readOnly, vatEnabled, showLoyaltyCard, onChange }: LabelSettingsCardProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Barcode label printing</CardTitle>
          <CardDescription>Label width for your sticker paper or label printer.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Choice
            label="Product barcode labels"
            hint="Printed from Products → Print labels."
            options={PRODUCT_WIDTHS.map((width) => ({ value: width, label: `${width}mm` }))}
            selected={value.productWidthMm}
            disabled={readOnly}
            onSelect={(productWidthMm) => onChange({ ...value, productWidthMm })}
          />
          {showLoyaltyCard && (
            <Choice
              label="Loyalty membership cards"
              hint="85mm is bank-card size; 48mm and 58mm fit label rolls."
              options={CARD_WIDTHS.map((width) => ({ value: width, label: `${width}mm` }))}
              selected={value.loyaltyCardWidthMm}
              disabled={readOnly}
              onSelect={(loyaltyCardWidthMm) => onChange({ ...value, loyaltyCardWidthMm })}
            />
          )}
          <Choice
            label="Paper"
            hint={
              value.paper === 'roll'
                ? 'Label printer: each printed page is one label wide, one label per page.'
                : 'Normal page or A4 sticker sheet: labels are laid out side by side.'
            }
            options={[
              { value: 'sheet' as const, label: 'Sticker sheet' },
              { value: 'roll' as const, label: 'Label printer roll' },
            ]}
            selected={value.paper}
            disabled={readOnly}
            onSelect={(paper) => onChange({ ...value, paper })}
          />
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Preview</CardTitle>
          <CardDescription>Actual size on paper; the screen may scale it.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-start justify-center gap-4 overflow-x-auto rounded-md bg-muted/40 p-3">
          <BarcodeLabel
            data={{ barcode: '2001234567893', productName: 'Classic Cotton T-Shirt', variantName: 'Black / M', sku: 'URB-BLK-M', priceMinor: 79000 }}
            currency={currency}
            storeName={storeName}
            widthMm={value.productWidthMm}
            vatEnabled={vatEnabled}
          />
          {showLoyaltyCard && (
            <LoyaltyCardSticker
              card={{ cardNumber: 'LM-000123', barcode: '2990000001238', customerName: 'Rahim Uddin', phone: '01711000001', email: 'rahim@example.com' }}
              storeName={storeName}
              widthMm={value.loyaltyCardWidthMm}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Choice<T extends string | number>({
  label,
  hint,
  options,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  hint: string;
  options: { value: T; label: string }[];
  selected: T;
  disabled: boolean;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button key={String(option.value)} type="button" size="sm" disabled={disabled} variant={selected === option.value ? 'default' : 'outline'} onClick={() => onSelect(option.value)}>
            {option.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
