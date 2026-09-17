import * as React from 'react';
import { Check, Lock, Minus } from 'lucide-react';
import { PLAN_SECTIONS, availableOn, formatLimit, type PlanRow } from '@/lib/planCatalog';
import type { SubscriptionPlan } from '@/types/domain';

/**
 * The full plan comparison, rendered from the shared catalogue.
 *
 * Used by the public pricing page AND the signed-in subscription page, so a
 * customer deciding whether to upgrade sees exactly what a prospect sees.
 * Neither can drift from what the backend enforces, because every value is read
 * from the plan objects the API returns.
 */
export function PlanComparisonTable({
  plans,
  currentPlanCode,
}: {
  plans: SubscriptionPlan[];
  /** Marks the column the workspace is already on. */
  currentPlanCode?: string | null;
}) {
  if (plans.length === 0) return null;

  return (
    /* A bounded scroll box, so the sticky header has something to stick to:
       `overflow-x` alone makes the wrapper the containing block and the header
       scrolls away with the page, 50 rows into a comparison. */
    <div className="max-h-[75vh] overflow-auto rounded-lg border">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead className="sticky top-0 z-20">
          <tr>
            {/* Opaque, not translucent: rows scroll underneath it. */}
            <th className="sticky left-0 z-30 w-2/5 bg-muted px-4 py-3 text-left font-semibold">Feature</th>
            {plans.map((plan) => (
              <th
                key={plan._id}
                className={`bg-muted px-3 py-3 text-center font-semibold ${
                  plan.code === currentPlanCode ? 'text-primary' : ''
                }`}
              >
                {plan.name.replace(/ Annual$/, '')}
                {plan.code === currentPlanCode && (
                  <span className="block text-[10px] font-normal uppercase tracking-wide">Your plan</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PLAN_SECTIONS.map((section) => (
            <React.Fragment key={section.heading}>
              <tr className="border-t">
                <th
                  colSpan={plans.length + 1}
                  className="sticky left-0 bg-muted/40 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {section.heading}
                  {section.blurb && (
                    <span className="ml-2 font-normal normal-case tracking-normal">{section.blurb}</span>
                  )}
                </th>
              </tr>
              {section.rows.map((row, rowIndex) => (
                <tr key={`${section.heading}-${rowIndex}`} className="border-t">
                  <td className="sticky left-0 z-10 bg-background px-4 py-2.5">
                    <span className="font-medium">{row.label}</span>
                    {row.hint && <span className="block text-xs text-muted-foreground">{row.hint}</span>}
                  </td>
                  {plans.map((plan) => (
                    <td key={plan._id} className="px-3 py-2.5 text-center">
                      <PlanCell row={row} plan={plan} plans={plans} />
                    </td>
                  ))}
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One cell: a number, a tick, a dash, or a usage-billed label. */
function PlanCell({ row, plan, plans }: { row: PlanRow; plan: SubscriptionPlan; plans: SubscriptionPlan[] }) {
  if (row.kind === 'limit') {
    return <span className="tabular font-medium">{formatLimit(plan.limits[row.key], row.format)}</span>;
  }

  if (row.kind === 'always') return <Included />;

  const enabled = Boolean(plan.features[row.key]);
  if (!enabled && row.kind === 'flag' && row.upsell) {
    return (
      <span className="inline-flex flex-col items-center gap-0.5 text-muted-foreground">
        <Lock className="h-4 w-4" aria-label="Not included" />
        <span className="text-[10px] leading-tight">Available on {availableOn(plans, row.key)}</span>
      </span>
    );
  }
  if (!enabled) return <NotIncluded />;

  // Marketing is included by the plan but billed per message, and saying so
  // here is the difference between a clear bill and a surprised customer.
  if (row.kind === 'usage') {
    return (
      <span className="inline-flex flex-col items-center gap-0.5">
        <Check className="h-4 w-4 text-success" aria-label="Included" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Usage based</span>
      </span>
    );
  }

  return <Included />;
}

const Included = () => (
  <>
    <Check className="mx-auto h-4 w-4 text-success" aria-hidden />
    <span className="sr-only">Included</span>
  </>
);

const NotIncluded = () => (
  <>
    <Minus className="mx-auto h-4 w-4 text-muted-foreground/50" aria-hidden />
    <span className="sr-only">Not included</span>
  </>
);
