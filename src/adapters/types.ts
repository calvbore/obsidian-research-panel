export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export interface IHttpAdapter {
  request(url: string, options?: HttpOptions): Promise<HttpResponse>;
}

export interface IFileSystem {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
}
