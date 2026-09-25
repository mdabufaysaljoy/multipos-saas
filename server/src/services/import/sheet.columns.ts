/**
 * A column registry: what a vertical's import file may contain.
 *
 * Clothing's registry is the original (`modules/productImports/import.columns`);
 * the other three declare their own. Everything downstream - finding the header
 * row, refusing a file, mapping headers to fields - works from whichever
 * registry it is handed, so adding a vertical is a list of columns and nothing
 * else.
 */
export interface ImportColumnSpec<TField extends string = string> {
  field: TField;
  /** The header this vertical's export writes; always accepted. */
  label: string;
  required: boolean;
  /** Other accepted headers, matched after normalising. Nothing is guessed by similarity. */
  aliases: string[];
  hint: string;
}

/** Lower case, trimmed, runs of whitespace collapsed, surrounding quotes dropped. */
export const normalizeHeader = (value: string): string =>
  value
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/**
 * Columns an import ignores rather than rejects: the ones an export writes for
 * information, and the ownership columns that must never be trusted from a
 * file. A file carrying them is still a good file.
 */
const IGNORED_HEADERS = new Set(
  [
    'product id',
    'productid',
    'variant id',
    'variantid',
    'medicine id',
    'item id',
    'id',
    '_id',
    'tenant id',
    'tenantid',
    'workspace id',
    'workspaceid',
    'store id',
    'storeid',
    'branch id',
    'account id',
    'category id',
    'categoryid',
    'brand id',
    'supplier id',
    'created',
    'created at',
    'updated',
    'updated at',
  ].map(normalizeHeader),
);

export const isIgnoredHeader = (header: string): boolean => IGNORED_HEADERS.has(normalizeHeader(header));

/** Everything the parser needs about one vertical's columns, built once. */
export interface ColumnRegistry<TField extends string = string> {
  columns: ImportColumnSpec<TField>[];
  requiredFields: TField[];
  requiredLabels: string[];
  /** The field a header names, or null when it is not one of this vertical's. */
  fieldForHeader(header: string): TField | null;
  /** How many distinct fields a row of cells names; used to find the header row. */
  headerScore(cells: string[]): number;
}

export function buildRegistry<TField extends string>(columns: ImportColumnSpec<TField>[]): ColumnRegistry<TField> {
  const lookup = new Map<string, TField>();
  for (const column of columns) {
    for (const header of [column.label, ...column.aliases]) {
      const key = normalizeHeader(header);
      const claimed = lookup.get(key);
      if (claimed && claimed !== column.field) throw new Error(`Ambiguous import header "${header}"`);
      lookup.set(key, column.field);
    }
  }

  const fieldForHeader = (header: string): TField | null => lookup.get(normalizeHeader(header)) ?? null;

  return {
    columns,
    requiredFields: columns.filter((column) => column.required).map((column) => column.field),
    requiredLabels: columns.filter((column) => column.required).map((column) => column.label),
    fieldForHeader,
    headerScore: (cells) => {
      const fields = new Set<TField>();
      for (const cell of cells) {
        const field = fieldForHeader(cell);
        if (field) fields.add(field);
      }
      return fields.size;
    },
  };
}
