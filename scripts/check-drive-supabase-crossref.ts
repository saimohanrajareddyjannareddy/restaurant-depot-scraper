/**
 * One-off, READ-ONLY cross-reference audit between Google Drive and Supabase,
 * per restaurant. Run this before the first real (non-dry-run) scrape for any
 * restaurant that may already have prior (e.g. Apify) data, to see exactly
 * what's already covered versus what a real run would actually recover.
 *
 * For each restaurant, computes three sets by comparing invoice_files.filename
 * (Supabase) against the Drive folder's actual contents, and cross-referencing
 * invoice_headers.file_id to know which files have a parsed header row:
 *   - filesInDriveButNotSupabase:   Drive has it, invoice_files row missing
 *   - filesInSupabaseButNotDrive:   invoice_files row exists, Drive file missing
 *   - filesInBothButMissingHeader:  present in both, but no invoice_headers row
 *     — these are exactly the receipts a real scrape run should recover.
 *
 * Also prints TRUE row counts (PostgREST Prefer: count=exact) for
 * invoice_files/invoice_headers/invoice_lines, avoiding the default ~1000-row
 * page cap that undercounted invoice_lines in the earlier plain-count check.
 *
 * No writes to Drive or Supabase — GET/HEAD only throughout.
 * Usage: npx tsx scripts/check-drive-supabase-crossref.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { createDriveClient, listDriveFolderFilenames, verifyDriveAccess } from '../src/drive.js';
import { pgFilter, supabaseCount, supabaseGet } from '../src/supabase.js';

interface RestaurantRow {
  id: string;
  name: string;
  drive_folder_id: string;
}

const RESTAURANT_IDS = [
  '525b4f99-3693-43ff-8449-f8891ea5081b', // Turmeric STL
  '5ee302f5-d3b6-44ec-be64-b9ece24d9e1e', // BASIL INDIA
];

const OUTPUT_FILENAMES: Record<string, string> = {
  '525b4f99-3693-43ff-8449-f8891ea5081b': 'turmeric-state.json',
  '5ee302f5-d3b6-44ec-be64-b9ece24d9e1e': 'basil-state.json',
};

const TABLES = ['invoice_files', 'invoice_headers', 'invoice_lines'] as const;

async function trueCounts(restaurantId: string): Promise<Record<(typeof TABLES)[number], number>> {
  const filter = `?restaurant_id=${pgFilter('eq', restaurantId)}&select=id`;
  const [invoice_files, invoice_headers, invoice_lines] = await Promise.all([
    supabaseCount('invoice_files', filter),
    supabaseCount('invoice_headers', filter),
    supabaseCount('invoice_lines', filter),
  ]);
  return { invoice_files, invoice_headers, invoice_lines };
}

function printSample(label: string, list: string[]): void {
  console.log(`  ${label}: ${list.length}`);
  if (list.length > 0) {
    console.log(`    sample: ${JSON.stringify(list.slice(0, 5))}`);
  }
}

async function main() {
  console.log('Read-only Drive/Supabase cross-reference audit (no writes)\n');

  const restaurants = await supabaseGet<RestaurantRow[]>(
    'restaurants',
    `?id=in.(${RESTAURANT_IDS.join(',')})&select=id,name,drive_folder_id`
  );

  const drive = createDriveClient();
  await verifyDriveAccess(drive);
  console.log('Drive credentials verified\n');

  for (const restaurant of restaurants) {
    console.log('='.repeat(60));
    console.log(`  ${restaurant.name} (${restaurant.id})`);
    console.log('='.repeat(60));

    const counts = await trueCounts(restaurant.id);
    console.log('True row counts (Prefer: count=exact):', counts);

    const filesFilter = `?restaurant_id=${pgFilter('eq', restaurant.id)}&select=id,filename`;
    const supabaseFiles = await supabaseGet<Array<{ id: string; filename: string }>>('invoice_files', filesFilter);

    const headersFilter = `?restaurant_id=${pgFilter('eq', restaurant.id)}&select=file_id`;
    const headerRows = await supabaseGet<Array<{ file_id: string | null }>>('invoice_headers', headersFilter);
    const fileIdsWithHeader = new Set(headerRows.map((h) => h.file_id).filter((id): id is string => id != null));

    const driveFilenames = await listDriveFolderFilenames(drive, restaurant.drive_folder_id);
    const driveSet = new Set(driveFilenames);
    const supabaseFilenameSet = new Set(supabaseFiles.map((f) => f.filename));

    const filesInDriveButNotSupabase = driveFilenames.filter((name) => !supabaseFilenameSet.has(name));
    const filesInSupabaseButNotDrive = supabaseFiles.filter((f) => !driveSet.has(f.filename)).map((f) => f.filename);
    const filesInBothButMissingHeader = supabaseFiles
      .filter((f) => driveSet.has(f.filename) && !fileIdsWithHeader.has(f.id))
      .map((f) => f.filename);
    const filesWithHeader = supabaseFiles.filter((f) => fileIdsWithHeader.has(f.id)).map((f) => f.filename);

    console.log(`\n  invoice_files rows: ${supabaseFiles.length}`);
    console.log(`  Drive files:        ${driveFilenames.length}`);
    console.log(`  invoice_headers rows (non-null file_id): ${fileIdsWithHeader.size}\n`);

    printSample('filesInDriveButNotSupabase', filesInDriveButNotSupabase);
    printSample('filesInSupabaseButNotDrive', filesInSupabaseButNotDrive);
    printSample('filesInBothButMissingHeader', filesInBothButMissingHeader);
    console.log();

    const outPath = path.join(config.paths.logsDir, OUTPUT_FILENAMES[restaurant.id] ?? `${restaurant.id}-state.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          trueCounts: counts,
          supabaseFilenames: supabaseFiles.map((f) => f.filename),
          driveFilenames,
          filesWithHeaderFilenames: filesWithHeader,
          filesInDriveButNotSupabase,
          filesInSupabaseButNotDrive,
          filesInBothButMissingHeader,
        },
        null,
        2
      )
    );
    console.log(`Wrote full detail to ${outPath}\n`);
  }
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
