import { useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button';
import { ledgerPage } from './ledger-pagination.js';
import './ledger-pagination.css';

export function useLedgerPagination(rows, resetKey) {
  const [selection,setSelection]=useState({key:resetKey,page:1});
  const result=ledgerPage(rows,selection.key===resetKey?selection.page:1);
  if(selection.key!==resetKey||selection.page!==result.page)setSelection({key:resetKey,page:result.page});
  return {...result,onPage:page=>setSelection({key:resetKey,page})};
}

export function LedgerPagination({pagination,label='流水分页'}) {
  const {total,page,pageCount,from,to,onPage}=pagination;
  return <div className="table-footer ledger-pagination"><span>{total?`${from}–${to} 条 · 共 ${total} 条记录`:'共 0 条记录'}</span>{pageCount>1?<nav className="ledger-pagination-controls" aria-label={label}><Button size="small" disabled={page===1} onClick={()=>onPage(page-1)}>上一页</Button><span aria-live="polite">{page} / {pageCount}</span><Button size="small" disabled={page===pageCount} onClick={()=>onPage(page+1)}>下一页</Button></nav>:null}</div>;
}
