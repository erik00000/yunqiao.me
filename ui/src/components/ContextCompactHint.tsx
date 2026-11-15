import React from 'react';
import { defaultAutoCompactTokenLimit } from '../../../src/core/modelContext';

/** A preview of the Codex policy applied later, not a change to the provider's capacity. */
export default function ContextCompactHint({ value, id }: { value: number | undefined; id?: string }) {
  const limit = defaultAutoCompactTokenLimit(value);
  return limit === undefined ? null : <span className="hint context-compact-hint" id={id} style={{ display: 'block', marginTop: 5, overflowWrap: 'anywhere', lineHeight: 1.7 }}>自动压缩：{limit} tokens（90%）</span>;
}
