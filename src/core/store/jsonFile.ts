import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * JSON 存储：保存成功前完成原子写，避免退出时丢失最后一次配置。
 * 备份就是把 data 目录拷走。
 */
export class JsonFile<T> {
  private cache: T | null = null;
  private dirty = false;

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
      if (error?.code !== 'ENOENT') throw new Error(`无法读取配置 ${this.file}：${error?.message || error}`);
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
  read(limit = 500): any[] {
    try {
      const txt = fs.readFileSync(this.file, 'utf8');
      const lines = txt.split('\n').filter(Boolean);
      const slice = limit > 0 ? lines.slice(-limit) : lines;
      return slice.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
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
