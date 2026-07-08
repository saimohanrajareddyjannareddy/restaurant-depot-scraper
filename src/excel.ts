// SECURITY NOTE: xlsx@0.18.5 (SheetJS's last npm release) has a known
// prototype-pollution CVE (GHSA-4r6h-8v6p-xvw6) and SheetJS has since moved
// distribution off npm. We accept that risk here deliberately: the only
// files this module ever parses are .xlsx receipts we just downloaded
// ourselves from our own authenticated restaurantdepot.com session — never
// user-supplied or otherwise untrusted input. Do not repurpose parseInvoiceExcel
// to parse files from any other source without re-evaluating this tradeoff.
import XLSX from 'xlsx';
import { logger } from './logger.js';

/** Format any date string to YYYY-MM-DD. */
export function formatDate(rawDate: string): string {
  const d = new Date(rawDate);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]!;

  // Try MM/DD/YYYY manually
  const m = rawDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  return rawDate.replace(/\//g, '-');
}

/**
 * Strip $ and commas, replace ALL dots with hyphens for filename safety.
 * A leading minus (returns/credits) is preserved as-is — the [$,\s] class
 * below never matches '-', so this already produces the reference actor's
 * exact filename shape for negative totals without any special-casing:
 *   totalToFilenameSegment('-$64.89')    // "-64-89"
 *   totalToFilenameSegment('$1,507.64')  // "1507-64"
 */
export function totalToFilenameSegment(totalStr: string): string {
  return totalStr.replace(/[$,\s]/g, '').replace(/\./g, '-');
}

/**
 * Reverse of totalToFilenameSegment — parse dollar total from filename.
 * e.g. 'RestaurantDepot_2026-02-17_$1665-64.xlsx' → 1665.64
 */
export function parseFilenameTotal(filename: string): number | null {
  const m = filename.match(/\$(\d+)-(\d{2})\.xlsx$/);
  if (m) return parseFloat(`${m[1]}.${m[2]}`);
  return null;
}

/**
 * Parse date from filename.
 * e.g. 'RestaurantDepot_2026-02-17_$1665-64.xlsx' → '2026-02-17'
 */
export function parseFilenameDate(filename: string): string | null {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

export interface ParsedInvoiceItem {
  item_name: string;
  category: string;
  unit_qty: number;
  case_qty: number;
  unit_price: number;
  total: number;
}

export interface ParsedInvoice {
  invoice_number: string | null;
  items: ParsedInvoiceItem[];
}

export function parseInvoiceExcel(localPath: string): ParsedInvoice | null {
  try {
    const workbook = XLSX.readFile(localPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]!]!;
    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    logger.debug(`Excel rows: ${rawRows.length}`, { firstRows: rawRows.slice(0, 4) });

    // Find the header row (contains qty/price/description keywords)
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(20, rawRows.length); i++) {
      const lower = rawRows[i]!.map((c) => String(c).toLowerCase()).join(' ');
      if (/qty|quantity|price|desc|item|product/.test(lower)) {
        headerRowIdx = i;
        break;
      }
    }

    // Parse with auto-detected header
    const jsonRows: Array<Record<string, unknown>> = XLSX.utils.sheet_to_json(sheet, {
      range: headerRowIdx,
      defval: '',
    });
    logger.debug(`Header row ${headerRowIdx}`, { columns: Object.keys(jsonRows[0] ?? {}) });

    // Look for invoice/order number above the header
    let invoice_number: string | null = null;
    for (let i = 0; i < headerRowIdx; i++) {
      const m = rawRows[i]!.join(' ').match(/(?:invoice|order|receipt)[#\s:]*([A-Z0-9-]+)/i);
      if (m) {
        invoice_number = m[1]!;
        break;
      }
    }

    const parseNum = (val: unknown): number => {
      const n = parseFloat(String(val ?? '').replace(/[$,]/g, ''));
      return isNaN(n) ? 0 : n;
    };

    const items: ParsedInvoiceItem[] = [];
    for (const row of jsonRows) {
      const keys = Object.keys(row);
      const descKey = keys.find((k) => /desc|item|product|name/i.test(k));
      const qtyKey = keys.find((k) => /\bqty\b|quantity/i.test(k));
      const priceKey = keys.find((k) => /unit.?price|price.?unit|\beach\b|unit.?cost|\bprice\b|\bcost\b/i.test(k));
      const totalKey = keys.find((k) => /\btotal\b|extended|\bamount\b|\bext\b|line.?total|row.?total/i.test(k));

      const item_name = descKey ? String(row[descKey]).trim() : '';
      if (!item_name || /^(total|subtotal|tax|freight|discount)$/i.test(item_name)) continue;

      const unit_qty = qtyKey ? parseNum(row[qtyKey]) : 0;
      const unit_price = priceKey ? parseNum(row[priceKey]) : 0;
      const total = (totalKey ? parseNum(row[totalKey]) : 0) || unit_qty * unit_price;

      if (unit_price === 0 && total === 0) continue;

      items.push({ item_name, category: 'Other', unit_qty, case_qty: 0, unit_price, total });
    }

    return { invoice_number, items };
  } catch (err) {
    logger.warn('Excel parse failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
