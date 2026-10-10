import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';
type Check = { provider: string; message: string; ok: boolean };
export function VerificationPanel() {
  const [status, setStatus] = useState<{
    mcdConfigured: boolean;
    deepseekConfigured: boolean;
    providerAccessEnabled: boolean;
    csrfToken?: string;
    credentialMode?: string;
  } | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [facts, setFacts] = useState<Record<string, unknown> | null>(null);
  async function refresh() {
    try {
      setStatus(await api('/owner/setup/status'));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function verify(provider: 'mcd' | 'deepseek') {
    setBusy(provider);
    setError('');
    try {
      const s = await api<{ csrfToken?: string; credentialMode?: string }>('/owner/setup/status');
      const localFile = s.credentialMode === 'local-file';
      if (!localFile && !s.csrfToken) throw new Error('连接已过期，请重新连接。');
      const r = await fetch(localFile ? '/api/providers/verify' : '/api/owner/setup/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(!localFile && s.csrfToken ? { 'X-CSRF-Token': s.csrfToken } : {}),
        },
        body: JSON.stringify({ provider, ...(provider === 'deepseek' ? { aiConsent: true } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || '验证未完成');
      setChecks((c) => [
        ...c,
        {
          provider,
          message: provider === 'deepseek' ? 'AI 服务连接成功' : `麦当劳连接成功`,
          ok: true,
        },
      ]);
      await refresh();
    } catch (e) {
      setChecks((c) => [...c, { provider, message: (e as Error).message, ok: false }]);
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function read(path: string) {
    setBusy(path);
    setError('');
    try {
      const r = await api<Record<string, unknown>>(path);
      setFacts(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <main className="owner-setup verification">
      <a href="/" className="text-button">
        <Icon name="back" /> 返回麦搭
      </a>
      <h1>连接检查</h1>
      <p className="lede">检查麦当劳和 AI 服务是否可用。</p>
      <div className="setup-status">
        <div>
          <span>麦当劳账户</span>
          <b>{status?.mcdConfigured ? '已配置' : '未配置'}</b>
        </div>
        <div>
          <span>AI 服务</span>
          <b>{status?.deepseekConfigured ? '已配置' : '未配置'}</b>
        </div>
        <div>
          <span>服务状态</span>
          <b>{status?.providerAccessEnabled ? '已启用' : '未启用'}</b>
        </div>
      </div>
      <div className="verify-buttons">
        <button
          className="button primary"
          disabled={!!busy || !status?.deepseekConfigured}
          onClick={() => void verify('deepseek')}
        >
          {busy === 'deepseek' ? '验证中…' : '检查 AI 连接'}
        </button>
        <button
          className="button secondary"
          disabled={!!busy || !status?.mcdConfigured}
          onClick={() => void verify('mcd')}
        >
          {busy === 'mcd' ? '验证中…' : '检查麦当劳连接'}
        </button>
        <button
          className="button secondary"
          disabled={!!busy || !status?.mcdConfigured}
          onClick={() => void read('/mcp/tools')}
        >
          查看可用功能
        </button>
        <button
          className="button secondary"
          disabled={!!busy || !status?.mcdConfigured}
          onClick={() => void read('/nutrition')}
        >
          查看营养数据
        </button>
        <button className="text-button" disabled={!!busy} onClick={() => void refresh()}>
          刷新状态
        </button>
      </div>
      <div className="verification-results" role="status">
        {checks.map((c, i) => (
          <p key={i}>
            {c.ok ? '成功' : '未完成'} · {c.message}
          </p>
        ))}
      </div>
      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}
      {facts && (
        <details open>
          <summary>查询结果</summary>
          <pre className="verified-facts">{JSON.stringify(facts, null, 2)}</pre>
        </details>
      )}
    </main>
  );
}
