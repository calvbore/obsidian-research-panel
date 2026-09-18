import type { HttpOptions, HttpResponse, IFileSystem, IHttpAdapter } from "../src/adapters/types";

export class FakeFs implements IFileSystem {
  files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const value = this.files.get(oldPath);
    if (value === undefined) throw new Error(`ENOENT: ${oldPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, value);
  }

  async list(dir: string): Promise<string[]> {
    const prefix = `${dir}/`;
    return Array.from(this.files.keys()).filter(
      (key) =>
        key.startsWith(prefix) &&
        !key.slice(prefix.length).includes("/")
    );
  }

  async mkdir(_path: string): Promise<void> {}

  seed(path: string, data: string): void {
    this.files.set(path, data);
  }
}

export class FakeHttp implements IHttpAdapter {
  requests: Array<{ url: string; options?: HttpOptions }> = [];

  constructor(
    private readonly handler: (
      url: string,
      options?: HttpOptions
    ) => HttpResponse | Promise<HttpResponse>
  ) {}

  async request(url: string, options?: HttpOptions): Promise<HttpResponse> {
    this.requests.push({ url, options });
    return await this.handler(url, options);
  }

  json(status: number, body: unknown): HttpResponse {
    return { status, text: JSON.stringify(body) };
  }

  text(status: number, body: string): HttpResponse {
    return { status, text: body };
  }
}

export function makeSleepRecorder(): {
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}
