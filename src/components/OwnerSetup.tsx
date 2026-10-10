import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
type Setup = {
  enabled: boolean;
  credentialMode?: string;
  csrfToken?: string;
  mcdConfigured: boolean;
  deepseekConfigured: boolean;
};
export function OwnerSetup({ onConnected }: { onConnected?: () => void }) {
  const [status, setStatus] = useState<Setup | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const next = await api<Setup>('/owner/setup/status');
    setStatus(next);
    return next;
  }
  useEffect(() => {
    void refresh().catch((e) => setMessage(e.message));
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!status?.enabled || busy) return;
    const form = e.currentTarget;
    const body = { mcdToken: String(new FormData(form).get('mcdToken') || '').trim() };
    form.reset();
    setBusy(true);
    setMessage('');
    try {
      await refresh();
      await api('/owner/setup', body);
      if (onConnected) onConnected();
      else window.location.assign('/plan');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      body.mcdToken = '';
      setBusy(false);
    }
  }
  return (
    <main className="owner-setup">
      <a href="/" className="text-button">
        <Icon name="back" /> 返回麦搭首页
      </a>
      <div className="owner-lock">
        <Icon name="lock" size={30} />
      </div>
      <h1>连接麦当劳账户</h1>
      <p className="micro">麦搭 · 非官方用餐助手</p>
      {status?.credentialMode === 'local-file' ? (
        <>
          <p className="lede">已连接，可以开始选餐了。</p>
          <a className="button primary full-width" href="/plan">
            开始选餐 <Icon name="arrow" />
          </a>
        </>
      ) : (
        <>
          <p className="lede">登录麦当劳 MCP，复制 Token 后粘贴到这里。</p>
          <a
            className="button secondary full-width"
            href="https://open.mcd.cn/mcp"
            target="_blank"
            rel="noopener noreferrer"
          >
            去麦当劳 MCP 登录 <Icon name="link" size={16} />
          </a>
          {status?.mcdConfigured && (
            <a className="button primary full-width connection-continue" href="/plan">
              继续搭配 <Icon name="arrow" size={16} />
            </a>
          )}
          <form onSubmit={submit} autoComplete="off">
            <label>
              麦当劳 MCP Token
              <input
                type="password"
                name="mcdToken"
                autoComplete="off"
                spellCheck={false}
                required
                minLength={8}
                maxLength={8192}
                placeholder="粘贴你的 Token"
                disabled={!status?.enabled || busy}
              />
            </label>
            <p className="micro">Token 仅用于你的账户，30 分钟未操作后需重新连接。</p>
            <button className="button primary full-width" disabled={!status?.enabled || busy}>
              {busy ? '正在连接…' : '连接并开始'} <Icon name="arrow" size={16} />
            </button>
          </form>
          {status && !status.enabled && (
            <p className="error-note" role="alert">
              连接入口暂未开放，请稍后再试。
            </p>
          )}
        </>
      )}
      {message && (
        <p className="error-note" role="alert">
          {message}
        </p>
      )}
    </main>
  );
}
