import type { LucideIcon } from 'lucide-react';
import { Croissant, Pill, Shirt, ShoppingBasket, Utensils, Wrench } from 'lucide-react';

export interface SaasProduct {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  icon: LucideIcon;
  /** Only a launched product links into the app; the rest are marketing. */
  status: 'live' | 'coming-soon';
  highlights: string[];
}

/**
 * The product showcase.
 *
 * Only Clothing POS is wired to a real application. The others are honestly
 * marked "coming soon" rather than being given dead links that imply they are
 * ready to buy.
 */
export const SAAS_PRODUCTS: SaasProduct[] = [
  {
    slug: 'clothing-pos',
    name: 'Clothing POS',
    tagline: 'Built for garment retail',
    description:
      'Colour and size variants, barcode scanning, split payments and thermal receipts — everything a clothing shop needs at the till.',
    icon: Shirt,
    status: 'live',
    highlights: [
      'Colour × size variant matrix with per-variant stock',
      'Barcode scan and label printing',
      'Split payments across cash, bKash, Nagad, bank and card',
      '58/78/80mm thermal receipts',
      'Profit reporting from cost captured at sale time',
    ],
  },
  {
    slug: 'super-shop-pos',
    name: 'Super Shop POS',
    tagline: 'Grocery and convenience',
    description: 'Weighed goods, batch expiry tracking and fast multi-lane checkout for supermarkets.',
    icon: ShoppingBasket,
    status: 'coming-soon',
    highlights: ['Weight-based pricing', 'Batch and expiry tracking', 'Multi-lane checkout'],
  },
  {
    slug: 'pharmacy-pos',
    name: 'Pharmacy POS',
    tagline: 'Regulated dispensing',
    description: 'Generic and brand mapping, batch expiry alerts and prescription records.',
    icon: Pill,
    status: 'coming-soon',
    highlights: ['Generic ↔ brand mapping', 'Expiry alerts', 'Prescription history'],
  },
  {
    slug: 'restaurant-pos',
    name: 'Restaurant POS',
    tagline: 'Table and kitchen flow',
    description: 'Table management, kitchen display tickets and course-by-course ordering.',
    icon: Utensils,
    status: 'coming-soon',
    highlights: ['Table plans', 'Kitchen display', 'Split bills'],
  },
  {
    slug: 'bakery-pos',
    name: 'Bakery POS',
    tagline: 'Fresh production planning',
    description: 'Daily production runs, wastage tracking and pre-orders for bakeries.',
    icon: Croissant,
    status: 'coming-soon',
    highlights: ['Production planning', 'Wastage tracking', 'Pre-orders'],
  },
  {
    slug: 'service-pos',
    name: 'Service & Repair POS',
    tagline: 'Jobs and workshops',
    description: 'Job cards, parts consumption and service warranties for workshops.',
    icon: Wrench,
    status: 'coming-soon',
    highlights: ['Job cards', 'Parts consumption', 'Warranty tracking'],
  },
];
