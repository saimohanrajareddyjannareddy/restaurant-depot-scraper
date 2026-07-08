import fs from 'node:fs';
import path from 'node:path';
import type { Browser, ElementHandle, Page } from 'playwright';
import { findElement, openAuthenticatedContext, RECEIPTS_URL } from './auth.js';
import { config } from './config.js';
import { type DriveClient, fileExistsInDrive, uploadToDrive, withRetry } from './drive.js';
import {
  formatDate,
  parseFilenameDate,
  parseFilenameTotal,
  parseInvoiceExcel,
  totalToFilenameSegment,
} from './excel.js';
import { logger, screenshot } from './logger.js';
import {
  insertInvoiceFile,
  insertInvoiceHeader,
  insertInvoiceLine,
  logProcessing,
  type Restaurant,
} from './supabase.js';

export interface ClientSummary {
  restaurantId: string;
  restaurantName: string;
  uploaded: number;
  duplicates: number;
  skipped: number;
  errors: number;
}

type RowHandle = ElementHandle<SVGElement | HTMLElement>;

/** Find an element scoped inside a row handle. */
async function findInRow(rowHandle: RowHandle, selectors: string[]): Promise<RowHandle | null> {
  for (const selector of selectors) {
    try {
      const el = await rowHandle.$(selector);
      if (el) {
        logger.debug(`Row element: ${selector}`);
        return el;
      }
    } catch {
      logger.debug(`Row selector not found: ${selector}`);
    }
  }
  return null;
}

/**
 * Downloads one receipt row and records it (Drive upload + all Supabase writes).
 * Returns 'duplicate' if the dedup check finds it already in Drive, 'uploaded' otherwise.
 *
 * The dedup check runs INSIDE this function — re-checked on every retry attempt,
 * not just once before the retry loop — so if attempt 1 somehow uploaded to Drive
 * and then threw before finishing the Supabase writes, attempt 2 sees the file
 * already there and skips straight past re-downloading it. Combined with the fact
 * that everything after a successful Drive upload is internally non-throwing
 * (matches the reference actor — Supabase failures are logged, not fatal), a retry
 * can never cause a duplicate Drive upload or duplicate Supabase rows.
 */
