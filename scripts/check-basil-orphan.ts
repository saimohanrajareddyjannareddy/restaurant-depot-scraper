/**
 * One-off, READ-ONLY diagnostic: fetch BASIL INDIA's one orphan file (present
 * in both Supabase invoice_files and Drive, but missing an invoice_headers
 * row — found by scripts/check-drive-supabase-crossref.ts) directly from
 * Drive by its drive_file_id, and run it through the real parseInvoiceExcel
 * to see whether it genuinely has zero line items (expected for a $0.00
 * credit/return) or whether something is actually broken.
 *
 * Read-only: GET from Supabase, drive.files.get (media download, not a
 * mutation) from Drive. The downloaded file is deleted at the end.
 *
 * Usage: npx tsx scripts/check-basil-orphan.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { createDriveClient, verifyDriveAccess } from '../src/drive.js';
import { parseInvoiceExcel } from '../src/excel.js';
import { pgFilter, supabaseGet } from '../src/supabase.js';

const BASIL_RESTAURANT_ID = '5ee302f5-d3b6-44ec-be64-b9ece24d9e1e';
const ORPHAN_FILENAME = 'RestaurantDepot_2026-06-22_$0-00.xlsx';

async function main() {
  console.log(`Looking up drive_file_id for "${ORPHAN_FILENAME}"...`);
  const rows = await supabaseGet<Array<{ id: string; filename: string; drive_file_id: string }>>(
    'invoice_files',
    `?restaurant_id=${pgFilter('eq', BASIL_RESTAURANT_ID)}&filename=${pgFilter('eq', ORPHAN_FILENAME)}&select=id,filename,drive_file_id`
  );

  const fileRow = rows[0];
  if (!fileRow) {
    throw new Error(`No invoice_files row found for filename "${ORPHAN_FILENAME}" — filename may have changed since the crossref run.`);
  }
  console.log('Found invoice_files row:', fileRow);

  const drive = createDriveClient();
  await verifyDriveAccess(drive);

  const localPath = path.join(config.paths.tmpDir, 'basil-orphan.xlsx');
  console.log(`\nDownloading drive_file_id ${fileRow.drive_file_id} to ${localPath}...`);

  const res = await drive.files.get({ fileId: fileRow.drive_file_id, alt: 'media' }, { responseType: 'stream' });

  await new Promise<void>((resolve, reject) => {
    const writeStream = fs.createWriteStream(localPath);
    (res.data as NodeJS.ReadableStream).pipe(writeStream).on('finish', () => resolve()).on('error', reject);
  });

  const stat = fs.statSync(localPath);
  console.log(`Downloaded ${stat.size} bytes.`);

  console.log('\nRunning parseInvoiceExcel...\n');
  const parsed = parseInvoiceExcel(localPath);

  if (!parsed) {
    console.log('parseInvoiceExcel returned null (parse threw internally — see warning above).');
  } else {
    console.log(`invoice_number: ${parsed.invoice_number}`);
    console.log(`items.length: ${parsed.items.length}`);
    if (parsed.items.length > 0) {
      console.log('\nFirst 5 items:');
      console.log(JSON.stringify(parsed.items.slice(0, 5), null, 2));
    } else {
      console.log('\nZero items — consistent with a genuine $0.00 credit/return receipt with no line items.');
    }
  }

  fs.unlinkSync(localPath);
  console.log(`\nDeleted ${localPath}.`);
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
