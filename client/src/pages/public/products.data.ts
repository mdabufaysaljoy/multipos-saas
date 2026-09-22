import type { LucideIcon } from 'lucide-react';
import { Pill, Shirt, ShoppingBasket, Utensils } from 'lucide-react';

export interface PosFeatureGroup {
  title: string;
  items: string[];
}

export interface SaasProduct {
  slug: string;
  /** The POS type code the backend uses (workspace vertical, pricing posType). */
  vertical: 'clothing' | 'restaurant' | 'pharmacy' | 'supershop';
  name: string;
  tagline: string;
  description: string;
  icon: LucideIcon;
  highlights: string[];
  /** What this POS does that the others do not. */
  features: PosFeatureGroup[];
}

/**
 * The four POS systems the platform offers. Every one can be registered and
 * opened today. Plans, prices and limits are NOT listed here - product pages
 * read them live from the API for that POS type, so the site cannot promise
 * something the backend does not enforce.
 */
export const SAAS_PRODUCTS: SaasProduct[] = [
  {
    slug: 'clothing-pos',
    vertical: 'clothing',
    name: 'Clothing POS',
    tagline: 'Built for garment and fashion retail',
    description: 'Colour and size variants, barcode scanning, split payments, exchanges and thermal receipts — everything a clothing shop needs at the till.',
    icon: Shirt,
    highlights: ['Colour × size variants with per-variant stock', 'Barcode scanning and label printing', 'Returns and exchanges against the original sale', 'Profit from cost captured at sale time'],
    features: [
      { title: 'Catalogue and stock', items: ['Products with colour, size and other variant options', 'Stock tracked per variant and per branch', 'Categories and low-stock alerts', 'Inventory ledger of every stock movement'] },
      { title: 'Selling', items: ['Fast barcode checkout', 'Split payments across cash, bKash, Nagad, bank and card', 'Discounts with permission-controlled price changes', '58mm and 80mm thermal receipts'] },
      { title: 'After the sale', items: ['Returns and exchanges linked to the original sale', 'Restocking or writing off returned items', 'Customer purchase history'] },
    ],
  },
  {
    slug: 'super-shop-pos',
    vertical: 'supershop',
    name: 'Supershop POS',
    tagline: 'Grocery and general retail',
    description: 'Barcode checkout, goods sold by the piece or by weight, and VAT on every receipt for supermarkets and general stores.',
    icon: ShoppingBasket,
    highlights: ['Barcode scanning at checkout', 'Sell by piece or by weight', 'VAT-inclusive pricing', 'Dead-stock and write-off reporting'],
    features: [
      { title: 'Products and stock', items: ['Products sold by piece or by weight', 'Barcodes and categories', 'Reorder levels and stock valuation at average cost', 'Write-offs recorded with their cost'] },
      { title: 'Checkout', items: ['Barcode scanning', 'VAT rates per product on every receipt', 'Voided baskets reported, never counted as sales'] },
      { title: 'Reports', items: ['Dead stock by stock value', 'Write-off and void reporting', 'Daily sales and payment summaries'] },
    ],
  },
  {
    slug: 'restaurant-pos',
    vertical: 'restaurant',
    name: 'Restaurant POS',
    tagline: 'Tables, kitchen and shifts',
    description: 'Dine-in, takeaway and delivery with table management, kitchen tickets and shift close.',
    icon: Utensils,
    highlights: ['Menu with categories', 'Table management', 'Kitchen tickets', 'Shift open and close reports'],
    features: [
      { title: 'Front of house', items: ['Dine-in, takeaway and delivery orders', 'Table plan and table status', 'Orders tracked from placed to served'] },
      { title: 'Kitchen', items: ['Kitchen view of open tickets', 'Menu items with prices and availability'] },
      { title: 'Cash control', items: ['Shift open and close', 'Shift close reports by payment method'] },
    ],
  },
  {
    slug: 'pharmacy-pos',
    vertical: 'pharmacy',
    name: 'Pharmacy POS',
    tagline: 'Batches, expiry and prescriptions',
    description: 'Medicine retail with batch and expiry tracking, first-expiry-first-out selling and prescription records.',
    icon: Pill,
    highlights: ['Batch and expiry tracking', 'Earliest expiry sold first', 'Expired stock is never sold', 'Prescription-required medicines'],
    features: [
      { title: 'Medicines', items: ['Generic name, strength, dosage form and manufacturer', 'Prescription-required flag per medicine', 'Reorder levels'] },
      { title: 'Batches and expiry', items: ['Stock received in batches with expiry dates', 'Earliest-expiring stock sold first', 'Expired batches blocked from sale', 'Expiry report of batches expiring soon'] },
      { title: 'Reports', items: ['Stock exposure bucketed by days to expiry', 'Sales and low-stock dashboard'] },
    ],
  },
];

/** Every POS includes these, on every plan (subject to the plan's limits). */
export const SHARED_FEATURES: PosFeatureGroup[] = [
  { title: 'Business', items: ['Sales dashboard on every plan', 'Multiple branches (by plan)', 'Customers and purchase history'] },
  { title: 'Team', items: ['Staff accounts', 'Role-based permissions', 'Custom roles (by plan)'] },
  { title: 'Billing', items: ['One account wallet for all your POS workspaces', 'Monthly or annual plans', 'Invoices and payment history'] },
];

export const productBySlug = (slug: string | undefined) => SAAS_PRODUCTS.find((product) => product.slug === slug) ?? null;
