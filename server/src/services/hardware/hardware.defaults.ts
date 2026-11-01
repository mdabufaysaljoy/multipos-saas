import type { HardwareCategory } from '../../models/HardwareItem';

/**
 * The catalogue a fresh deployment starts with: the hardware Retailer Suites
 * sells today, taken from the published package artwork.
 *
 * Prices are in minor units (poisha) and every package price is the sum of its
 * parts, which is how the printed packages are quoted. These are SEED values
 * only - they are inserted when the catalogue is completely empty and are
 * never re-applied, so an admin who edits or removes one keeps their change.
 */

export interface DefaultItem {
  slug: string;
  name: string;
  category: HardwareCategory;
  summary: string;
  specs: string[];
  priceMinor: number;
  imageUrl: string;
  sortOrder: number;
}

export interface DefaultPackage {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  itemSlugs: string[];
  priceMinor: number;
  imageUrl: string;
  highlights: string[];
  bestFor: string[];
  featured: boolean;
  sortOrder: number;
}

const TAKA = 100;

/**
 * Product photography cut from the published package artwork and served as
 * static files by the website, so a fresh deployment has pictures without
 * anyone uploading anything. An admin replacing one just sets another address.
 */
const PHOTO = (name: string) => `/hardware-photos/${name}.webp`;

export const DEFAULT_HARDWARE_ITEMS: readonly DefaultItem[] = [
  {
    slug: 'desktop-pc-set',
    name: 'Desktop PC Set',
    category: 'computer',
    summary: 'Core i3 · 8GB RAM · 256GB SSD',
    specs: ['Intel Core i3 processor', '8GB RAM, 256GB SSD', 'LED monitor', 'Keyboard and mouse included'],
    priceMinor: 30_000 * TAKA,
    imageUrl: PHOTO('desktop-pc-set'),
    sortOrder: 10,
  },
  {
    slug: 'barcode-scanner',
    name: 'Barcode Scanner',
    category: 'scanner',
    summary: '1D/2D · USB plug and play',
    specs: ['Reads 1D and 2D barcodes', 'Fast, accurate scanning', 'USB plug and play', 'Handheld with stand'],
    priceMinor: 3_000 * TAKA,
    imageUrl: PHOTO('barcode-scanner'),
    sortOrder: 20,
  },
  {
    slug: 'cash-drawer',
    name: 'Cash Drawer',
    category: 'cash_drawer',
    summary: 'Heavy-duty metal body with secure lock',
    specs: ['Heavy-duty metal body', 'Multiple note and coin slots', 'Secure lock system', 'Opens from the receipt printer'],
    priceMinor: 6_500 * TAKA,
    imageUrl: PHOTO('cash-drawer'),
    sortOrder: 30,
  },
  {
    slug: 'label-printer',
    name: 'Barcode Label Printer',
    category: 'label_printer',
    summary: 'Direct thermal barcode and price labels',
    specs: ['Direct thermal printing', 'Barcode and price tag labels', 'USB connectivity', 'Budget model'],
    priceMinor: 6_500 * TAKA,
    imageUrl: PHOTO('label-printer'),
    sortOrder: 40,
  },
  {
    slug: 'receipt-printer-xp-q807k',
    name: 'Xprinter XP-Q807K',
    category: 'receipt_printer',
    summary: '80mm thermal receipt printer',
    specs: ['80mm thermal receipts', 'Fast and clear printing', 'USB connectivity', 'Auto cutter'],
    priceMinor: 5_500 * TAKA,
    imageUrl: PHOTO('receipt-printer-xp-q807k'),
    sortOrder: 50,
  },
  {
    slug: 'printer-2-in-1',
    name: '2-in-1 Printer',
    category: 'printer_combo',
    summary: 'Receipt and label printing in one unit',
    specs: ['80mm receipts and barcode labels', 'One printer at the counter', 'USB connectivity', 'Saves a second device'],
    priceMinor: 8_500 * TAKA,
    imageUrl: PHOTO('printer-2-in-1'),
    sortOrder: 60,
  },
];

const RETAIL_TRADES = ['Clothing shop', 'Super shop', 'Grocery store', 'Pharmacy', 'Electronics shop', 'Showroom'];

