/** Balance data comes from the provider, independently of local token estimates. */
export type BalanceAdapter = 'auto' | 'disabled' | 'deepseek' | 'moonshot' | 'openrouter' | 'stepfun' | 'novita' | 'sub2api' | 'newapi' | 'custom';

export interface ProviderBalanceQuery {
  adapter: BalanceAdapter;
  /** Custom requests reuse a provider key unless a separate query token is selected. */
  auth?: 'api-key' | 'token' | 'none';
  token?: string;
  url?: string;
  method?: 'GET' | 'POST';
  authHeader?: string;
  authScheme?: 'bearer' | 'raw';
  headers?: Record<string, string>;
  /** Static JSON only; no executable scripts or credential interpolation. */
  body?: string;
  balancePath?: string;
  totalPath?: string;
  usedPath?: string;
  scope?: 'account' | 'key' | 'subscription';
  currency?: string;
  multiplier?: number;
}

export interface ProviderBalanceEntry {
  label: string;
  scope: 'account' | 'key' | 'subscription';
  currency: string;
  remaining?: number;
  total?: number;
  used?: number;
  unlimited?: boolean;
  resetsAt?: string;
}

export interface ProviderBalanceItem {
  keyId: string;
  keyLabel: string;
  status: 'ok' | 'error' | 'unsupported' | 'disabled' | 'unconfigured';
  entries: ProviderBalanceEntry[];
  /** Last successful response time; retained on a failed refresh. */
  updatedAt?: string;
  /** Last query attempt time. */
  checkedAt?: string;
  cached?: boolean;
  stale?: boolean;
  message?: string;
}

export interface ProviderBalanceResult {
  providerId: string;
  adapter: BalanceAdapter;
  items: ProviderBalanceItem[];
  message?: string;
}
