/**
 * One-off, READ-ONLY investigation of the invoice_headers unique-constraint
 * conflicts hit during the first real run (23505 on (restaurant_id,
 * invoice_number) for Turmeric/109656 and BASIL/109676). For each conflict,
 * pulls the EXISTING header+file+lines that already occupy that invoice_number,
 * and the NEW file we just uploaded that collided with it, so the two can be
 * compared on invoice_date/total/line-item content:
 *   - same date+total+items  → same physical receipt uploaded via two
 *     different filenames (a filename-normalization bug)
 *   - different date+total+items → invoice_number genuinely collides across
 *     unrelated receipts (schema/dedup-key assumption is wrong)
 *
 * GET/HEAD only — no inserts, updates, deletes, or schema changes.
 * Usage: npx tsx scripts/investigate-invoice-collision.ts
 */
import { pgFilter, supabaseCount, supabaseGet } from '../src/supabase.js';

interface HeaderRow {
  id: string;
  invoice_number: string | null;
  invoice_date: string;
  total: number;
  vendor: string;
  created_at?: string;
  file_id: string | null;
}

interface FileRow {
  id: string;
  filename: string;
  drive_file_id: string;
  file_date: string | null;
  file_total: number | null;
}

interface LineRow {
  item_name: string;
  unit_qty: number;
  unit_price: number;
  total: number;
}

interface ConflictCase {
  restaurantId: string;
  restaurantName: string;
  invoiceNumber: string;
  newFilename: string;
}

const CASES: ConflictCase[] = [
  {
    restaurantId: '525b4f99-3693-43ff-8449-f8891ea5081b',
    restaurantName: 'Turmeric STL',
    invoiceNumber: '109656',
    newFilename: 'RestaurantDepot_2026-06-15_$64-89.xlsx',
  },
  {
    restaurantId: '5ee302f5-d3b6-44ec-be64-b9ece24d9e1e',
    restaurantName: 'BASIL INDIA',
    invoiceNumber: '109676',
    newFilename: 'RestaurantDepot_2026-06-16_$125-60.xlsx',
  },
];

async function investigate(c: ConflictCase) {
  console.log('='.repeat(70));
  console.log(`  ${c.restaurantName} — invoice_number ${c.invoiceNumber}`);
  console.log('='.repeat(70));

  // ── Existing header that already owns this (restaurant_id, invoice_number) ──
  const headers = await supabaseGet<HeaderRow[]>(
    'invoice_headers',
    `?restaurant_id=${pgFilter('eq', c.restaurantId)}&invoice_number=${pgFilter('eq', c.invoiceNumber)}&select=id,invoice_number,invoice_date,total,vendor,created_at,file_id`
  );
  const header = headers[0];

  console.log('\n--- EXISTING invoice_headers row ---');
  console.log(header ?? '(none found)');

  let existingFile: FileRow | undefined;
  if (header?.file_id) {
    const files = await supabaseGet<FileRow[]>(
      'invoice_files',
      `?id=${pgFilter('eq', header.file_id)}&select=id,filename,drive_file_id,file_date,file_total`
    );
    existingFile = files[0];
  }
  console.log('\n--- EXISTING invoice_files row (via header.file_id) ---');
  console.log(existingFile ?? '(none found / header.file_id was null)');

  if (header) {
    const lineCount = await supabaseCount(
      'invoice_lines',
      `?header_id=${pgFilter('eq', header.id)}&select=id`
    );
    console.log(`\n--- EXISTING invoice_lines count for header_id ${header.id}: ${lineCount} ---`);

    const firstLines = await supabaseGet<LineRow[]>(
      'invoice_lines',
      `?header_id=${pgFilter('eq', header.id)}&select=item_name,unit_qty,unit_price,total&limit=3`
    );
    console.log('First 3 lines:');
    console.log(firstLines);
  }

  // ── The NEW file we just uploaded that collided on insert ──
  const newFiles = await supabaseGet<FileRow[]>(
    'invoice_files',
    `?restaurant_id=${pgFilter('eq', c.restaurantId)}&filename=${pgFilter('eq', c.newFilename)}&select=id,filename,drive_file_id,file_date,file_total`
  );
  const newFile = newFiles[0];
  console.log(`\n--- NEW invoice_files row (${c.newFilename}) — no header (insert conflicted) ---`);
  console.log(newFile ?? '(none found)');

  // ── Side-by-side comparison ──
  console.log('\n--- COMPARISON ---');
  if (header && existingFile && newFile) {
    const sameDate = existingFile.file_date === newFile.file_date;
    const sameTotal = existingFile.file_total === newFile.file_total;
    console.log(`existing file_date: ${existingFile.file_date}   new file_date: ${newFile.file_date}   match: ${sameDate}`);
    console.log(`existing file_total: ${existingFile.file_total}   new file_total: ${newFile.file_total}   match: ${sameTotal}`);
    console.log(
      sameDate && sameTotal
        ? '=> Same date + total: likely the SAME physical receipt uploaded under two different filenames.'
        : '=> Date and/or total differ: likely DIFFERENT physical receipts that happen to share an invoice_number.'
    );
  } else {
    console.log('Could not compare — missing existing header/file or new file row (see above).');
  }
  console.log();
}

async function main() {
  console.log('Read-only invoice_number collision investigation (no writes)\n');
  for (const c of CASES) {
    await investigate(c);
  }
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
