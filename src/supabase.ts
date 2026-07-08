import { config } from './config.js';
import { logger } from './logger.js';

export interface Restaurant {
  id: string;
  name: string;
  rd_email: string;
  rd_password: string | null;
  rd_store_number: string | number | null;
  drive_folder_id: string;
}

type SupabaseMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Builds a PostgREST filter value, e.g. pgFilter('eq', id) → 'eq.<url-encoded id>'.
 * Callers compose the full query string: `?drive_file_id=${pgFilter('eq', driveFileId)}`.
 */
export function pgFilter(op: string, value: string | number | boolean): string {
  return `${op}.${encodeURIComponent(String(value))}`;
}

async function supabaseRequest<T = unknown>(
  method: SupabaseMethod,
  table: string,
  body: object | null = null,
  params = ''
): Promise<T> {
  const endpoint = `${config.supabaseUrl}/rest/v1/${table}${params}`;
  const res = await fetch(endpoint, {
    method,
    headers: {
      apikey: config.supabaseServiceKey,
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${table} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function fetchActiveRestaurants(): Promise<Restaurant[]> {
  return supabaseRequest<Restaurant[]>('GET', 'restaurants', null, '?is_active=eq.true&order=created_at');
}

/**
 * Read-only GET escape hatch for one-off audit/diagnostic scripts (e.g.
 * scripts/check-supabase-state.ts). Deliberately narrower than supabaseRequest —
 * no method parameter, so a diagnostic script can't accidentally write.
 */
export async function supabaseGet<T = unknown>(table: string, params = ''): Promise<T> {
  return supabaseRequest<T>('GET', table, null, params);
}

/**
 * DELETE escape hatch for deliberate one-off cleanup scripts only — never
 * used by the normal scrape flow. Requires a non-empty filter starting with
 * '?': PostgREST DELETE with no filter deletes every row in the table, so
 * this throws rather than silently allowing that.
 */
export async function supabaseDelete(table: string, params: string): Promise<void> {
  if (!params || !params.startsWith('?')) {
    throw new Error('supabaseDelete requires an explicit filter (e.g. "?id=eq.<uuid>") — refusing to delete without one.');
  }
  await supabaseRequest('DELETE', table, null, params);
}

/**
 * Exact row count for a filtered query via PostgREST's Prefer: count=exact,
 * without pulling the matching rows themselves (Range: 0-0 caps the body at
 * one row). Avoids the default ~1000-row page cap undercounting large tables.
 * Parses the Content-Range response header, e.g. "0-0/774" → 774.
 */
export async function supabaseCount(table: string, params = ''): Promise<number> {
  const endpoint = `${config.supabaseUrl}/rest/v1/${table}${params}`;
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      apikey: config.supabaseServiceKey,
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase COUNT ${table} → ${res.status}: ${text}`);
  }
  const contentRange = res.headers.get('content-range');
  if (!contentRange) throw new Error(`Supabase COUNT ${table}: response had no Content-Range header`);
  const total = contentRange.split('/')[1];
  const count = total === undefined ? NaN : parseInt(total, 10);
  if (Number.isNaN(count)) {
    throw new Error(`Supabase COUNT ${table}: could not parse Content-Range "${contentRange}"`);
  }
  return count;
}

export interface InvoiceFileInput {
  restaurant_id: string;
  drive_file_id: string;
  filename: string;
  file_date: string | null;
  file_total: number | null;
  status: string;
}

/**
 * Never throws — mirrors the reference actor, which swallows insert errors
 * (including the drive_file_id UNIQUE conflict, our second dedup layer) and
 * lets the row continue processing with a null file id.
 */
export async function insertInvoiceFile(input: InvoiceFileInput): Promise<{ id: string | null }> {
  if (config.dryRun) {
    logger.info('[dry-run] would insert invoice_files', { filename: input.filename });
    return { id: null };
  }
  try {
    const [row] = await supabaseRequest<Array<{ id: string }>>('POST', 'invoice_files', input);
    logger.info('Queued in Supabase', { invoiceFileId: row?.id ?? null, filename: input.filename });
    return { id: row?.id ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('23505') || message.includes('duplicate')) {
      logger.info('Supabase: file already registered (conflict) — skipping duplicate insert', {
        filename: input.filename,
      });
    } else {
      logger.warn('Could not register file in Supabase', { filename: input.filename, error: message });
    }
    return { id: null };
  }
}

export interface InvoiceHeaderInput {
  restaurant_id: string;
  file_id: string | null;
  invoice_number: string | null;
  invoice_date: string;
  vendor: string;
  total: number;
}

export async function insertInvoiceHeader(input: InvoiceHeaderInput): Promise<{ id: string | null }> {
  if (config.dryRun) {
    logger.info('[dry-run] would insert invoice_headers', { invoiceNumber: input.invoice_number });
    return { id: null };
  }
  const [row] = await supabaseRequest<Array<{ id: string }>>('POST', 'invoice_headers', input);
  return { id: row?.id ?? null };
}

export interface InvoiceLineInput {
  header_id: string;
  restaurant_id: string;
  invoice_date: string;
  item_name: string;
  category: string;
  unit_qty: number;
  case_qty: number;
  unit_price: number;
  total: number;
}

export async function insertInvoiceLine(input: InvoiceLineInput): Promise<void> {
  if (config.dryRun) {
    logger.debug('[dry-run] would insert invoice_lines', { itemName: input.item_name });
    return;
  }
  await supabaseRequest('POST', 'invoice_lines', input);
}

export interface ProcessingLogInput {
  fileId?: string | null;
  restaurantId: string;
  stage: string;
  status: string;
  message?: string;
}

/** Never throws — log failures must not kill the main flow. */
export async function logProcessing(input: ProcessingLogInput): Promise<void> {
  if (config.dryRun) {
    logger.debug('[dry-run] would insert processing_logs', { stage: input.stage, status: input.status });
    return;
  }
  try {
    await supabaseRequest('POST', 'processing_logs', {
      file_id: input.fileId ?? null,
      restaurant_id: input.restaurantId,
      stage: input.stage,
      status: input.status,
      message: input.message?.substring(0, 1000) ?? null,
    });
  } catch (err) {
    logger.warn('Could not write to processing_logs', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
