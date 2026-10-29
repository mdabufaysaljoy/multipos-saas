import { colors } from "./theme";

/**
 * Every claim in this video is taken from the application itself, so that the
 * promo cannot drift from what the product sells:
 *
 *  - plan names, prices and limits: `server/src/seed/plans.seed.ts`
 *  - product ceilings:              `server/src/config/productLimits.ts`
 *  - trial length:                  `server/src/services/subscription/trialPolicy.ts`
 *  - feature-by-tier split:         `docs/ENTITLEMENTS.md`
 *  - how a sale is paid for:        `docs/POS_TENDER_RULES.md`
 *  - what a return refunds:         `docs/RETURNS.md`
 *  - stock movements:               `docs/INVENTORY_ADAPTER.md`, `docs/PRODUCT_IMPORT.md`
 *  - printing:                      `docs/PRINTING_ARCHITECTURE.md`, `docs/NANOPRINT_SETUP.md`
 *  - the loyalty rule:              `docs/LOYALTY_UNIVERSAL.md`
 *  - report vocabulary:             `docs/ANALYTICS_PARITY.md`, `docs/REPORT_PRINTING.md`
 *  - universal POS capabilities:    `docs/UNIVERSAL_POS_PLAN.md`, `CLAUDE.md`
 *
 * The `detail` line on each card is the part that makes the film specific
 * rather than a list of nouns: it is the rule the server actually enforces, in
 * the viewer's language. If a doc changes, the line changes with it.
 *
 * Prices are written here in taka, not minor units, because this is display
 * copy — the seed file keeps poisha (99_000 = BDT 990).
 */

export const verticals = [
  {
    en: "Clothing POS",
    bn: "ফ্যাশন ও গার্মেন্টস",
    detail: "সাইজ, রঙ ও ভ্যারিয়েন্ট",
    accent: colors.indigo,
  },
  {
    en: "Super Shop POS",
    bn: "সুপারশপ ও গ্রোসারি",
    detail: "VAT, মার্জিন ও ডেড স্টক",
    accent: colors.cyan,
  },
  {
    en: "Restaurant POS",
    bn: "রেস্টুরেন্ট ও ক্যাফে",
    detail: "টেবিল, অর্ডার ও কিচেন টিকেট",
    accent: colors.amber,
  },
  {
    en: "Pharmacy POS",
    bn: "ফার্মেসি ও মেডিসিন",
    detail: "ব্যাচ, এক্সপায়ারি ও প্রেসক্রিপশন",
    accent: colors.emerald,
  },
];

export const coreFeatures = [
  {
    bn: "দ্রুত বিক্রি ও বারকোড স্ক্যান",
    en: "Fast billing",
    detail: "EAN-13 ও CODE128 স্ক্যান",
    icon: "cart",
    accent: colors.indigo,
  },
  {
    bn: "সরাসরি রিসিট প্রিন্ট",
    en: "Direct thermal print",
    detail: "QZ Tray বা NanoPrint — প্রতি কম্পিউটারে",
    icon: "printer",
    accent: colors.cyan,
  },
  {
    bn: "স্প্লিট ও কাস্টম পেমেন্ট",
    en: "Split payment",
    detail: "ব্রাঞ্চের অনুমোদিত মেথড · চেঞ্জ শুধু ক্যাশে",
    icon: "card",
    accent: colors.violet,
  },
  {
    bn: "ইনভেন্টরি লেজার ও স্টক",
    en: "Inventory ledger",
    detail: "প্রতিটি মুভমেন্ট লেজারে, স্টক ফিল্ডে নয়",
    icon: "boxes",
    accent: colors.emerald,
  },
  {
    bn: "রিটার্ন, এক্সচেঞ্জ, রিফান্ড",
    en: "Return & exchange",
    detail: "ডিসকাউন্টের অনুপাতে রিফান্ড",
    icon: "returnArrow",
    accent: colors.amber,
  },
  {
    bn: "এক্সেল থেকে বাল্ক ইমপোর্ট",
    en: "Bulk import",
    detail: "Excel ও CSV — সব প্ল্যানে",
    icon: "upload",
    accent: colors.indigo,
  },
];

