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

    // Detect column mapping once, log so we can verify against real RD xlsx.
    // Restaurant Depot receipts have separate "Unit Qty" and "Case Qty" columns —
    // the OLD code's /\bqty\b/ regex matched "Unit Qty" first and never read Case Qty,
    // which is why case-sold items (milk, cream, cauliflower) showed qty=0 and total=$0.
    const firstRowKeys = Object.keys(jsonRows[0] ?? {});
    const unitQtyKey = firstRowKeys.find((k) => /unit.?qty|unit.?quantity/i.test(k));
    const caseQtyKey = firstRowKeys.find((k) => /case.?qty|case.?quantity/i.test(k));
    const priceKey = firstRowKeys.find((k) => /\bprice\b|unit.?cost|\bcost\b/i.test(k));
    const totalKey = firstRowKeys.find((k) => /\btotal\b|extended|\bamount\b|line.?total|row.?total/i.test(k));
    const descKey = firstRowKeys.find((k) => /desc|item|product|name/i.test(k));
    // Fallback for non-RD invoice formats that only have a generic "qty" column
    const genericQtyKey = !unitQtyKey && !caseQtyKey
      ? firstRowKeys.find((k) => /\bqty\b|quantity/i.test(k))
      : undefined;

    logger.info('Detected column mapping', {
      descKey, unitQtyKey, caseQtyKey, priceKey, totalKey, genericQtyKey,
    });

    const items: ParsedInvoiceItem[] = [];
    for (const row of jsonRows) {
      const item_name = descKey ? String(row[descKey]).trim() : '';
      if (!item_name) continue;

      // Skip receipt footer/summary rows: "Sub-Total", "Tax", "Total", card lines,
      // "Previous Balance", "Balance", etc. Old regex missed "Sub-Total" (with hyphen)
      // and card-payment lines — that's why they leaked into invoice_lines.
      if (/^(sub[-\s]?total|tax|freight|discount|balance|previous\s+balance|amex|visa|mastercard|master\s*card|discover|change\s+due|amount\s+due|total|tender|cash)\b/i.test(item_name)) {
        continue;
      }

      // Read Unit Qty and Case Qty as SEPARATE columns (both exist on RD receipts).
      // Only one is typically non-zero per row: items sold by weight/count use Unit Qty,
      // items sold by the case use Case Qty.
      const unit_qty = unitQtyKey
        ? parseNum(row[unitQtyKey])
        : (genericQtyKey ? parseNum(row[genericQtyKey]) : 0);
      const case_qty = caseQtyKey ? parseNum(row[caseQtyKey]) : 0;

      // CRITICAL FIX: On Restaurant Depot receipts, the "Price" column is the LINE TOTAL
      // for the row, NOT the unit price. Old code did `total = qty * unit_price`, which
      // produced $3,168 for 40 lbs of chicken (correct total is $79.20).
      // Rule: prefer an explicit Total/Extended column; otherwise the Price column IS
      // the line total.
      const priceValue = priceKey ? parseNum(row[priceKey]) : 0;
      const explicitTotal = totalKey ? parseNum(row[totalKey]) : 0;
      const total = explicitTotal || priceValue;

      // Back-compute unit price from total ÷ effective quantity (matches Apify's format).
      const effectiveQty = unit_qty > 0 ? unit_qty : case_qty;
      const unit_price = effectiveQty > 0 ? total / effectiveQty : total;

      // Skip fully empty rows
      if (total === 0 && effectiveQty === 0) continue;

      items.push({
        item_name,
        category: 'Other',
        unit_qty,
        case_qty,
        unit_price,
        total,
      });
    }

    return { invoice_number, items };
  } catch (err) {
    logger.warn('Excel parse failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
