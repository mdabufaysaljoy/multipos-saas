import React from "react";

/**
 * Stroke-only glyphs drawn on a 24x24 grid so every icon shares one weight and
 * one optical size. `currentColor` lets a tile set the accent in one place.
 */
const paths: Record<string, React.ReactNode> = {
  cart: (
    <>
      <path d="M3 4h3l2.4 10.4a2 2 0 0 0 2 1.6h7.3a2 2 0 0 0 2-1.5L21 8H7" />
      <circle cx="10" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
    </>
  ),
  printer: (
    <>
      <path d="M7 9V3h10v6" />
      <path d="M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <path d="M7 14h10v7H7z" />
    </>
  ),
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M2 10h20" />
      <path d="M6 15h4" />
    </>
  ),
  boxes: (
    <>
      <path d="M3 8l4.5-2.5L12 8l-4.5 2.5L3 8z" />
      <path d="M12 8l4.5-2.5L21 8l-4.5 2.5L12 8z" />
      <path d="M7.5 15l4.5-2.5L16.5 15 12 17.5 7.5 15z" />
      <path d="M3 8v5l4.5 2.5M21 8v5l-4.5 2.5M12 17.5V21" />
    </>
  ),
  returnArrow: (
    <>
      <path d="M4 9h11a5 5 0 0 1 0 10H9" />
      <path d="M8 5L4 9l4 4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <circle cx="12" cy="19" r="2.2" />
      <path d="M6 8.2v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3" />
      <path d="M12 13.2v3.6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5.5c0 4.3-2.9 7.8-7 9.5-4.1-1.7-7-5.2-7-9.5V6l7-3z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </>
  ),
  star: (
    <>
      <path d="M12 3.5l2.7 5.6 6 .8-4.4 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.3 9.9l6-.8L12 3.5z" />
    </>
  ),
  megaphone: (
    <>
      <path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z" />
      <path d="M17 8.5a5 5 0 0 1 0 7" />
      <path d="M20 6a9 9 0 0 1 0 12" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M8 20v-6" />
      <path d="M13 20V8" />
      <path d="M18 20v-9" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  spark: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5L15 9M9 15l-2.5 2.5" />
    </>
  ),
};

export const Icon: React.FC<{ name: string; size?: number; strokeWidth?: number }> = ({
  name,
  size = 44,
  strokeWidth = 1.8,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {paths[name] ?? paths.spark}
  </svg>
);
