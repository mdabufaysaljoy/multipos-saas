import { colors } from "./theme";

/**
 * Every claim in this video is taken from the application itself, so that the
 * promo cannot drift from what the product sells:
 *
 *  - plan names, prices and limits: `server/src/seed/plans.seed.ts`
 *  - product ceilings:              `server/src/config/productLimits.ts`
 *  - trial length:                  `server/src/services/subscription/trialPolicy.ts`
 *  - feature-by-tier split:         `docs/ENTITLEMENTS.md`
 *  - universal POS capabilities:    `docs/UNIVERSAL_POS_PLAN.md`, `CLAUDE.md`
 *
 * Prices are written here in taka, not minor units, because this is display
 * copy — the seed file keeps poisha (99_000 = BDT 990).
 */

export const verticals = [
  { en: "Clothing POS", bn: "ফ্যাশন ও গার্মেন্টস", accent: colors.indigo },
  { en: "Super Shop POS", bn: "সুপারশপ ও গ্রোসারি", accent: colors.cyan },
  { en: "Restaurant POS", bn: "রেস্টুরেন্ট ও ক্যাফে", accent: colors.amber },
  { en: "Pharmacy POS", bn: "ফার্মেসি ও মেডিসিন", accent: colors.emerald },
];

export const coreFeatures = [
  { bn: "দ্রুত বিক্রি ও বারকোড স্ক্যান", en: "Fast billing", icon: "cart", accent: colors.indigo },
  { bn: "সরাসরি রিসিট প্রিন্ট", en: "QZ Tray / NanoPrint", icon: "printer", accent: colors.cyan },
  { bn: "স্প্লিট ও কাস্টম পেমেন্ট", en: "Split payment", icon: "card", accent: colors.violet },
  { bn: "ইনভেন্টরি লেজার ও স্টক", en: "Inventory ledger", icon: "boxes", accent: colors.emerald },
  { bn: "রিটার্ন, এক্সচেঞ্জ, রিফান্ড", en: "Return & exchange", icon: "returnArrow", accent: colors.amber },
  { bn: "এক্সেল থেকে বাল্ক ইমপোর্ট", en: "Bulk import", icon: "upload", accent: colors.indigo },
];

export const growthFeatures = [
  { bn: "মাল্টি-ব্রাঞ্চ ম্যানেজমেন্ট", en: "Multi-branch", icon: "branch", accent: colors.cyan },
  { bn: "স্টাফ রোল ও পারমিশন", en: "Custom roles", icon: "shield", accent: colors.violet },
  { bn: "লয়ালটি কার্ড প্রোগ্রাম", en: "Loyalty program", icon: "star", accent: colors.amber },
  { bn: "SMS ও ইমেইল মার্কেটিং", en: "Marketing", icon: "megaphone", accent: colors.indigo },
  { bn: "অ্যাডভান্সড অ্যানালিটিক্স", en: "Advanced analytics", icon: "chart", accent: colors.emerald },
  { bn: "রিপোর্ট প্রিন্ট ও ডেটা এক্সপোর্ট", en: "Export & print", icon: "download", accent: colors.cyan },
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
