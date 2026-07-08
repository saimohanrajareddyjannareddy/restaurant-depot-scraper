/**
 * One-off cleanup: removes the two duplicate Drive files + invoice_files rows
 * created by the total-sign filename bug (fixed in src/client.ts's totalMatch
 * regex — see scripts/investigate-invoice-collision.ts for the diagnosis).
 * Each target is a WRONGLY-SIGNED re-upload of an existing negative-total
 * return receipt; the correctly-signed original (with its real
 * invoice_headers/invoice_lines) is left completely untouched. Neither
 * target ever had an invoice_headers row — the unique constraint on
 * (restaurant_id, invoice_number) rejected that insert — so there is nothing
 * to clean up in invoice_headers or invoice_lines.
 *
 * DRY-RUN BY DEFAULT. Pass --confirm to actually delete anything.
 *
 * Usage:
 *   npx tsx scripts/cleanup-signed-duplicates.ts            (dry-run)
 *   npx tsx scripts/cleanup-signed-duplicates.ts --dry       (explicit dry-run)
 *   npx tsx scripts/cleanup-signed-duplicates.ts --confirm   (actually deletes)
 */
import { createDriveClient, deleteDriveFile, verifyDriveAccess } from '../src/drive.js';
import { pgFilter, supabaseDelete, supabaseGet } from '../src/supabase.js';

interface Target {
  restaurantId: string;
  restaurantName: string;
  filename: string;
}

const TARGETS: Target[] = [
  {
    restaurantId: '525b4f99-3693-43ff-8449-f8891ea5081b',
    restaurantName: 'Turmeric STL',
    filename: 'RestaurantDepot_2026-06-15_$64-89.xlsx',
  },
  {
    restaurantId: '5ee302f5-d3b6-44ec-be64-b9ece24d9e1e',
    restaurantName: 'BASIL INDIA',
    filename: 'RestaurantDepot_2026-06-16_$125-60.xlsx',
  },
];

interface FileRow {
  id: string;
  filename: string;
  drive_file_id: string;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  console.log(
    confirm
      ? '*** LIVE MODE — will actually delete Drive files and invoice_files rows ***\n'
      : 'DRY RUN — nothing will be deleted (pass --confirm to actually delete)\n'
  );

  const drive = createDriveClient();
  await verifyDriveAccess(drive);

  for (const target of TARGETS) {
    console.log('='.repeat(60));
    console.log(`  ${target.restaurantName}: ${target.filename}`);
    console.log('='.repeat(60));

    const rows = await supabaseGet<FileRow[]>(
      'invoice_files',
      `?restaurant_id=${pgFilter('eq', target.restaurantId)}&filename=${pgFilter('eq', target.filename)}&select=id,filename,drive_file_id`
    );
    const row = rows[0];

    if (!row) {
      console.log('  No matching invoice_files row found — nothing to do (may already be cleaned up).\n');
      continue;
    }

    console.log(`  invoice_files.id: ${row.id}`);
    console.log(`  drive_file_id:    ${row.drive_file_id}`);
    console.log(`  PLAN: delete Drive file ${row.drive_file_id}, then delete invoice_files row ${row.id}`);

    if (!confirm) {
      console.log('  (dry-run — skipped)\n');
      continue;
    }

    await deleteDriveFile(drive, row.drive_file_id);
    console.log(`  Deleted Drive file ${row.drive_file_id}`);

    await supabaseDelete('invoice_files', `?id=${pgFilter('eq', row.id)}`);
    console.log(`  Deleted invoice_files row ${row.id}`);
    console.log();
  }

  console.log(confirm ? 'Cleanup complete.' : 'Dry run complete — re-run with --confirm to actually delete.');
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
