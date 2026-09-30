import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './collector-actions-menu.css';

const menuWidth = 152;
const menuHeight = 164;

export function CollectorActionsMenu({ busy, enabled, onView, onDiagnostics, onToggle, onDelete }) {
  const [position, setPosition] = useState(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const open = position !== null;

  useEffect(() => {
    if (!open) return;
    const closeOutside = event => {
      if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setPosition(null);
    };
    const closeOnEscape = event => {
      if (event.key === 'Escape') { event.stopPropagation(); setPosition(null); trigger.current?.focus(); }
    };
    const closeOnScroll = () => setPosition(null);
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnScroll);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnScroll);
    };
  }, [open]);

  function toggle() {
    if (open) { setPosition(null); return; }
    const rect = trigger.current.getBoundingClientRect();
    setPosition({
      left: Math.min(Math.max(8, rect.right - menuWidth), window.innerWidth - menuWidth - 8),
      top: rect.bottom + menuHeight + 8 > window.innerHeight ? rect.top - menuHeight - 6 : rect.bottom + 6,
    });
  }
  function choose(action) { setPosition(null); action(); }

  return <>
    <button ref={trigger} type="button" className="collector-menu-trigger" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>更多<span aria-hidden="true">⌄</span></button>
    {open ? createPortal(<div ref={menu} role="menu" aria-label="采集端操作" className="collector-actions-popover" style={position}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => choose(onView)}>查看信息</button>
      <button type="button" role="menuitem" onClick={() => choose(onDiagnostics)}>排障日志</button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => choose(onToggle)}>{enabled ? '停用' : '启用'}</button>
      <button type="button" role="menuitem" disabled={busy} className="danger-action" onClick={() => choose(onDelete)}>删除</button>
    </div>, document.body) : null}
  </>;
}
