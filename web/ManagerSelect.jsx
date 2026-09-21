import { Children, isValidElement, useId } from 'react';
import Select from '@douyinfe/semi-ui/lib/es/select';
import './manager-select.css';

// One styled, keyboard-accessible control for filters and directory fields.
// Existing option declarations are converted to Semi options, never rendered
// as browser-native select elements.
export function ManagerSelect({ label, value, onChange, children, options, searchable = false, disabled = false, required = false, id, className = '', prefix }) {
  const labelId = useId();
  const optionList = options || Children.toArray(children).filter(isValidElement).map(option => ({ value: option.props.value, label: Children.toArray(option.props.children).join(''), disabled: option.props.disabled }));
  return <span className={`manager-select-field ${className}`}>
    <span className="sr-only" id={labelId}>{label}</span>
    <Select id={id} aria-labelledby={labelId} aria-required={required} className="manager-select" value={value} onChange={onChange} optionList={optionList} disabled={disabled} filter={searchable} searchPosition="dropdown" searchPlaceholder={`搜索${label}`} inputProps={{ 'aria-label': `搜索${label}` }} prefix={prefix ? <span className="manager-select-prefix">{prefix}</span> : undefined} emptyContent="没有匹配项" dropdownClassName="manager-select-menu" dropdownMatchSelectWidth={false} maxHeight={280} zIndex={1300} />
  </span>;
}
