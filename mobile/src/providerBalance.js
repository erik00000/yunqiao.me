/** Render only normalized gateway results; API credentials stay on the computer. */
export function providerBalanceView(provider, rpc, isCurrent) {
  const create = (tag, cls, text) => {
    const node = document.createElement(tag);
    node.className = cls || '';
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const host = create('section', 'provider-balance');
  host.setAttribute('aria-label', `${provider.name} 余额与额度`);
  const heading = create('div', 'provider-balance-heading');
  const refresh = create('button', 'toggle', '刷新余额');
  refresh.type = 'button';
  refresh.setAttribute('aria-label', `刷新 ${provider.name} 余额`);
  const content = create('div', 'provider-balance-content');
  heading.append(create('strong', '', '余额与额度'), refresh);
  host.append(heading, content);
  let loading = false, result;
  const amount = (value, currency) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const digits = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
    const unit = currency === 'POINTS' ? '额度点数' : currency === 'UNKNOWN' || !currency ? '单位未提供' : currency;
    return `${digits} ${unit}`;
  };
  const time = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '时间未知';
  };
  function show(message = '') {
    content.replaceChildren();
    for (const item of result?.items || []) {
      const row = create('div', 'provider-balance-key');
      row.append(create('span', 'muted small-text', item.keyLabel || '当前密钥'));
      for (const entry of item.entries || []) {
        const line = create('div', 'provider-balance-entry');
        const scope = { account: '账户余额', key: '密钥额度', subscription: '套餐额度' }[entry.scope] || '余额';
        line.append(create('span', 'muted small-text', `${scope}${entry.label ? ` · ${entry.label}` : ''}`));
        line.append(create('strong', '', entry.unlimited ? '不限额' : amount(entry.remaining, entry.currency)));
        if (typeof entry.used === 'number' || typeof entry.total === 'number') line.append(create('small', 'muted', `已用 ${amount(entry.used, entry.currency)} / 总额 ${amount(entry.total, entry.currency)}`));
        row.append(line);
      }
      if (item.updatedAt) row.append(create('small', 'muted', `${item.stale || message ? '上次成功' : '更新时间'} ${time(item.updatedAt)}`));
      if (item.message) row.append(create('p', item.status === 'error' ? 'error-text' : 'muted small-text', item.message));
      if (!item.entries?.length && !item.message) row.append(create('p', 'muted small-text', '余额暂未提供'));
      content.append(row);
    }
    if (result?.message) content.append(create('p', 'muted small-text', result.message));
    if (message) {
      const error = create('p', 'error-text', message);
      error.setAttribute('role', 'alert');
      content.append(error);
    }
    if (!result?.items?.length && !result?.message && !message) content.append(create('p', 'muted small-text', '正在读取…'));
  }
  async function load(force = false) {
    if (loading || !provider.enabled || !isCurrent()) return;
    loading = true; refresh.disabled = true; refresh.textContent = '查询中…'; host.setAttribute('aria-busy', 'true');
    try {
      const next = await rpc('provider.balance', { providerId: provider.id, force });
      if (!isCurrent() || !host.isConnected) return;
      if (!next || next.providerId !== provider.id || !Array.isArray(next.items)
        || next.items.some(item => !item || !Array.isArray(item.entries) || item.entries.some(entry => !entry || typeof entry !== 'object'))) throw new Error('invalid');
      result = next; show();
    } catch {
      if (isCurrent() && host.isConnected) show('余额刷新失败，请检查连接及电脑端版本；已有数值保留为上次结果。');
    } finally {
      loading = false; refresh.disabled = !provider.enabled; refresh.textContent = '刷新余额'; host.removeAttribute('aria-busy');
    }
  }
  refresh.addEventListener('click', () => { void load(true); });
  if (provider.enabled) {
    show();
    queueMicrotask(() => { if (!document.hidden && host.isConnected) void load(); });
  } else {
    refresh.disabled = true;
    content.append(create('p', 'muted small-text', '供应商已停用，不查询余额'));
  }
  return host;
}
