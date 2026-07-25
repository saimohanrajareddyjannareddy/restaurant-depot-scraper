// Category detection for invoice line items.
//
// Restaurant Depot item names carry consistent prefixes we can map to
// categories. Rules are evaluated top-to-bottom, FIRST MATCH WINS — order
// matters (credits/returns must be caught before proteins/dairy etc).
//
// Ported from the Mise dashboard's lib/categorize.ts so the scraper tags
// categories at parse time instead of writing everything as 'Other'. Keep the
// two copies in sync when rules change.
export function categorize(itemName: string): string {
  const n = itemName.toUpperCase().trim();

  // Data-quality leaks first (should have been filtered by parser)
  if (/^(SUB[-\s]?TOTAL|TAX|TOTAL|BALANCE|AMEX|VISA|MASTERCARD)/i.test(n)) return 'Credits';

  // Credits/coupons/returns
  if (/^\(?COUPON\)?/i.test(n)) return 'Credits';
  if (/RETURN$|\bMLK CRTEDPST|CRTEDPST/i.test(n)) return 'Credits';

  // Proteins (added SHR\s, SHRP variants)
  if (/^(CHIX|CHKN|LAMB|BEEF|PORK|TILAPIA|SHR[MP]|SHR\s|SHRP|GOAT|CHEV|TURKEY|SEAFOOD|BATTER TEMPURA)/i.test(n)) return 'Proteins';

  // Dairy (added SOUR CREAM, BTR, UNSLTD, FC EGG)
  // "MILK COCONUT" is a Dry Goods pantry item, not dairy — the negative
  // lookahead keeps it falling through to the Dry Goods rule below.
  if (/^(MILK(?!\s*COCONUT)|CREAM|CHS|YOG|BUTTER|BTR|PANEER|EGG|SOUR CREAM|UNSLTD|FC EGG)/i.test(n)) return 'Dairy';
  if (/^CQ EVAP MILK/i.test(n)) return 'Dairy';

  // Produce (added FZ frozen veg — frozen veg counts as produce for cost tracking)
  if (/^(PROD|PD\s|FRUIT|VEG|HERB|BROCCOLI)/i.test(n)) return 'Produce';
  if (/^FZ\s+(PEAS|MIXED VEG|CUT GREEN|WHL GREEN|SPINACH|CORN|OKRA|CAULI|BROCC|GARLIC|ONION)/i.test(n)) return 'Produce';

  // Beverages
  if (/^(PURE\s?LIFE|WATER|JUICE|COKE|SPRITE|BIB|LEMONADE|SODA)/i.test(n)) return 'Beverages';
  if (/^(REALEMON|CALDO|APPLE JUICE)/i.test(n)) return 'Beverages';

  // Packaging (added FILM antibacterial food film)
  if (/^(CONT|CUP|LID|FOIL|BAG|LINER|PP\s|TOWEL|NAPKIN|WRAP|STRAW|PLASTIC)/i.test(n)) return 'Packaging';

  // Cleaning (added PALMOLIVE, BLEACH, FORMULA 409, GLOVE, FILM ANTIB)
  if (/^(SANI|CLEAN|PINE|SOAP|CHARMIN|FW\s|DEGREAS|SIMPLE|FRYER BOIL)/i.test(n)) return 'Cleaning';
  if (/^(PALMOLIVE|BLEACH|FORMULA\s?\d|\*?GLOVE|FILM.*ANTIB|AEROSOL(?! VANILLA))/i.test(n)) return 'Cleaning';

  // Dry Goods — expanded with bread, honey, canned, batter, aerosol vanilla, FZ prepared
  if (/^(OIL|FLOUR|SUGAR|RICE|BASMATI|SP\s|SALT|BEAN|PUREE|SAUCE|VINEGAR|STARCH|TOMATO CQ|TOM WHL|KETCHUP|OELEK|SAMBAL|MILK COCONUT)/i.test(n)) return 'Dry Goods';
  if (/^(BRD|BREAD|BAKING|HONEY|PC SUGAR|AEROSOL VANILLA|CORN FANCY|FZ.*(PESTO|CAKE|BATTER))/i.test(n)) return 'Dry Goods';

  return 'Other';
}
