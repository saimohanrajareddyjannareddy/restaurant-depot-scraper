import { Actor } from 'apify';
import { chromium } from 'playwright';
import { google } from 'googleapis';
import fs from 'fs';
import XLSX from 'xlsx';

// ─── Helpers ────────────────────────────────────────────────────────────────

let stepNum = 1;

async function screenshot(page, name) {
    const filePath = `/tmp/step${stepNum++}_${name}.png`;
    try {
        await page.screenshot({ path: filePath, fullPage: true });
        console.log(`📸 Screenshot: ${filePath}`);
    } catch (err) {
        console.warn(`Could not take screenshot "${name}": ${err.message}`);
    }
    return filePath;
}

/**
 * Try each selector in order, return the first visible element found.
 */
async function findElement(page, selectors, timeout = 5000) {
    for (const selector of selectors) {
        try {
            const el = await page.waitForSelector(selector, { timeout, state: 'visible' });
            if (el) {
                console.log(`  ✓ Found element: ${selector}`);
                return el;
            }
        } catch {
            console.log(`  ✗ Not found: ${selector}`);
        }
    }
    return null;
}

/**
 * Find an element scoped inside a row handle.
 */
async function findInRow(rowHandle, selectors) {
    for (const selector of selectors) {
        try {
            const el = await rowHandle.$(selector);
            if (el) {
                console.log(`  ✓ Row element: ${selector}`);
                return el;
            }
        } catch {
            console.log(`  ✗ Row selector not found: ${selector}`);
        }
    }
    return null;
}

