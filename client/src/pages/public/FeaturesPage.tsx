import {
  BarChart3,
  Boxes,
  Building2,
  CreditCard,
  FileSpreadsheet,
  Fingerprint,
  Lock,
  Printer,
  Receipt,
  RefreshCw,
  ScanLine,
  Users,
  Wallet,
} from 'lucide-react';
import { Reveal, Stagger } from '@/features/public/motion';
import { Container, CtaButton, DarkSection, SectionHeading } from '@/features/public/primitives';
import { PosTerminal } from '@/features/public/PosTerminal';

/**
 * The platform, by capability.
 *
 * Grouped the way the work actually divides — the counter, the stock room, the
 * office — rather than as one long feature list. Everything named here exists
 * in the product today.
 */
const GROUPS: { title: string; copy: string; items: { icon: typeof ScanLine; label: string; copy: string }[] }[] = [
  {
    title: 'At the counter',
    copy: 'The screen a cashier lives on.',
    items: [
      { icon: ScanLine, label: 'Barcode checkout', copy: 'Scan to add; search when there is no label.' },
      { icon: CreditCard, label: 'Split payment', copy: 'Cash, bKash, Nagad, bank and card on one sale.' },
      { icon: Printer, label: 'Thermal receipts', copy: '48, 58, 78 and 80mm, printed direct or through the browser.' },
      { icon: RefreshCw, label: 'Returns and exchanges', copy: 'Against the original sale, with stock put back or written off.' },
    ],
  },
  {
    title: 'Behind the shop',
    copy: 'What you sell, and what is left.',
    items: [
      { icon: Boxes, label: 'Stock per branch', copy: 'Every movement in a ledger you can read back.' },
      { icon: FileSpreadsheet, label: 'Bulk import', copy: 'Bring a catalogue in from a spreadsheet, errors reported by row.' },
      { icon: Users, label: 'Customers and loyalty', copy: 'Purchase history, and points earned on a scanned card.' },
      { icon: Building2, label: 'Multiple branches', copy: 'Each with its own stock, staff and drawer.' },
    ],
  },
  {
    title: 'In the office',
    copy: 'What the business did.',
    items: [
      { icon: BarChart3, label: 'Analytics', copy: 'Sales, cost and margin by product, branch, staff and tender.' },
      { icon: Receipt, label: 'Reports you can print', copy: 'The page you are looking at, as a PDF.' },
      { icon: Wallet, label: 'One wallet', copy: 'Fund the account once; every workspace draws from it.' },
      { icon: Fingerprint, label: 'Roles and permissions', copy: 'Who may discount, refund or see cost — set per role.' },
    ],
  },
];

export function FeaturesPage() {
  return (
    <>
      <DarkSection grid className="py-20 sm:py-28">
        <Container>
          <div className="grid items-center gap-14 lg:grid-cols-[1fr_1fr]">
            <div>
              <SectionHeading
                tone="dark"
                align="left"
                eyebrow="The platform"
                title={<>One system behind every counter.</>}
                copy="The till changes with the trade. Accounts, branches, staff, stock, money and reporting do not."
              />
              <Reveal delay={200}>
                <div className="mt-9 flex flex-wrap gap-3">
                  <CtaButton to="/register">Start free</CtaButton>
                  <CtaButton to="/products" variant="ghost">
                    See the POS systems
                  </CtaButton>
                </div>
              </Reveal>
            </div>
            <Reveal delay={160} from="none" scale={0.96}>
              <PosTerminal vertical="supershop" />
            </Reveal>
          </div>
        </Container>
      </DarkSection>

      {GROUPS.map((group, index) => (
        <section
          key={group.title}
          className={index % 2 === 0 ? 'bg-white py-20 sm:py-24' : 'border-y border-slate-200 bg-slate-50 py-20 sm:py-24'}
        >
          <Container>
            <SectionHeading align="left" eyebrow={`0${index + 1}`} title={group.title} copy={group.copy} />
            <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" step={70}>
              {group.items.map((item) => (
                <div key={item.label} className="rs-lift group h-full rounded-2xl border border-slate-200 bg-white p-6 hover:border-indigo-200">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-white transition-colors duration-300 group-hover:bg-gradient-to-br group-hover:from-indigo-500 group-hover:to-cyan-400 group-hover:text-slate-950">
                    <item.icon className="h-[1.125rem] w-[1.125rem]" aria-hidden />
                  </span>
                  <h3 className="mt-5 text-[0.9375rem] font-semibold text-slate-950">{item.label}</h3>
                  <p className="mt-1.5 text-[0.8125rem] leading-6 text-slate-600">{item.copy}</p>
                </div>
              ))}
            </Stagger>
          </Container>
        </section>
      ))}

      <DarkSection className="py-20 sm:py-28">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <Reveal>
              <Lock className="mx-auto h-6 w-6 text-indigo-400" aria-hidden />
            </Reveal>
            <Reveal delay={80}>
              <h2 className="rs-h2 mt-6 text-[2rem] font-bold text-white sm:text-[2.5rem]">
                And the money is handled carefully.
              </h2>
            </Reveal>
            <Reveal delay={140}>
              <p className="mt-5 text-[1.0625rem] leading-8 text-slate-400">
                Prices are computed on the server, stock is guarded against double-selling, payments are idempotent, and
                invoices and ledger rows can never be edited after they are written.
              </p>
            </Reveal>
            <Reveal delay={210}>
              <div className="mt-9 flex flex-wrap justify-center gap-3">
                <CtaButton to="/register">Create a workspace</CtaButton>
                <CtaButton to="/pricing" variant="ghost">
                  See pricing
                </CtaButton>
              </div>
            </Reveal>
          </div>
        </Container>
      </DarkSection>
    </>
  );
}