export const DEFAULT_HARDWARE_PACKAGES: readonly DefaultPackage[] = [
  {
    slug: 'complete-retail-counter',
    name: 'Complete Retail Counter',
    tagline: 'Everything a counter needs, nothing to add later',
    description:
      'The full counter: a desktop PC set to run the POS, a scanner for checkout, a locked cash drawer, a label printer for price tags and an 80mm receipt printer.',
    itemSlugs: ['desktop-pc-set', 'barcode-scanner', 'cash-drawer', 'label-printer', 'receipt-printer-xp-q807k'],
    priceMinor: 51_500 * TAKA,
    imageUrl: PHOTO('complete-retail-counter'),
    highlights: ['Smart billing', 'Fast checkout', 'Easy management'],
    bestFor: RETAIL_TRADES,
    featured: true,
    sortOrder: 10,
  },
  {
    slug: 'counter-with-2-in-1-printer',
    name: 'Complete Counter with 2-in-1 Printer',
    tagline: 'One printer for both receipts and labels',
    description:
      'The same complete setup, with a single 2-in-1 printer doing receipts and barcode labels instead of two separate machines.',
    itemSlugs: ['desktop-pc-set', 'barcode-scanner', 'cash-drawer', 'printer-2-in-1'],
    priceMinor: 48_000 * TAKA,
    imageUrl: PHOTO('counter-with-2-in-1-printer'),
    highlights: ['Fast billing', 'Barcode support', 'Easy management'],
    bestFor: RETAIL_TRADES,
    featured: true,
    sortOrder: 20,
  },
  {
    slug: 'classic-retail-counter',
    name: 'Classic Retail Counter',
    tagline: 'PC, scanner, drawer and receipt printer',
    description: 'A complete billing counter without label printing — for shops whose stock arrives already barcoded.',
    itemSlugs: ['desktop-pc-set', 'barcode-scanner', 'cash-drawer', 'receipt-printer-xp-q807k'],
    priceMinor: 45_000 * TAKA,
    imageUrl: PHOTO('classic-retail-counter'),
    highlights: ['Fast billing', 'Smart inventory', 'Business ready'],
    bestFor: RETAIL_TRADES,
    featured: false,
    sortOrder: 30,
  },
  {
    slug: 'compact-counter-2-in-1',
    name: 'Compact Counter with 2-in-1 Printer',
    tagline: 'PC, drawer and a 2-in-1 printer',
    description: 'A tidy counter for a shop that keys items in rather than scanning them, with receipts and labels from one printer.',
    itemSlugs: ['desktop-pc-set', 'cash-drawer', 'printer-2-in-1'],
    priceMinor: 45_000 * TAKA,
    imageUrl: PHOTO('compact-counter-2-in-1'),
    highlights: ['Fast billing', 'Better inventory', 'Easy management'],
    bestFor: RETAIL_TRADES,
    featured: false,
    sortOrder: 40,
  },
  {
    slug: 'smart-retail-setup',
    name: 'Smart Retail Setup',
    tagline: 'PC, scanner and a 2-in-1 printer',
    description: 'Scan, bill and print from three devices. Add a cash drawer later when the counter needs one.',
    itemSlugs: ['desktop-pc-set', 'barcode-scanner', 'printer-2-in-1'],
    priceMinor: 41_500 * TAKA,
    imageUrl: PHOTO('smart-retail-setup'),
    highlights: ['Fast billing', 'Barcode support', 'Easy management'],
    bestFor: RETAIL_TRADES,
    featured: false,
    sortOrder: 50,
  },
  {
    slug: 'counter-without-pc',
    name: 'Counter Essentials (without PC)',
    tagline: 'Every device except the computer',
    description: 'For a shop that already has a working computer: scanner, cash drawer, label printer and receipt printer.',
    itemSlugs: ['barcode-scanner', 'cash-drawer', 'label-printer', 'receipt-printer-xp-q807k'],
    priceMinor: 21_500 * TAKA,
    imageUrl: PHOTO('counter-without-pc'),
    highlights: ['Use your own PC', 'Barcode support', 'Professional printing'],
    bestFor: RETAIL_TRADES,
    featured: false,
    sortOrder: 60,
  },
  {
    slug: 'counter-basics',
    name: 'Counter Basics',
    tagline: 'Scanner, drawer and receipt printer',
    description: 'The three devices that turn a computer into a till.',
    itemSlugs: ['barcode-scanner', 'cash-drawer', 'receipt-printer-xp-q807k'],
    priceMinor: 15_000 * TAKA,
    imageUrl: PHOTO('counter-basics'),
    highlights: ['Use your own PC', 'Fast checkout', 'Secure cash handling'],
    bestFor: RETAIL_TRADES,
    featured: false,
    sortOrder: 70,
  },
  {
    slug: 'starter-duo',
    name: 'Starter Duo',
    tagline: 'Scanner and 2-in-1 printer',
    description: 'The smallest step into barcode billing: scan at checkout, print the receipt and the price labels.',
    itemSlugs: ['barcode-scanner', 'printer-2-in-1'],
    priceMinor: 11_500 * TAKA,
    imageUrl: PHOTO('starter-duo'),
    highlights: ['Faster billing', 'Barcode support', 'Easy integration'],
    bestFor: RETAIL_TRADES,
    featured: false,
    sortOrder: 80,
  },
];