/** Format any date string to YYYY-MM-DD */
function formatDate(rawDate) {
    try {
        const d = new Date(rawDate);
        if (!isNaN(d)) return d.toISOString().split('T')[0];
    } catch {
        // fall through
    }
    // Try MM/DD/YYYY manually
    const m = rawDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return rawDate.replace(/\//g, '-');
}

/**
 * Strip $ and commas, replace ALL dots with hyphens for filename safety.
 * e.g. '$1,665.64' → '1665-64'
 */
function totalToFilenameSegment(totalStr) {
    return totalStr.replace(/[$,\s]/g, '').replace(/\./g, '-');
}

/**
 * Reverse of totalToFilenameSegment — parse dollar total from filename.
 * e.g. 'RestaurantDepot_2026-02-17_$1665-64.xlsx' → 1665.64
 */
function parseFilenameTotal(filename) {
    const m = filename.match(/\$(\d+)-(\d{2})\.xlsx$/);
    if (m) return parseFloat(`${m[1]}.${m[2]}`);
    return null;
}

/**
 * Parse date from filename.
 * e.g. 'RestaurantDepot_2026-02-17_$1665-64.xlsx' → '2026-02-17'
 */
function parseFilenameDate(filename) {
    const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}

// ─── Google Drive Upload ─────────────────────────────────────────────────────

/**
 * Accept a pre-built drive client instead of creating OAuth2Client per file.
 * One drive client per restaurant, reused across all uploads for that client.
 */
async function uploadToGoogleDrive(drive, localPath, fileName, folderId) {
    const stat = fs.statSync(localPath);
    if (stat.size === 0) {
        throw new Error(`Downloaded file is empty (0 bytes): ${localPath}`);
    }

    const response = await drive.files.create({
        requestBody: {
            name: fileName,
            parents: [folderId],
        },
        media: {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            body: fs.createReadStream(localPath),
        },
        fields: 'id, webViewLink, name',
    });

    return response.data; // { id, webViewLink, name }
}

/**
 * Retry wrapper — retries async fn up to maxAttempts times with exponential backoff.
 */
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 2000) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts) {
                const delay = baseDelayMs * attempt;
                console.warn(`  ⚠ Attempt ${attempt}/${maxAttempts} failed: ${err.message}. Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

/**
 * Check if a file with the given name already exists in the Drive folder.
 * First line of dedup defense — avoids re-downloading and re-uploading.
 */
async function fileExistsInDrive(drive, fileName, folderId) {
    const res = await drive.files.list({
        q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id, name)',
        spaces: 'drive',
    });
    return res.data.files.length > 0;
}

// ─── Supabase REST helpers ────────────────────────────────────────────────────

/**
 * Minimal Supabase REST client (no SDK needed — uses native fetch).
 * method: 'GET' | 'POST' | 'PATCH'
 * params: query string including leading '?' (optional)
 */
async function supabaseRequest(url, key, method, table, body = null, params = '') {
    const endpoint = `${url}/rest/v1/${table}${params}`;
    const res = await fetch(endpoint, {
        method,
        headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${method} ${table} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
}

/**
 * Log a processing event to the processing_logs table.
 * Never throws — log failures must not kill the main flow.
 */
async function logToSupabase(sbUrl, sbKey, { fileId, restaurantId, stage, status, message }) {
    try {
        await supabaseRequest(sbUrl, sbKey, 'POST', 'processing_logs', {
            file_id:       fileId ?? null,
            restaurant_id: restaurantId,
            stage,
            status,
            message: message?.substring(0, 1000), // guard against huge error messages
        });
    } catch (err) {
        console.warn(`  ⚠ Could not write to processing_logs: ${err.message}`);
    }
}

// ─── Excel parser ────────────────────────────────────────────────────────────

function parseInvoiceExcel(localPath) {
    try {
        const workbook = XLSX.readFile(localPath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        console.log(`  Excel: ${rawRows.length} rows. First 4:`, JSON.stringify(rawRows.slice(0, 4)));

        // Find the header row (contains qty/price/description keywords)
        let headerRowIdx = 0;
        for (let i = 0; i < Math.min(20, rawRows.length); i++) {
            const lower = rawRows[i].map(c => String(c).toLowerCase()).join(' ');
            if (/qty|quantity|price|desc|item|product/.test(lower)) {
                headerRowIdx = i;
                break;
            }
        }

        // Parse with auto-detected header
        const jsonRows = XLSX.utils.sheet_to_json(sheet, { range: headerRowIdx, defval: '' });
        console.log(`  Header row ${headerRowIdx}, columns: ${Object.keys(jsonRows[0] ?? {}).join(', ')}`);

        // Look for invoice/order number above the header
        let invoice_number = null;
        for (let i = 0; i < headerRowIdx; i++) {
            const m = rawRows[i].join(' ').match(/(?:invoice|order|receipt)[#\s:]*([A-Z0-9-]+)/i);
            if (m) { invoice_number = m[1]; break; }
        }

        const parseNum = (val) => {
            const n = parseFloat(String(val ?? '').replace(/[$,]/g, ''));
            return isNaN(n) ? 0 : n;
        };

        const items = [];
        for (const row of jsonRows) {
            const keys = Object.keys(row);
            const descKey  = keys.find(k => /desc|item|product|name/i.test(k));
            const qtyKey   = keys.find(k => /\bqty\b|quantity/i.test(k));
            const priceKey = keys.find(k => /unit.?price|price.?unit|\beach\b|unit.?cost/i.test(k));
            const totalKey = keys.find(k => /\btotal\b|extended|amount/i.test(k));

            const item_name = descKey ? String(row[descKey]).trim() : '';
            if (!item_name || /^(total|subtotal|tax|freight|discount)$/i.test(item_name)) continue;

            const unit_qty   = parseNum(row[qtyKey]);
            const unit_price = parseNum(row[priceKey]);
            const total      = parseNum(row[totalKey]) || unit_qty * unit_price;

            if (unit_price === 0 && total === 0) continue;

            items.push({ item_name, category: 'Other', unit_qty, case_qty: 0, unit_price, total });
        }

        return { invoice_number, items };
    } catch (err) {
        console.warn(`  ⚠ Excel parse failed: ${err.message}`);
        return null;
    }
}

// ─── Per-client processing ────────────────────────────────────────────────────

/**
 * Process one restaurant client inside a dedicated browser context.
 * Opens a fresh context, runs the full receipt download flow, closes context.
 *
 * drive — the shared central Drive client (YOUR OAuth credentials, built once in Actor.main)
 * Returns a per-client summary object.
 */
async function processClient(browser, client, drive, dateRange, sbUrl, sbKey, startDate = null, endDate = null) {
    const {
        id: restaurantId,
        name: restaurantName,
        rd_email: email,
        rd_password: passwordRaw,
        rd_store_number: storeNumber,
        drive_folder_id: googleDriveFolderId,
    } = client;

    const password = passwordRaw != null ? String(passwordRaw) : null;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  CLIENT: ${restaurantName} (id: ${restaurantId})`);
    console.log(`  Email: ${email}, Password set: ${password != null}`);
    console.log(`${'═'.repeat(60)}`);

    const summary = { restaurantId, restaurantName, uploaded: 0, duplicates: 0, skipped: 0, errors: 0 };

    // ── Open fresh browser context for this client ────────────────────────────
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.warn('[browser error]', msg.text());
    });

    try {
        // ── Step 1: Navigate to receipts (triggers Azure B2C login redirect) ──
        console.log('\n── Step 1: Navigating to member/receipts ──');
        await page.goto('https://www.restaurantdepot.com/member/receipts', {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });
        await page.waitForTimeout(2_000);
        await screenshot(page, `${restaurantName}_after_nav`);

        // ── Step 2: Handle Azure B2C login ───────────────────────────────────
        console.log('\n── Step 2: Handling login ──');
        const currentUrl = page.url();

        if (!currentUrl.includes('login.restaurantdepot.com') && !currentUrl.includes('b2c') && currentUrl.includes('receipts')) {
            console.log('Already logged in — skipping login flow');
        } else {
            console.log('Azure B2C login detected, URL:', currentUrl);
            await page.waitForTimeout(2_000);
            await screenshot(page, `${restaurantName}_login_page`);

            const allInputs = await page.$$eval('input', (els) =>
                els.map((el) => ({ type: el.type, name: el.name, id: el.id, placeholder: el.placeholder }))
            );
            console.log('Inputs found:', JSON.stringify(allInputs));

            // Fill email
            const emailField = await findElement(page, [
                'input[id="signInName"]',
                'input[id="email"]',
                'input[name="signInName"]',
                'input[name="email"]',
                'input[type="email"]',
                'input[placeholder*="email" i]',
                'input[autocomplete="email"]',
                'input[autocomplete="username"]',
            ]);
            if (!emailField) throw new Error('Could not find email input field on Azure B2C login page');
            await emailField.click();
            await emailField.fill(email);

            // Fill password
            const passwordField = await findElement(page, [
                'input[id="password"]',
                'input[name="password"]',
                'input[type="password"]',
            ]);
            if (!passwordField) throw new Error('Could not find password input field');
            if (!password) throw new Error(`rd_password is null for ${restaurantName} — update it in Supabase restaurants table`);
            await passwordField.click();
            await passwordField.fill(password);

            // Submit
            const submitBtn = await findElement(page, [
                'button[id="next"]',
                'button[id="continue"]',
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Sign in")',
                'button:has-text("Sign In")',
                'button:has-text("Login")',
                'button:has-text("Continue")',
                'button:has-text("Next")',
            ]);
            if (!submitBtn) throw new Error('Could not find submit button on Azure B2C login page');

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}),
                submitBtn.click(),
            ]);
            await page.waitForTimeout(2_000);
            await screenshot(page, `${restaurantName}_after_login`);

            const urlAfterLogin = page.url();
            console.log('URL after login:', urlAfterLogin);

            const errorEl = await page.$('#claimVerificationServerError, .alert-error').catch(() => null);
            if (errorEl) {
                const errText = (await errorEl.textContent())?.trim();
                if (errText) throw new Error(`Login error: ${errText}`);
            }

            if (urlAfterLogin.includes('login.restaurantdepot.com') || urlAfterLogin.includes('b2clogin')) {
                const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500));
                throw new Error(`Login failed — still on login page. Page text: ${pageText}`);
            }
        }

        // ── Step 3: Navigate to receipts ─────────────────────────────────────
        console.log('\n── Step 3: Navigating to receipts ──');
        await page.goto('https://www.restaurantdepot.com/member/receipts', {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });
        await screenshot(page, `${restaurantName}_receipts_page`);

        // ── Step 4: Set date range & click Request ────────────────────────────
        console.log('\n── Step 4: Setting date range ──');
        const selectEl = await page.$('select').catch(() => null);
        if (selectEl) {
            try {
                await page.selectOption('select', { label: dateRange });
                console.log(`Date range set to: "${dateRange}"`);
            } catch {
                try {
                    await page.selectOption('select', { index: 0 });
                    console.log('Fell back to first date range option');
                } catch {
                    console.warn('Could not set date range select');
                }
            }
        }

        // If using custom date range, fill start and end date fields
        if (dateRange === 'Request By Date Range' && startDate && endDate) {
            console.log(`  Filling date range: ${startDate} → ${endDate}`);
            await page.waitForTimeout(500);
            const startInput = await page.$('input[placeholder*="start" i], input[id*="start" i], input[name*="start" i]').catch(() => null)
                || await page.$('input[type="date"]:first-of-type').catch(() => null);
            const endInput = await page.$('input[placeholder*="end" i], input[id*="end" i], input[name*="end" i]').catch(() => null)
                || await page.$('input[type="date"]:last-of-type').catch(() => null);
            if (startInput) {
                await startInput.fill('');
                await startInput.type(startDate);
                console.log(`  Start date set: ${startDate}`);
            }
            if (endInput) {
                await endInput.fill('');
                await endInput.type(endDate);
                console.log(`  End date set: ${endDate}`);
            }
            await page.waitForTimeout(300);
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

        // ── Step 5: Parse rows ────────────────────────────────────────────────
        console.log('\n── Step 5: Collecting receipt rows ──');

        const rowSelectors = [
            'tr:has(a:has-text("Download Excel"))',
            'tr:has(button:has-text("Download Excel"))',
            'table tr',
            'table tbody tr',
            '[class*="receipt-row"]',
            '[class*="receiptRow"]',
            '[data-testid="receipt-row"]',
        ];
        let rows = [];
        for (const sel of rowSelectors) {
            rows = await page.$$(sel);
            if (rows.length > 0) {
                console.log(`Found ${rows.length} rows using: ${sel}`);
                break;
            }
        }

        if (rows.length === 0) {
            const preview = await page.evaluate(() => document.body.innerText.slice(0, 2000));
            console.warn('No receipt rows found. Page content preview:\n', preview);
            await logToSupabase(sbUrl, sbKey, { restaurantId, stage: 'intake', status: 'warning', message: 'No receipt rows found in table' });
            return summary;
        }

        // ── Step 6: Download & upload each receipt ────────────────────────────
        console.log(`\n── Step 6: Processing ${rows.length} receipts for ${restaurantName} ──`);

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            console.log(`\n  Receipt ${i + 1}/${rows.length}`);

            try {
                const cells = await row.$$('td');
                const cellTexts = await Promise.all(
                    cells.map((c) => c.textContent().then((t) => t?.trim() ?? ''))
                );
                console.log('  Cell values:', cellTexts);

                // Filter: only process receipts matching this client's store number
                const storeCell = cellTexts.find(t => t.match(/#\d+/));
                const targetStore = `#${storeNumber ?? '79'}`;
                if (!storeCell || !storeCell.includes(targetStore)) {
                    console.log(`  Skipping non-${targetStore} store: ${storeCell || 'unknown'}`);
                    summary.skipped++;
                    continue;
                }

                // Parse date and total from cells
                let receiptDate = new Date().toISOString().split('T')[0];
                let receiptTotal = '0-00';

                for (const text of cellTexts) {
                    const dateMatch = text.match(/\d{4}[\/\-]\d{2}[\/\-]\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/);
                    if (dateMatch) receiptDate = formatDate(dateMatch[0]);
                    const totalMatch = text.match(/\$[\d,]+\.\d{2}/);
                    if (totalMatch) receiptTotal = totalToFilenameSegment(totalMatch[0]);
                }

                const fileName = `RestaurantDepot_${receiptDate}_$${receiptTotal}.xlsx`;
                console.log(`  Target filename: ${fileName}`);

                // Dedup check 1: Drive filename (avoid re-downloading)
                const alreadyUploaded = await fileExistsInDrive(drive, fileName, googleDriveFolderId);
                if (alreadyUploaded) {
                    console.log(`  ⏭ Already in Drive — skipping: ${fileName}`);
                    summary.duplicates++;
                    continue;
                }

                // Find Download Excel button within this row
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

                if (!dlBtn) {
                    console.warn(`  No download button in row ${i + 1} — skipping`);
                    summary.skipped++;
                    continue;
                }

                const [download] = await Promise.all([
                    page.waitForEvent('download', { timeout: 30_000 }),
                    dlBtn.click(),
                ]);

                const localPath = `/tmp/${fileName}`;
                await download.saveAs(localPath);

                const stat = fs.statSync(localPath);
                if (stat.size === 0) {
                    throw new Error(`Downloaded file is empty (0 bytes) — site may have returned an error page`);
                }
                console.log(`  Saved locally: ${localPath} (${stat.size} bytes)`);

                // Upload to Google Drive with retry
                console.log(`  Uploading to Drive folder: ${googleDriveFolderId}`);
                const driveFile = await withRetry(() =>
                    uploadToGoogleDrive(drive, localPath, fileName, googleDriveFolderId)
                );
                console.log(`  ✅ Uploaded: ${driveFile.webViewLink}`);

                // Register in Supabase queue (dedup 2: drive_file_id UNIQUE will reject replay)
                let fileRecordId = null;
                try {
                    const [fileRecord] = await supabaseRequest(sbUrl, sbKey, 'POST', 'invoice_files', {
                        restaurant_id: restaurantId,
                        drive_file_id: driveFile.id,
                        filename:      fileName,
                        file_date:     parseFilenameDate(fileName),
                        file_total:    parseFilenameTotal(fileName),
                        status:        'pending',
                    });
                    fileRecordId = fileRecord?.id ?? null;
                    console.log(`  📥 Queued in Supabase: invoice_files.id = ${fileRecordId}`);
                } catch (sbErr) {
                    // Conflict (23505) means the drive_file_id was already recorded — safe to ignore
                    if (sbErr.message.includes('23505') || sbErr.message.includes('duplicate')) {
                        console.log(`  ℹ Supabase: file already registered (conflict) — skipping duplicate insert`);
                    } else {
                        console.warn(`  ⚠ Could not register file in Supabase: ${sbErr.message}`);
                    }
                }

                await logToSupabase(sbUrl, sbKey, {
                    fileId: fileRecordId,
                    restaurantId,
                    stage: 'intake',
                    status: 'success',
                    message: `Uploaded ${fileName} → Drive ID ${driveFile.id}`,
                });

                // Parse Excel and write invoice_headers + invoice_lines to Supabase
                try {
                    const parsed = parseInvoiceExcel(localPath);
                    if (parsed && parsed.items.length > 0) {
                        const [header] = await supabaseRequest(sbUrl, sbKey, 'POST', 'invoice_headers', {
                            restaurant_id:  restaurantId,
                            file_id:        fileRecordId,
                            invoice_number: parsed.invoice_number ?? fileName,
                            invoice_date:   receiptDate,
                            vendor:         'Restaurant Depot',
                            total:          parseFilenameTotal(fileName) ?? 0,
                        });
                        if (header?.id) {
                            for (const item of parsed.items) {
                                await supabaseRequest(sbUrl, sbKey, 'POST', 'invoice_lines', {
                                    header_id:     header.id,
                                    restaurant_id: restaurantId,
                                    invoice_date:  receiptDate,
                                    item_name:     item.item_name,
                                    category:      item.category,
                                    unit_qty:      item.unit_qty,
                                    case_qty:      item.case_qty,
                                    unit_price:    item.unit_price,
                                    total:         item.total,
                                });
                            }
                            console.log(`  📊 Inserted invoice header + ${parsed.items.length} line items`);
                        }
                    } else {
                        console.warn(`  ⚠ No line items parsed from Excel — skipping Supabase invoice insert`);
                    }
                } catch (parseErr) {
                    console.warn(`  ⚠ Invoice parse/insert failed: ${parseErr.message}`);
                }

                summary.uploaded++;

                await Actor.pushData({
                    restaurantId,
                    restaurantName,
                    status: 'success',
                    fileName,
                    receiptDate,
                    googleDriveFileId: driveFile.id,
                    googleDriveUrl: driveFile.webViewLink,
                    supabaseFileId: fileRecordId,
                });

                try { fs.unlinkSync(localPath); } catch { /* cleanup best-effort */ }

            } catch (rowErr) {
                summary.errors++;
                console.error(`  ❌ Error on row ${i + 1}:`, rowErr.message);
                await logToSupabase(sbUrl, sbKey, {
                    restaurantId,
                    stage: 'intake',
                    status: 'error',
                    message: `Row ${i + 1}: ${rowErr.message}`,
                });
                await Actor.pushData({ restaurantId, restaurantName, status: 'error', error: rowErr.message });
            }
        }

    } catch (clientErr) {
        await screenshot(page, `${restaurantName}_error`);
        console.error(`💥 Fatal error for ${restaurantName}:`, clientErr.message);
        await logToSupabase(sbUrl, sbKey, {
            restaurantId,
            stage: 'intake',
            status: 'error',
            message: `Fatal: ${clientErr.message}`,
        });
        summary.errors++;
    } finally {
        await context.close();
    }

    return summary;
}

