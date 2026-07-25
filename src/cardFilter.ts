// Business-card filter for Restaurant Depot receipts.
//
// A restaurant's Restaurant Depot account can be used with more than one card,
// and the receipts page can surface purchases made on a card that doesn't
// belong to the client (a foreign card). When we know which cards belong to a
// restaurant, we keep only those; otherwise we keep everything.
//
// Pure logic only — no I/O, no config, no Supabase. Nothing wires this into the
// scraper yet; it exists so the rules can be tested in isolation first.
//
// Rules, in order:
//   1. no known cards configured        -> keep (filtering is off)
//   2. no card on the invoice           -> keep (cash / unreadable card field —
//                                          never drop a receipt for lack of a card)
//   3. invoice card is a known card     -> keep
//   4. invoice card is anything else    -> drop (foreign card)
//
// Card values are compared exactly as given (no trimming, no case folding) —
// they're short digit strings like '2063' in practice. If real data turns out to
// carry surrounding whitespace, normalize at the call site or revisit this.
export function shouldKeepInvoice(
  invoiceCard: string | null,
  knownCards: string[] | null,
): boolean {
  // 1. Filtering off when we have no card list for this restaurant.
  if (knownCards === null || knownCards.length === 0) return true;

  // 2. No card on the invoice — cash, or the field didn't parse. Keep it.
  if (invoiceCard === null || invoiceCard === '') return true;

  // 3 / 4. Keep only cards we recognize.
  return knownCards.includes(invoiceCard);
}
