import type { Case, SaleItem } from '../types';

/**
 * The line items a sale is made of.
 *
 * Multi-item sales store their lines in `sale_items`; a sale logged before that
 * existed has only the flat case fields, so it is presented as a single line.
 * Anything that breaks revenue down by brand or product type must go through
 * this rather than read `case.brand` — that field only ever names the first
 * item, so a watch-plus-strap basket would be credited entirely to the watch.
 *
 * Lives here, not in `db/`, so pure code such as the PDF builder can use it
 * without pulling in the Supabase client.
 */
export function getEffectiveItems(c: Case): SaleItem[] {
  if (c.saleItems && c.saleItems.length > 0) return c.saleItems;
  if (c.caseType !== 'Sale') return [];
  return [{
    brand: c.brand,
    productType: c.productType,
    product: c.product || undefined,
    quantity: 1,
    amountKD: c.amountKD ?? 0,
    sortOrder: 0,
  }];
}
