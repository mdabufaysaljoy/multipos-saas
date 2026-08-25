/**
 * Sample clothing catalogue. Prices are in minor units (poisha).
 * Every product declares its option axes and the exact variants to create, so
 * the seed exercises the same code path the product form uses.
 */
export interface SeedProduct {
  name: string;
  category: string;
  brand: string;
  description: string;
  basePriceMinor: number;
  costPriceMinor: number;
  colors: string[];
  sizes: string[];
  stockPerVariant: number;
}

export const SEED_CATEGORIES = [
  { name: 'T-Shirts', description: 'Everyday cotton tees' },
  { name: 'Shirts', description: 'Formal and casual shirts' },
  { name: 'Panjabi', description: 'Traditional panjabi and kurta' },
  { name: 'Jeans & Trousers', description: 'Denim and chinos' },
  { name: 'Sarees', description: 'Cotton, silk and jamdani sarees' },
  { name: 'Kids', description: 'Clothing for children' },
  { name: 'Accessories', description: 'Belts, caps, scarves and more' },
];

export const SEED_PRODUCTS: SeedProduct[] = [
  {
    name: 'Classic Cotton T-Shirt',
    category: 'T-Shirts',
    brand: 'Urban Thread',
    description: '180 GSM combed cotton crew-neck tee. Pre-shrunk and colourfast.',
    basePriceMinor: 79_000,
    costPriceMinor: 42_000,
    colors: ['Black', 'White', 'Navy'],
    sizes: ['S', 'M', 'L', 'XL'],
    stockPerVariant: 18,
  },
  {
    name: 'Oversized Graphic Tee',
    category: 'T-Shirts',
    brand: 'Urban Thread',
    description: 'Drop-shoulder oversized fit with a screen-printed back panel.',
    basePriceMinor: 99_000,
    costPriceMinor: 55_000,
    colors: ['Black', 'Sand'],
    sizes: ['M', 'L', 'XL'],
    stockPerVariant: 12,
  },
  {
    name: 'Slim Fit Formal Shirt',
    category: 'Shirts',
    brand: 'Meridian',
    description: 'Wrinkle-resistant poplin with a cutaway collar.',
    basePriceMinor: 189_000,
    costPriceMinor: 110_000,
    colors: ['White', 'Sky Blue', 'Charcoal'],
    sizes: ['38', '40', '42', '44'],
    stockPerVariant: 10,
  },
  {
    name: 'Half Sleeve Casual Shirt',
    category: 'Shirts',
    brand: 'Meridian',
    description: 'Soft-washed cotton with a relaxed camp collar.',
    basePriceMinor: 149_000,
    costPriceMinor: 88_000,
    colors: ['Olive', 'Rust'],
    sizes: ['M', 'L', 'XL'],
    stockPerVariant: 9,
  },
  {
    name: 'Embroidered Cotton Panjabi',
    category: 'Panjabi',
    brand: 'Aranya',
    description: 'Hand-embroidered neckline on breathable cotton. Eid favourite.',
    basePriceMinor: 289_000,
    costPriceMinor: 165_000,
    colors: ['Off White', 'Maroon', 'Navy'],
    sizes: ['38', '40', '42', '44'],
    stockPerVariant: 8,
  },
  {
    name: 'Straight Fit Denim Jeans',
    category: 'Jeans & Trousers',
    brand: 'Ironworks',
    description: '13oz rigid denim with a mid-rise straight leg.',
    basePriceMinor: 249_000,
    costPriceMinor: 148_000,
    colors: ['Indigo', 'Black'],
    sizes: ['30', '32', '34', '36'],
    stockPerVariant: 11,
  },
  {
    name: 'Stretch Chino Trouser',
    category: 'Jeans & Trousers',
    brand: 'Ironworks',
    description: 'Two-way stretch twill that holds a crease all day.',
    basePriceMinor: 219_000,
    costPriceMinor: 128_000,
    colors: ['Khaki', 'Navy'],
    sizes: ['30', '32', '34'],
    stockPerVariant: 7,
  },
  {
    name: 'Half Silk Jamdani Saree',
    category: 'Sarees',
    brand: 'Aranya',
    description: 'Handloom jamdani with a contrast pallu. Each piece is unique.',
    basePriceMinor: 545_000,
    costPriceMinor: 320_000,
    colors: ['Red', 'Teal', 'Mustard'],
    sizes: [],
    stockPerVariant: 5,
  },
  {
    name: 'Kids Printed T-Shirt',
    category: 'Kids',
    brand: 'Little Loom',
    description: 'Soft cotton tee with a water-based non-toxic print.',
    basePriceMinor: 55_000,
    costPriceMinor: 29_000,
    colors: ['Yellow', 'Sky Blue'],
    sizes: ['2Y', '4Y', '6Y', '8Y'],
    stockPerVariant: 14,
  },
  {
    name: 'Genuine Leather Belt',
    category: 'Accessories',
    brand: 'Ironworks',
    description: 'Full-grain leather with a brushed steel buckle.',
    basePriceMinor: 129_000,
    costPriceMinor: 62_000,
    colors: ['Black', 'Brown'],
    sizes: [],
    stockPerVariant: 16,
  },
];

export const SEED_CUSTOMERS = [
  { name: 'Rahim Uddin', phone: '01711000001', email: 'rahim@example.com', notes: 'Prefers size L' },
  { name: 'Nusrat Jahan', phone: '01711000002', email: 'nusrat@example.com', notes: 'Regular saree buyer' },
  { name: 'Tanvir Hasan', phone: '01711000003', email: '', notes: '' },
  { name: 'Farhana Akter', phone: '01711000004', email: 'farhana@example.com', notes: 'Wholesale enquiries' },
];