async function downloadAndRecordReceipt(
  page: Page,
  row: RowHandle,
  fileName: string,
  receiptDate: string,
  drive: DriveClient,
  restaurantId: string,
  googleDriveFolderId: string
): Promise<'uploaded' | 'duplicate'> {
  if (await fileExistsInDrive(drive, fileName, googleDriveFolderId)) {
    logger.info('Already in Drive — skipping', { fileName });
    return 'duplicate';
  }

  // BASIL INDIA fix: clicking immediately after the dedup check sometimes races
  // the row's own re-render, and Playwright resolves the download against a
  // stale target — saving to "File not found: .". Give the row a moment first.
  await page.waitForTimeout(500);

  const dlBtn = await findInRow(row, [
    'button:has-text("Download Excel")',
    'a:has-text("Download Excel")',
    'button:has-text("Excel")',
    'a:has-text("Excel")',
    'a[href*=".xlsx"]',
    'a[href*="excel"]',
    'a[href*="download"]',
    '[data-action="download"]',
  ]);
  if (!dlBtn) throw new Error(`No download button found for ${fileName}`);

  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), dlBtn.click()]);

  const localPath = path.join(config.paths.tmpDir, fileName);
  await download.saveAs(localPath);

  const stat = fs.statSync(localPath);
  if (stat.size === 0) {
    throw new Error('Downloaded file is empty (0 bytes) — site may have returned an error page');
  }
  logger.debug('Saved locally', { localPath, bytes: stat.size });

  logger.info(`Uploading to Drive folder ${googleDriveFolderId}`, { fileName });
  const driveFile = await uploadToDrive(drive, localPath, fileName, googleDriveFolderId);
  logger.success('Uploaded', { fileName, webViewLink: driveFile.webViewLink });

  const { id: fileRecordId } = await insertInvoiceFile({
    restaurant_id: restaurantId,
    drive_file_id: driveFile.id,
    filename: fileName,
    file_date: parseFilenameDate(fileName),
    file_total: parseFilenameTotal(fileName),
    status: 'pending',
  });

  await logProcessing({
    fileId: fileRecordId,
    restaurantId,
    stage: 'intake',
    status: 'success',
    message: `Uploaded ${fileName} → Drive ID ${driveFile.id}`,
  });

  try {
    const parsed = parseInvoiceExcel(localPath);
    if (parsed && parsed.items.length > 0) {
      logger.info(`Parsed ${parsed.items.length} line items`, { fileName, invoiceNumber: parsed.invoice_number });

      const { id: headerId } = await insertInvoiceHeader({
        restaurant_id: restaurantId,
        file_id: fileRecordId,
        invoice_number: parsed.invoice_number ?? fileName,
        invoice_date: receiptDate,
        vendor: 'Restaurant Depot',
        total: parseFilenameTotal(fileName) ?? 0,
      });
      if (headerId) {
        for (const item of parsed.items) {
          await insertInvoiceLine({
            header_id: headerId,
            restaurant_id: restaurantId,
            invoice_date: receiptDate,
            item_name: item.item_name,
            category: item.category,
            unit_qty: item.unit_qty,
            case_qty: item.case_qty,
            unit_price: item.unit_price,
            total: item.total,
          });
        }
        logger.info(`Inserted invoice header + ${parsed.items.length} line items to Supabase`, { fileName });
      }
    } else {
      logger.warn('No line items parsed from Excel — skipping invoice insert', { fileName });
    }
  } catch (parseErr) {
    logger.warn('Invoice parse/insert failed', {
      fileName,
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
  }

  try {
    fs.unlinkSync(localPath);
  } catch {
    /* cleanup best-effort */
  }

  return 'uploaded';
}

/**
 * Process one restaurant client inside a dedicated browser context.
 * Opens/reuses an authenticated context, runs the full receipt download flow,
 * closes the context. Returns a per-client summary.
 */
export async function processClient(browser: Browser, client: Restaurant, drive: DriveClient): Promise<ClientSummary> {
  const {
    id: restaurantId,
    name: restaurantName,
    rd_store_number: storeNumber,
    drive_folder_id: googleDriveFolderId,
  } = client;

  logger.section(`CLIENT: ${restaurantName} (id: ${restaurantId})`);

  const summary: ClientSummary = { restaurantId, restaurantName, uploaded: 0, duplicates: 0, skipped: 0, errors: 0 };

  let session;
  try {
    session = await openAuthenticatedContext(browser, client);
  } catch (authErr) {
    const message = authErr instanceof Error ? authErr.message : String(authErr);
    logger.error(`Fatal auth error for ${restaurantName}`, { error: message });
    await logProcessing({ restaurantId, stage: 'intake', status: 'error', message: `Fatal (auth): ${message}` });
    summary.errors++;
    return summary;
  }

  const { context, page } = session;

  try {
    // A fresh login may land on /member root rather than /member/receipts.
    if (!page.url().includes('receipts')) {
      logger.step('Navigating to receipts');
      await page.goto(RECEIPTS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    await screenshot(page, `${restaurantName}_receipts_page`);

    // ── Set date range & click Request ──────────────────────────────────
    logger.step('Setting date range');
    const selectEl = await page.$('select').catch(() => null);
    if (selectEl) {
      try {
        await page.selectOption('select', { label: config.dateRange });
        logger.debug(`Date range set to "${config.dateRange}"`);
      } catch {
        try {
          await page.selectOption('select', { index: 0 });
          logger.debug('Fell back to first date range option');
        } catch {
          logger.warn('Could not set date range select');
        }
      }
    }

    const requestBtn = await findElement(page, [
      'button:has-text("Request")',
      'input[value="Request"]',
      'a:has-text("Request")',
      '[data-testid="request-receipts"]',
    ]);
    if (!requestBtn) throw new Error('Could not find Request button on receipts page');
    await requestBtn.click();
    await page.waitForTimeout(3_000);
    await screenshot(page, `${restaurantName}_receipts_table`);

    // ── Collect rows ───────────────────────────────────────────────────
    logger.step('Collecting receipt rows');
    const rowSelectors = [
      'tr:has(a:has-text("Download Excel"))',
      'tr:has(button:has-text("Download Excel"))',
      'table tr',
      'table tbody tr',
      '[class*="receipt-row"]',
      '[class*="receiptRow"]',
      '[data-testid="receipt-row"]',
    ];
    let rows: RowHandle[] = [];
    for (const sel of rowSelectors) {
      rows = await page.$$(sel);
      if (rows.length > 0) {
        logger.debug(`Found ${rows.length} rows using: ${sel}`);
        break;
      }
    }

    if (rows.length === 0) {
      const preview = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      logger.warn('No receipt rows found', { preview });
      await logProcessing({ restaurantId, stage: 'intake', status: 'warning', message: 'No receipt rows found in table' });
      return summary;
    }

    // ── Download & upload each receipt ────────────────────────────────
    if (storeNumber == null) {
      throw new Error(`rd_store_number is null for ${restaurantName} — set it in Supabase restaurants table`);
    }
    const targetStore = `#${storeNumber}`;

    logger.step(`Processing ${rows.length} receipts for ${restaurantName}`);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      logger.info(`Receipt ${i + 1}/${rows.length}`);

      try {
        const cells = await row.$$('td');
        const cellTexts = await Promise.all(cells.map((c) => c.textContent().then((t) => t?.trim() ?? '')));
        logger.debug('Cell values', { cellTexts });

        // Filter: only process receipts matching this client's store number
        const storeCell = cellTexts.find((t) => /#\d+/.test(t));
        if (!storeCell || !storeCell.includes(targetStore)) {
          logger.info(`Skipping non-${targetStore} store`, { storeCell: storeCell ?? 'unknown' });
          summary.skipped++;
          continue;
        }

        // Parse date and total from cells
        let receiptDate = new Date().toISOString().split('T')[0]!;
        let receiptTotal = '0-00';
        for (const text of cellTexts) {
          const dateMatch = text.match(/\d{4}[\/\-]\d{2}[\/\-]\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/);
          if (dateMatch) receiptDate = formatDate(dateMatch[0]);
          const totalMatch = text.match(/-?\$[\d,]+\.\d{2}/);
          if (totalMatch) receiptTotal = totalToFilenameSegment(totalMatch[0]);
        }

        const fileName = `RestaurantDepot_${receiptDate}_$${receiptTotal}.xlsx`;
        logger.debug(`Target filename: ${fileName}`);

        // Dedup check lives inside downloadAndRecordReceipt (re-checked on every
        // retry attempt) rather than here, so it stays idempotent across retries.
        const result = await withRetry(
          () => downloadAndRecordReceipt(page, row, fileName, receiptDate, drive, restaurantId, googleDriveFolderId),
          2,
          2000
        );

        if (result === 'duplicate') {
          summary.duplicates++;
        } else {
          summary.uploaded++;
        }
      } catch (rowErr) {
        summary.errors++;
        const message = rowErr instanceof Error ? rowErr.message : String(rowErr);
        logger.error(`Error on row ${i + 1}`, { error: message });
        await logProcessing({ restaurantId, stage: 'intake', status: 'error', message: `Row ${i + 1}: ${message}` });
      }
    }
  } catch (clientErr) {
    await screenshot(page, `${restaurantName}_error`);
    const message = clientErr instanceof Error ? clientErr.message : String(clientErr);
    logger.error(`Fatal error for ${restaurantName}`, { error: message });
    await logProcessing({ restaurantId, stage: 'intake', status: 'error', message: `Fatal: ${message}` });
    summary.errors++;
  } finally {
    await context.close();
  }

  return summary;
}
