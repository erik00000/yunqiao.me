/** Native SDK settings that reproduce the gateway's upstream URL exactly. */
export function nativeDirectParameters(base: string, protocol: string): { baseUrl: string; apiVersion?: string } {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('请填写有效的 API 基础地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('接口地址必须是 HTTP(S) URL，且不能包含账号密码');
  if (url.search || url.hash) throw new Error('直连接口地址不能包含查询参数或片段，请填写 API 基础地址');
  let baseUrl = url.toString().replace(/\/+$/, '');
  const version = baseUrl.match(/\/v\d+[a-z0-9]*$/i)?.[0];
  if (protocol === 'openai-chat' || protocol === 'openai-responses') {
    // These clients append only the operation, including below proxy prefixes.
    if (!version) baseUrl += '/v1';
  } else if (protocol === 'anthropic') {
    // Anthropic's SDK always appends /v1/messages to its configured base URL.
    if (version && version !== '/v1') throw new Error('此 API 版本无法由 Claude 客户端直连配置，请选择本地网关接入');
    if (version) baseUrl = baseUrl.slice(0, -version.length);
  } else if (protocol === 'gemini') {
    // Gemini CLI forwards both variables to the SDK. Explicitly pin the API
    // version, since SDK releases have used different defaults (v1beta / v1).
    if (version) baseUrl = baseUrl.slice(0, -version.length);
    return { baseUrl, apiVersion: version?.slice(1) || 'v1beta' };
  }
  return { baseUrl };
}
