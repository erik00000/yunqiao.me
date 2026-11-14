import type { AuroraStore } from '../store/index.js';

export interface LiveRequest {
  id: string; threadId?: string; agent: string; phase: 'connecting' | 'streaming' | 'retrying';
  model: string; providerName?: string; startedAtMs: number; attempts: number; autoRetries: number;
  inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number;
  estimatedOutputTokens?: number;
}
const requests = new WeakMap<AuroraStore, Map<string, LiveRequest>>();
function entries(store: AuroraStore) { let items = requests.get(store); if (!items) { items = new Map(); requests.set(store, items); } return items; }
export function activeRequests(store: AuroraStore): LiveRequest[] { return [...entries(store).values()].map(v => ({ ...v })); }
export function trackRequest(store: AuroraStore, request: LiveRequest) { entries(store).set(request.id, request); }
export function updateRequest(store: AuroraStore, id: string, patch: Partial<LiveRequest>) { const v = entries(store).get(id); if (v) Object.assign(v, patch); }
export function finishRequest(store: AuroraStore, id: string) { const all = entries(store); const item = all.get(id); all.delete(id); return item; }
