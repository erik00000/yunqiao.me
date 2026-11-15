import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * JSON 存储：保存成功前完成原子写，避免退出时丢失最后一次配置。
 * 备份就是把 data 目录拷走。
 */
export class JsonFile<T> {
  private cache: T | null = null;
  private dirty = false;
  private expectedRevision: string | null | undefined;

  constructor(
    private file: string,
    private fallback: () => T,
  ) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  read(): T {
    if (this.cache) return this.cache;
    try {
      const txt = fs.readFileSync(this.file, 'utf8');
      this.cache = JSON.parse(txt) as T;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error(`无法读取配置 ${this.file}：${error instanceof SyntaxError ? 'JSON 格式无效，请从备份恢复' : '请检查文件权限和磁盘状态'}`);
      this.cache = this.fallback();
    }
    return this.cache!;
  }

  write(value: T): void {
    const previous = this.cache;
    this.cache = value;
    this.dirty = true;
    try { this.flush(); }
    catch (error) { this.cache = previous; this.dirty = false; throw error; }
  }

  update(fn: (cur: T) => T): T {
    const next = fn(this.read());
    this.write(next);
    return next;
  }

  flush(): void {
    if (!this.dirty || this.cache == null) return;
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (this.expectedRevision !== undefined && this.revision() !== this.expectedRevision) throw new Error(`配置已变化，保留当前文件：${this.file}`);
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  /** 外部改动后丢弃缓存 */
  invalidate(): void {
    this.cache = null;
  }

  revision(expected?: T): string | null {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); }
    catch (error: any) { if (error?.code === 'ENOENT') return null; throw new Error(`无法核对配置文件：${this.file}`); }
    if (expected !== undefined) {
      try { if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(expected)) throw new Error(); }
      catch { this.invalidate(); throw new Error(`配置已变化，请刷新后重试：${this.file}`); }
    }
    return createHash('sha256').update(text).digest('hex');
  }

  writeIfUnchanged(value: T, revision: string | null): void {
    if (this.revision() !== revision) { this.invalidate(); throw new Error(`配置已变化，保留当前文件：${this.file}`); }
    this.expectedRevision = revision;
    try { this.write(value); }
    catch (error) { this.invalidate(); throw error; }
    finally { this.expectedRevision = undefined; }
  }

  /** Roll back only our committed value; preserve any subsequent external edits. */
  restoreIfUnchanged(previous: T, expected: T): void {
    try {
      const actual = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error();
    } catch {
      this.invalidate();
      throw new Error(`配置已变化，保留当前文件：${this.file}`);
    }
    const revision = this.revision(expected);
    try { this.writeIfUnchanged(previous, revision); }
    catch { throw new Error(`无法恢复配置文件：${this.file}`); }
  }
}

/** 追加式 JSONL 日志，用于用量记录 */
export class JsonLines {
  constructor(private file: string) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }
  append(rec: unknown): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', 'utf8');
    } catch {
      /* 磁盘满/权限不足时静默，不影响网关主流程 */
    }
  }
  read(limit = 500, accepts: (record: any) => boolean = () => true): any[] {
    let descriptor: number | undefined;
    try {
      if (limit > 0) {
        const maximum = Math.max(1, Math.floor(limit));
        descriptor = fs.openSync(this.file, 'r');
        let offset = fs.fstatSync(descriptor).size, carry = Buffer.alloc(0);
        const maxLineBytes = 1024 * 1024;
        let skippingOversizedLine = false;
        const records: any[] = [];
        const append = (line: Buffer) => {
          if (!line.length || line.length > maxLineBytes) return;
          try { const parsed = JSON.parse(line.toString('utf8')); if (parsed && accepts(parsed)) records.push(parsed); } catch { /* Ignore incomplete log lines. */ }
        };
        while (offset > 0 && records.length < maximum) {
          const size = Math.min(offset, 64 * 1024); offset -= size;
          const chunk = Buffer.allocUnsafe(size), read = fs.readSync(descriptor, chunk, 0, size, offset);
          let bytes = chunk.subarray(0, read);
          if (skippingOversizedLine) {
            const boundary = bytes.lastIndexOf(10);
            if (boundary < 0) continue;
            bytes = bytes.subarray(0, boundary + 1); skippingOversizedLine = false;
          }
          const data = Buffer.concat([bytes, carry]);
          let end = data.length;
          for (let i = data.length - 1; i >= 0 && records.length < maximum; i--) {
            if (data[i] === 10) { append(data.subarray(i + 1, end)); end = i; }
          }
          carry = data.subarray(0, end);
          if (carry.length > maxLineBytes) { carry = Buffer.alloc(0); skippingOversizedLine = true; }
          if (offset === 0 && records.length < maximum && !skippingOversizedLine) append(carry);
        }
        return records.reverse();
      }
      const txt = fs.readFileSync(this.file, 'utf8');
      const lines = txt.split('\n').filter(Boolean);
      const slice = limit > 0 ? lines.slice(-limit) : lines;
      return slice.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(record => record && accepts(record));
    } catch {
      return [];
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  listFiles(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }
}
