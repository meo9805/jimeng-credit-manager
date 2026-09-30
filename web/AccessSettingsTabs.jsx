import './access-settings.css';

const sections = [
  { id: 'employees', label: '员工接入' },
  { id: 'data', label: '数据与更新' },
  { id: 'admin', label: '管理员' },
];

export function AccessSettingsTabs({ value, onChange, pendingCount = 0 }) {
  function navigate(event) {
    const current = sections.findIndex(section => section.id === value);
    const next = event.key === 'ArrowRight' ? (current + 1) % sections.length
      : event.key === 'ArrowLeft' ? (current - 1 + sections.length) % sections.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(sections[next].id);
    document.getElementById(`access-tab-${sections[next].id}`)?.focus();
  }
  return <div className="access-settings-tabs" role="tablist" aria-label="接入设置" onKeyDown={navigate}>
    {sections.map(section => <button
      key={section.id}
      id={`access-tab-${section.id}`}
      type="button"
      role="tab"
      aria-selected={value === section.id}
      tabIndex={value === section.id ? 0 : -1}
      className={value === section.id ? 'active' : ''}
      onClick={() => onChange(section.id)}
    >{section.label}{section.id === 'employees' && pendingCount > 0 ? <span className="access-settings-count">{pendingCount}</span> : null}</button>)}
  </div>;
}
