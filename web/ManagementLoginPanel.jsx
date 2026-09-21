import { useState } from 'react';
import Button from '@douyinfe/semi-ui/lib/es/button';
import Input from '@douyinfe/semi-ui/lib/es/input';

export function ManagementLoginPanel({ configured, busy, onSave }) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); if (busy) return;
    if ([...password].length < 8) { setError('登录密码至少 8 个字符'); return; }
    if (password !== confirmation) { setError('两次输入的密码不一致'); return; }
    try { await onSave(password); setPassword(''); setConfirmation(''); setError(''); setEditing(false); } catch {}
  }
  return <section className="panel management-login-panel"><div className="panel-title"><div className="inline-title"><h2>管理台登录</h2><span className="count-chip">{configured ? '已设置密码' : '尚未设置密码'}</span></div>{!editing ? <Button disabled={busy} onClick={() => setEditing(true)}>{configured ? '修改登录密码' : '设置登录密码'}</Button> : null}</div>
    {editing ? <form className="directory-form" onSubmit={submit}><div className="directory-form-fields"><label><span>登录密码</span><Input aria-label="新的管理登录密码" type="password" autoComplete="new-password" maxLength={128} value={password} disabled={busy} onChange={value => { setPassword(value); setError(''); }} /></label><label><span>确认密码</span><Input aria-label="确认管理登录密码" type="password" autoComplete="new-password" maxLength={128} value={confirmation} disabled={busy} onChange={value => { setConfirmation(value); setError(''); }} /></label></div>{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="form-actions"><Button disabled={busy} onClick={() => { setEditing(false); setPassword(''); setConfirmation(''); setError(''); }}>取消</Button><Button theme="solid" htmlType="submit" disabled={busy || !password || !confirmation}>保存登录密码</Button></div></form> : null}
  </section>;
}