// ─── Main ────────────────────────────────────────────────────────────────────

Actor.main(async () => {
    const input = await Actor.getInput();
    const {
        supabaseUrl,
        supabaseKey,
        googleOAuthClientId,
        googleOAuthClientSecret,
        googleOAuthRefreshToken,
        dateRange = 'Last 30 Days – On Demand',
        startDate = null,
        endDate = null,
    } = input ?? {};

    if (!supabaseUrl || !supabaseKey)
        throw new Error('Missing required input: supabaseUrl and supabaseKey');
    if (!googleOAuthClientId || !googleOAuthClientSecret || !googleOAuthRefreshToken)
        throw new Error('Missing required input: googleOAuthClientId, googleOAuthClientSecret, googleOAuthRefreshToken');

    // Build ONE central Drive client (YOUR account) — reused for all clients
    const oauth2Client = new google.auth.OAuth2(googleOAuthClientId, googleOAuthClientSecret);
    oauth2Client.setCredentials({ refresh_token: googleOAuthRefreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Verify Drive credentials before starting anything (fail fast)
    try {
        await drive.files.list({ pageSize: 1, fields: 'files(id)' });
        console.log('✅ Central Google Drive credentials verified');
    } catch (err) {
        throw new Error(`Drive credential check failed: ${err.message}. Verify the OAuth credentials in actor input.`);
    }

    // Load all active restaurants from Supabase
    console.log('📋 Loading active clients from Supabase...');
    const restaurants = await supabaseRequest(
        supabaseUrl, supabaseKey,
        'GET', 'restaurants',
        null,
        '?is_active=eq.true&order=created_at'
    );

    if (!restaurants || restaurants.length === 0) {
        console.log('No active restaurants found in Supabase. Nothing to do.');
        await Actor.setValue('RUN_SUMMARY', { clients: 0, message: 'No active restaurants in DB' });
        return;
    }

    console.log(`Found ${restaurants.length} active client(s): ${restaurants.map(r => r.name).join(', ')}\n`);

    // Launch one browser — reused across all clients via separate contexts
    console.log('🚀 Launching browser...');
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });

    const clientSummaries = [];

    for (const client of restaurants) {
        const summary = await processClient(browser, client, drive, dateRange, supabaseUrl, supabaseKey, startDate, endDate);
        clientSummaries.push(summary);
    }

    await browser.close();

    // Run-level summary
    const totals = clientSummaries.reduce(
        (acc, s) => ({
            clients: acc.clients + 1,
            uploaded: acc.uploaded + s.uploaded,
            duplicates: acc.duplicates + s.duplicates,
            skipped: acc.skipped + s.skipped,
            errors: acc.errors + s.errors,
        }),
        { clients: 0, uploaded: 0, duplicates: 0, skipped: 0, errors: 0 }
    );

    console.log(`\n✅ Run complete:`, JSON.stringify(totals));
    console.log('Per-client breakdown:');
    clientSummaries.forEach(s =>
        console.log(`  ${s.restaurantName}: ${s.uploaded} uploaded, ${s.duplicates} duplicates, ${s.skipped} skipped, ${s.errors} errors`)
    );

    await Actor.setValue('RUN_SUMMARY', { ...totals, clients_detail: clientSummaries });

    if (totals.errors > 0) {
        console.error(`⚠ ${totals.errors} total error(s) across all clients — check dataset for details`);
    }
});