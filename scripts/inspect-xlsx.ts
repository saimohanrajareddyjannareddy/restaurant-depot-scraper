/**
 * Diagnostic tool for src/excel.ts's parseInvoiceExcel. Dumps a receipt's raw
 * sheet rows, the auto-detected header row, and the resulting column names,
 * so a parsing regression (e.g. "No line items parsed from Excel") can be
 * diagnosed against the actual file instead of guessing. Run it whenever
 * Restaurant Depot changes their .xlsx export format and line items stop
 * parsing: grab a real downloaded file from tmp/ (temporarily comment out
 * the fs.unlinkSync cleanup in src/client.ts to keep one around) and run:
 *   npx tsx scripts/inspect-xlsx.ts tmp/<some-receipt>.xlsx
 */

// SECURITY NOTE: see src/excel.ts — same xlsx@0.18.5 CVE tradeoff applies here.
// This script only ever reads files we downloaded ourselves for debugging.
import XLSX from 'xlsx';

const filePath = process.argv[2];
if (!filePath) {
  console.log('Usage: npx tsx scripts/inspect-xlsx.ts <path-to-xlsx>');
  process.exit(1);
}

const workbook = XLSX.readFile(filePath);

console.log('=== workbook.SheetNames ===');
console.log(workbook.SheetNames);

const sheet = workbook.Sheets[workbook.SheetNames[0]!]!;

console.log('\n=== sheet 0: first 20 rows (header:1, defval:"") ===');
const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
rawRows.slice(0, 20).forEach((row, i) => {
  console.log(`row ${i}:`, JSON.stringify(row));
});

// Mirror src/excel.ts's auto-header detection exactly.
let headerRowIdx = 0;
for (let i = 0; i < Math.min(20, rawRows.length); i++) {
  const lower = rawRows[i]!.map((c) => String(c).toLowerCase()).join(' ');
  if (/qty|quantity|price|desc|item|product/.test(lower)) {
    headerRowIdx = i;
    break;
  }
}

console.log(`\n=== detected headerRowIdx: ${headerRowIdx} ===`);

const jsonRows: Array<Record<string, unknown>> = XLSX.utils.sheet_to_json(sheet, {
  range: headerRowIdx,
  defval: '',
});

console.log('\n=== sheet 0: columns after auto-header detection (keys of first parsed row) ===');
console.log(Object.keys(jsonRows[0] ?? {}));

console.log('\n=== sheet 0: first parsed row (full object) ===');
console.log(jsonRows[0] ?? '(no rows)');
