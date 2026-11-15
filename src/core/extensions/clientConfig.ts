import { parse } from 'smol-toml';
import { codexConfigPath } from '../codex.js';
import { readText } from '../agents/configFiles.js';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Read root settings and legacy profile tables, including quoted provider keys. */
export function extensionClientConfig(source?: string): { root: Record<string, any>; provider?: string; definition: Record<string, any>; customApi: boolean } {
  let root: Record<string, any>;
  try {
    const text = source ?? readText(codexConfigPath());
    root = parse(text.replace(/^\uFEFF/, ''));
  } catch { throw new Error('客户端 TOML 配置无法解析，请修复配置后重试'); }
  let profile: Record<string, any> = {};
  if (root.profile !== undefined) {
    if (typeof root.profile !== 'string' || !object(root.profiles?.[root.profile])) throw new Error('客户端选择的 profile 不存在或无效');
    profile = root.profiles[root.profile];
  }
  const provider = profile.model_provider ?? root.model_provider;
  if (provider !== undefined && typeof provider !== 'string') throw new Error('客户端 model_provider 配置无效');
  if ([root.model_providers, profile.model_providers].some(value => value !== undefined && !object(value))) throw new Error('客户端供应商表配置无效');
  const base = provider ? root.model_providers?.[provider] : undefined, override = provider ? profile.model_providers?.[provider] : undefined;
  if ([base, override].some(value => value !== undefined && !object(value))) throw new Error('客户端所选供应商配置无效');
  const definition = { ...base, ...override };
  const customApi = !!provider && !['openai', 'amazon-bedrock', 'amazonBedrock'].includes(provider) && typeof definition.base_url === 'string' && !!definition.base_url.trim();
  return { root, provider, definition, customApi };
}
