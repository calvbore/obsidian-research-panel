import { requestUrl, Vault } from "obsidian";
import type { IFileSystem, IHttpAdapter, HttpOptions, HttpResponse } from "./types";

export class ObsidianHttp implements IHttpAdapter {
  async request(url: string, options?: HttpOptions): Promise<HttpResponse> {
    const res = await requestUrl({
      url,
      method: options?.method ?? "GET",
      headers: options?.headers,
      body: options?.body,
      throw: false,
    });
    return { status: res.status, text: res.text };
  }
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export class VaultFileSystem implements IFileSystem {
  constructor(private readonly vault: Vault) {}

  private get adapter() {
    return this.vault.adapter;
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  read(path: string): Promise<string> {
    return this.adapter.read(path);
  }

  async mkdir(path: string): Promise<void> {
    if (!path) return;
    if (await this.adapter.exists(path)) return;
    await this.adapter.mkdir(path);
  }

  async write(path: string, data: string): Promise<void> {
    const dir = parentDir(path);
    if (dir) await this.ensureDir(dir);
    await this.adapter.write(path, data);
  }

  private async ensureDir(dir: string): Promise<void> {
    const segments = dir.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      await this.mkdir(current);
    }
  }

  async remove(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return this.adapter.rename(oldPath, newPath);
  }

  async list(dir: string): Promise<string[]> {
    if (!(await this.adapter.exists(dir))) return [];
    const listed = await this.adapter.list(dir);
    return listed.files;
  }
}