export const growthFeatures = [
  {
    bn: "মাল্টি-ব্রাঞ্চ ম্যানেজমেন্ট",
    en: "Multi-branch",
    detail: "সব ব্রাঞ্চ এক ড্যাশবোর্ডে, এক রেঞ্জে",
    icon: "branch",
    accent: colors.cyan,
  },
  {
    bn: "স্টাফ রোল ও পারমিশন",
    en: "Custom roles",
    detail: "প্রতি রিকোয়েস্টে সার্ভারেই যাচাই",
    icon: "shield",
    accent: colors.violet,
  },
  {
    bn: "লয়ালটি কার্ড প্রোগ্রাম",
    en: "Loyalty program",
    detail: "স্ক্যান করা কার্ডেই পয়েন্ট, ফোনে নয়",
    icon: "star",
    accent: colors.amber,
  },
  {
    bn: "SMS ও ইমেইল মার্কেটিং",
    en: "Marketing",
    detail: "কাস্টমারকে ক্যাম্পেইনে ফিরিয়ে আনুন",
    icon: "megaphone",
    accent: colors.indigo,
  },
  {
    bn: "অ্যাডভান্সড অ্যানালিটিক্স",
    en: "Advanced analytics",
    detail: "নেট সেল, কস্ট, গ্রস প্রফিট ও মার্জিন",
    icon: "chart",
    accent: colors.emerald,
  },
  {
    bn: "রিপোর্ট প্রিন্ট ও ডেটা এক্সপোর্ট",
    en: "Export & print",
    detail: "PDF প্রিন্ট · CSV, Excel, JSON এক্সপোর্ট",
    icon: "download",
    accent: colors.cyan,
  },
];

export const plans = [
  {
    name: "Starter",
    bn: "একটি দোকানের জন্য",
    price: "৳990",
    perMonth: "/ মাস",
    annual: "বার্ষিক ৳9,900",
    accent: colors.cyan,
    featured: false,
    ribbon: "৭ দিন ফ্রি ট্রায়াল",
    rows: [
      "১টি ব্রাঞ্চ, ২ জন স্টাফ",
      "৩,০০০ প্রোডাক্ট",
      "৫০০ কাস্টমার",
      "মাসে ২,৫০০ সেল",
      "সেলস রিপোর্ট ও ইনভেন্টরি লেজার",
    ],
  },
  {
    name: "Professional",
    bn: "বেড়ে ওঠা ব্যবসার জন্য",
    price: "৳1,990",
    perMonth: "/ মাস",
    annual: "বার্ষিক ৳19,900",
    accent: colors.violet,
    featured: true,
    ribbon: "সবচেয়ে জনপ্রিয়",
    rows: [
      "২টি ব্রাঞ্চ, ৬ জন স্টাফ",
      "৩০,০০০ প্রোডাক্ট",
      "১০,০০০ কাস্টমার",
      "লয়ালটি + মার্কেটিং",
      "অ্যাডভান্সড অ্যানালিটিক্স ও এক্সপোর্ট",
    ],
  },
  {
    name: "Enterprise",
    bn: "মাল্টি-ব্রাঞ্চ রিটেইলারের জন্য",
    price: "৳2,990",
    perMonth: "/ মাস",
    annual: "বার্ষিক ৳29,900",
    accent: colors.amber,
    featured: false,
    ribbon: "আনলিমিটেড",
    rows: [
      "১০টি ব্রাঞ্চ, আনলিমিটেড স্টাফ",
      "আনলিমিটেড প্রোডাক্ট",
      "আনলিমিটেড কাস্টমার ও সেল",
      "সব ফিচার একসাথে",
      "প্রায়োরিটি সাপোর্ট",
    ],
  },
];

export const trial = {
  days: "৭",
  bn: "দিনের ফ্রি ট্রায়াল",
  note: "Starter মাসিক প্ল্যানে",
  annualNote: "বার্ষিক প্ল্যানে ২ মাস ফ্রি",
  domain: "retailersuites.com",
};
