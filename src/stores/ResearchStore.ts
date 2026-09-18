import type { IFileSystem } from "../adapters/types";
import type {
  DocumentResearchData,
  RelevanceBucket,
  Suggestion,
} from "../types";

const INDEX_FILE = "index.json";

const BUCKET_RANK: Record<RelevanceBucket, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function rankOf(s: Suggestion): number {
  return s.bucket ? BUCKET_RANK[s.bucket] : 3;
}

export function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function titleFromPath(path: string): string {
  const base = basename(path);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

export function mergeResults(
  record: DocumentResearchData,
  incoming: Suggestion[]
): Suggestion[] {
  const known = new Set(record.suggestions.map((s) => s.url));
  const added: Suggestion[] = [];
  for (const s of incoming) {
    if (known.has(s.url)) continue;
    if (record.pinned.includes(s.url)) continue;
    if (record.dismissed.includes(s.url)) continue;
    known.add(s.url);
    added.push(s);
  }
  record.suggestions.push(...added);
  return added;
}

export function topicSetHash(topics: string[]): string {
  const normalized = topics
    .map((t) => t.toLowerCase().trim())
    .sort()
    .join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function visibleSuggestions(record: DocumentResearchData): Suggestion[] {
  const dismissed = new Set(record.dismissed);
  const pool = record.suggestions.filter((s) => !dismissed.has(s.url));
  const byUrl = new Map(pool.map((s) => [s.url, s]));
  const pinned = record.pinned
    .map((url) => byUrl.get(url))
    .filter((s): s is Suggestion => Boolean(s));
  const pinSet = new Set(record.pinned);
  const rest = pool
    .filter((s) => !pinSet.has(s.url))
    .sort(
      (a, b) =>
        rankOf(a) - rankOf(b) ||
        (b.year ?? -Infinity) - (a.year ?? -Infinity)
    );
  return [...pinned, ...rest];
}

export class ResearchStore {
  private readonly index = new Map<string, string>();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fs: IFileSystem,
    private readonly rootDir = ".research-panel"
  ) {}

  private get indexPath(): string {
    return `${this.rootDir}/${INDEX_FILE}`;
  }

  private dataPath(id: string): string {
    return `${this.rootDir}/${id}.json`;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.loadIndex();
    this.loaded = true;
  }

  async reload(): Promise<void> {
    await this.loadIndex();
    this.loaded = true;
  }

  private async loadIndex(): Promise<void> {
    this.index.clear();
    let raw: string | null = null;
    try {
      raw = (await this.fs.exists(this.indexPath))
        ? await this.fs.read(this.indexPath)
        : null;
    } catch {
      raw = null;
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Record<string, string>;
        for (const [path, id] of Object.entries(parsed)) {
          if (typeof id === "string") this.index.set(path, id);
        }
        return;
      } catch {
        this.index.clear();
      }
    }
    await this.rebuildIndex();
  }

  async rebuildIndex(): Promise<void> {
    this.index.clear();
    const files = await this.fs.list(this.rootDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      if (file === this.indexPath || file.endsWith(".tmp")) continue;
      let record: DocumentResearchData;
      try {
        record = JSON.parse(await this.fs.read(file)) as DocumentResearchData;
      } catch {
        continue;
      }
      if (!record?.notePath || !record?.id || record.orphaned) continue;
      this.index.set(record.notePath, record.id);
    }
    await this.persistIndex();
  }

  private async persistIndex(): Promise<void> {
    await this.writeAtomic(
      this.indexPath,
      JSON.stringify(Object.fromEntries(this.index), null, 2)
    );
  }

  private async writeAtomic(path: string, data: string): Promise<void> {
    await this.fs.write(path, data);
  }

  private async readData(id: string): Promise<DocumentResearchData | null> {
    try {
      const raw = await this.fs.read(this.dataPath(id));
      const parsed = JSON.parse(raw) as DocumentResearchData;
      if (!parsed?.id) return null;
      if (!parsed.dismissedTopics) parsed.dismissedTopics = [];
      if (!parsed.searchCount) parsed.searchCount = 0;
      return parsed;
    } catch {
      return null;
    }
  }

  private saveData(record: DocumentResearchData): Promise<void> {
    return this.runExclusive(async () => {
      record.noteTitle = titleFromPath(record.notePath);
      await this.writeAtomic(
        this.dataPath(record.id),
        JSON.stringify(record, null, 2)
      );
      if (record.orphaned) return;
      const mapped = this.index.get(record.notePath);
      if (mapped !== record.id) {
        this.index.set(record.notePath, record.id);
        await this.persistIndex();
      }
    });
  }

  private findFuzzy(notePath: string): string | undefined {
    const base = basename(notePath).toLowerCase();
    if (!base) return undefined;
    for (const [known] of this.index) {
      if (basename(known).toLowerCase() === base) return known;
    }
    return undefined;
  }

  async get(notePath: string): Promise<DocumentResearchData | null> {
    await this.ensureLoaded();
    let id = this.index.get(notePath);
    if (!id) {
      const fuzzy = this.findFuzzy(notePath);
      if (!fuzzy) return null;
      id = this.index.get(fuzzy);
    }
    if (!id) return null;
    return this.readData(id);
  }

  async getOrCreate(
    notePath: string,
    noteTitle: string
  ): Promise<DocumentResearchData> {
    await this.ensureLoaded();
    const existing = await this.get(notePath);
    if (existing) {
      existing.notePath = notePath;
      existing.noteTitle = noteTitle;
      existing.orphaned = false;
      await this.saveData(existing);
      return existing;
    }
    const record: DocumentResearchData = {
      id: newId(),
      notePath,
      noteTitle,
      manualTopics: [],
      pinned: [],
      dismissed: [],
      dismissedTopics: [],
      searchCount: 0,
      suggestions: [],
    };
    await this.saveData(record);
    return record;
  }

  async handleFileRename(oldPath: string, newPath: string): Promise<void> {
    await this.ensureLoaded();
    const id = this.index.get(oldPath);
    if (!id) return;
    this.index.delete(oldPath);
    this.index.set(newPath, id);
    await this.persistIndex();
    const record = await this.readData(id);
    if (record && !record.orphaned) {
      record.notePath = newPath;
      await this.saveData(record);
    }
  }

  async handleFolderRename(oldDir: string, newDir: string): Promise<void> {
    await this.ensureLoaded();
    const prefix = `${oldDir}/`;
    const affected: Array<[string, string, string]> = [];
    for (const [key, id] of this.index) {
      if (!key.startsWith(prefix)) continue;
      affected.push([key, `${newDir}/${key.slice(prefix.length)}`, id]);
    }
    if (affected.length === 0) return;
    for (const [oldKey, newKey, id] of affected) {
      this.index.delete(oldKey);
      this.index.set(newKey, id);
    }
    await this.persistIndex();
    for (const [, newKey, id] of affected) {
      const record = await this.readData(id);
      if (record && !record.orphaned) {
        record.notePath = newKey;
        await this.saveData(record);
      }
    }
  }

  async handleFileDelete(path: string): Promise<void> {
    await this.ensureLoaded();
    const id = this.index.get(path);
    if (!id) return;
    this.index.delete(path);
    await this.persistIndex();
    const record = await this.readData(id);
    if (record) {
      record.orphaned = true;
      await this.saveData(record);
    }
  }

  async handleFolderDelete(dir: string): Promise<void> {
    await this.ensureLoaded();
    const prefix = `${dir}/`;
    const ids: string[] = [];
    for (const [key, id] of this.index) {
      if (key.startsWith(prefix)) {
        this.index.delete(key);
        ids.push(id);
      }
    }
    if (ids.length === 0) return;
    await this.persistIndex();
    for (const id of ids) {
      const record = await this.readData(id);
      if (record) {
        record.orphaned = true;
        await this.saveData(record);
      }
    }
  }

  async save(record: DocumentResearchData): Promise<void> {
    await this.ensureLoaded();
    await this.saveData(record);
  }
}

export function newId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
