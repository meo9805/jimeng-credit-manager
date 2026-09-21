export const LEDGER_PAGE_SIZE = 50;

export function ledgerPage(rows, requestedPage = 1) {
  const total=rows.length,pageCount=Math.max(1,Math.ceil(total/LEDGER_PAGE_SIZE));
  const page=Math.max(1,Math.min(pageCount,Number.isInteger(requestedPage)?requestedPage:1));
  const offset=(page-1)*LEDGER_PAGE_SIZE;
  return {items:rows.slice(offset,offset+LEDGER_PAGE_SIZE),total,page,pageCount,from:total?offset+1:0,to:Math.min(total,offset+LEDGER_PAGE_SIZE)};
}
