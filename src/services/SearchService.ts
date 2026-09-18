import type { HttpResponse, IHttpAdapter } from "../adapters/types";
import type {
  ConnectionOutcome,
  SearchOutcome,
  SourceError,
  Suggestion,
} from "../types";

const OPENALEX_BASE = "https://api.openalex.org/works";
const S2_BASE =
  "https://api.semanticscholar.org/graph/v1/paper/search";
const S2_PAPER_BASE = "https://api.semanticscholar.org/graph/v1/paper";
const S2_RECOMMENDATIONS_URL =
  "https://api.semanticscholar.org/recommendations/v1/papers/";
const S2_FIELDS =
  "title,authors,publicationDate,abstract,citationCount,externalIds,url,venue,openAccessPdf,paperId";

export const RESULTS_PER_QUERY = 4;
export const S2_SOLO_BUDGET = 4;
export const S2_SPACING_MS = 1200;
export const QUERY_MAX_LENGTH = 300;
export const OA_BATCH_SIZE = 5;
export const OA_BATCH_PAUSE_MS = 300;
export const RELATED_OA_LIMIT = 6;
export const RELATED_S2_LIMIT = 6;
export const RELATED_MAX_POSITIVE_IDS = 10;
export const RELATED_MAX_NEGATIVE_IDS = 10;

const OPENALEX_DELAYS_MS = [1000, 2500, 5000];

export function reconstructAbstract(
  inverted?: Record<string, number[]> | null
): string {
  if (!inverted || typeof inverted !== "object") return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) words.push([position, word]);
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, word]) => word).join(" ");
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeDoi(doi: string): string {
  return doi
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .trim();
}

export function dedupKeyOf(suggestion: {
  title: string;
  doi?: string;
}): string {
  if (suggestion.doi) return "doi:" + normalizeDoi(suggestion.doi);
  return "title:" + normalizeTitle(suggestion.title);
}

export function interleave<T>(first: T[], second: T[]): T[] {
  const out: T[] = [];
  const max = Math.max(first.length, second.length);
  for (let i = 0; i < max; i++) {
    if (i < first.length) out.push(first[i]);
    if (i < second.length) out.push(second[i]);
  }
  return out;
}

export function interleaveMany<T>(lists: T[][]): T[] {
  const out: T[] = [];
  let max = 0;
  for (const list of lists) max = Math.max(max, list.length);
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i]);
    }
  }
  return out;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pickBridgePair(topics: string[], rotation: number): string[] | null {
  if (topics.length < 2) return null;
  const shuffled = seededShuffle(topics, rotation + 1);
  return [shuffled[0], shuffled[1]];
}

export function truncateQuery(query: string): string {
  if (query.length <= QUERY_MAX_LENGTH) return query;
  const cut = query.slice(0, QUERY_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > QUERY_MAX_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

export function jitteredDelay(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

export function dedupAndCap(
  suggestions: Suggestion[],
  cap: number
): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const s of suggestions) {
    const key = dedupKeyOf(s);
    if (seen.has(key)) continue;
    if (!s.title && !s.doi) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, Math.max(0, cap));
}

function yearFromDate(date: string | undefined): number | null {
  if (!date) return null;
  const m = /(\d{4})/.exec(date);
  return m ? Number(m[1]) : null;
}

export function openAlexIdOf(id: string): string {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? id : id.slice(idx + 1);
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  display_name?: string;
  landing_page_url?: string;
  publication_date?: string;
  publication_year?: number;
  cited_by_count?: number;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: {
    source?: { display_name?: string } | null;
  } | null;
  open_access?: { oa_url?: string | null } | null;
  best_oa_location?: { pdf_url?: string | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
}

interface S2Paper {
  paperId?: string;
  title?: string;
  url?: string;
  venue?: string;
  publicationDate?: string;
  abstract?: string | null;
  citationCount?: number;
  externalIds?: { DOI?: string } | null;
  authors?: Array<{ name?: string }>;
  openAccessPdf?: { url?: string } | null;
}

const DEFAULT_DELAYS_MS = [3000, 6000, 12000];

interface RequestInit {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

export interface SearchDeps {
  http: IHttpAdapter;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class SearchService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly deps: SearchDeps) {
    this.sleep =
      deps.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = deps.maxRetries ?? DEFAULT_DELAYS_MS.length;
  }

  private async requestRetriable(
    url: string,
    init: RequestInit | undefined,
    delaysMs: number[],
    describe: (status: number) => string,
    jitter: boolean
  ): Promise<HttpResponse> {
    let lastError = new Error(describe(0));
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = delaysMs[Math.min(attempt, delaysMs.length) - 1];
        await this.sleep(jitter ? jitteredDelay(delay) : delay);
      }
      const res = await this.deps.http.request(url, init);
      if (res.status === 200) return res;
      lastError = new Error(describe(res.status));
      if (res.status === 429 || res.status >= 500) continue;
      throw lastError;
    }
    throw lastError;
  }

  async search(
    topics: string[],
    maxResults: number,
    opts?: {
      openAlexEmail?: string;
      s2ApiKey?: string;
      groups?: string[][];
      rotation?: number;
      relatedPins?: Suggestion[];
      dismissedPins?: Suggestion[];
      excludeUrls?: string[];
    }
  ): Promise<SearchOutcome> {
    const rotation = opts?.rotation ?? 0;
    const bridge = pickBridgePair(topics, rotation);
    const specs: Array<{ topics: string[]; query: string }> = [
      ...topics.map((topic) => ({ topics: [topic], query: topic })),
      ...(opts?.groups ?? [])
        .filter((group) => group.length >= 2)
        .map((group) => ({ topics: [...group], query: group.join(" ") })),
      ...(bridge ? [{ topics: bridge, query: bridge.join(" ") }] : []),
    ];
    const [openAlexEntries, s2Lists, s2Error] = await this.runQueries(
      specs,
      [
        ...this.s2SoloSubset(topics, rotation),
        ...(bridge ? [bridge.join(" ")] : []),
      ],
      opts
    );
    const errors: SourceError[] = [];
    const openAlexFailures = openAlexEntries.filter((e) => !e.ok);
    if (openAlexFailures.length > 0) {
      errors.push({
        source: "openalex",
        message: `${openAlexFailures.length} of ${specs.length} OpenAlex queries failed (first: ${openAlexFailures[0].error.message})`,
      });
    }
    if (s2Error) {
      errors.push({ source: "semanticscholar", message: s2Error });
    }
    const connections: ConnectionOutcome[] = [];
    for (const entry of openAlexEntries) {
      if (entry.spec.topics.length < 2) continue;
      connections.push({
        topics: entry.spec.topics,
        found: entry.ok ? entry.list.length : 0,
      });
    }
    const lists: Suggestion[][] = [];
    for (const entry of openAlexEntries) {
      if (entry.ok && entry.list.length > 0) lists.push(entry.list);
    }
    for (const list of s2Lists) {
      if (list.length > 0) lists.push(list);
    }
    const related = await this.relatedResults(opts);
    lists.push(...related.lists);
    errors.push(...related.errors);
    const ordered = seededShuffle(lists, rotation);
    const exclude = new Set(opts?.excludeUrls ?? []);
    const merged = interleaveMany(ordered).filter((s) => !exclude.has(s.url));
    return {
      results: dedupAndCap(merged, maxResults),
      errors,
      connections,
    };
  }

  private async relatedResults(
    opts?: {
      openAlexEmail?: string;
      s2ApiKey?: string;
      relatedPins?: Suggestion[];
      dismissedPins?: Suggestion[];
    }
  ): Promise<{ lists: Suggestion[][]; errors: SourceError[] }> {
    const pins = opts?.relatedPins ?? [];
    if (pins.length === 0) return { lists: [], errors: [] };
    await this.resolveOpenAlexIds(pins, opts?.openAlexEmail);
    const oaIds = pins
      .map((p) => p.oaId)
      .filter((id): id is string => Boolean(id))
      .slice(0, RELATED_MAX_POSITIVE_IDS);
    const s2Positive = pins
      .map((p) => p.s2Id ?? (p.doi ? `DOI:${p.doi}` : null))
      .filter((id): id is string => Boolean(id))
      .slice(0, RELATED_MAX_POSITIVE_IDS);
    const s2Negative = (opts?.dismissedPins ?? [])
      .map((p) => p.s2Id ?? (p.doi ? `DOI:${p.doi}` : null))
      .filter((id): id is string => Boolean(id))
      .slice(0, RELATED_MAX_NEGATIVE_IDS);
    const lists: Suggestion[][] = [];
    const errors: SourceError[] = [];
    const jobs: Array<Promise<void>> = [];
    if (oaIds.length > 0) {
      jobs.push(
        this.searchOpenAlexCiting(oaIds, RELATED_OA_LIMIT, opts?.openAlexEmail)
          .then((list) => {
            if (list.length > 0) lists.push(list);
          })
          .catch((error: unknown) => {
            errors.push({
              source: "openalex",
              message: `Related-work citations lookup failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          })
      );
    }
    if (s2Positive.length > 0) {
      jobs.push(
        this.recommendFromPins(
          s2Positive,
          s2Negative,
          RELATED_S2_LIMIT,
          opts?.s2ApiKey
        )
          .then((list) => {
            if (list.length > 0) lists.push(list);
          })
          .catch((error: unknown) => {
            errors.push({
              source: "semanticscholar",
              message: `Related-work recommendations failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          })
      );
    }
    await Promise.all(jobs);
    return { lists, errors };
  }

  private async runQueries(
    specs: Array<{ topics: string[]; query: string }>,
    s2Queries: string[],
    opts?: { openAlexEmail?: string; s2ApiKey?: string }
  ): Promise<
    [
      Array<
        | { ok: true; spec: { topics: string[]; query: string }; list: Suggestion[] }
        | { ok: false; spec: { topics: string[]; query: string }; error: Error }
      >,
      Suggestion[][],
      string | null
    ]
  > {
    const openAlexEntries: Array<
      | { ok: true; spec: { topics: string[]; query: string }; list: Suggestion[] }
      | { ok: false; spec: { topics: string[]; query: string }; error: Error }
    > = [];
    for (let i = 0; i < specs.length; i += OA_BATCH_SIZE) {
      if (i > 0) await this.sleep(OA_BATCH_PAUSE_MS);
      const batch = specs.slice(i, i + OA_BATCH_SIZE);
      const entries = await Promise.all(
        batch.map((spec) =>
          this.searchOpenAlex(
            truncateQuery(spec.query),
            RESULTS_PER_QUERY,
            opts?.openAlexEmail
          )
            .then((list) => ({ ok: true as const, spec, list }))
            .catch((error: unknown) => ({
              ok: false as const,
              spec,
              error: error instanceof Error ? error : new Error(String(error)),
            }))
        )
      );
      openAlexEntries.push(...entries);
    }
    const s2Lists: Suggestion[][] = [];
    let s2Error: string | null = null;
    for (let i = 0; i < s2Queries.length; i++) {
      if (i > 0) await this.sleep(S2_SPACING_MS);
      try {
        s2Lists.push(
          await this.searchSemanticScholar(
            truncateQuery(s2Queries[i]),
            RESULTS_PER_QUERY,
            opts?.s2ApiKey
          )
        );
      } catch (error) {
        if (!s2Error) {
          s2Error = error instanceof Error ? error.message : String(error);
        }
      }
    }
    return [openAlexEntries, s2Lists, s2Error];
  }

  private s2SoloSubset(topics: string[], rotation: number): string[] {
    const n = topics.length;
    if (n <= S2_SOLO_BUDGET) return [...topics];
    const indices = new Set<number>();
    for (let i = 0; i < S2_SOLO_BUDGET; i++) {
      indices.add((rotation * S2_SOLO_BUDGET + i) % n);
    }
    return [...indices].sort((a, b) => a - b).map((i) => topics[i]);
  }

  async searchOpenAlex(
    query: string,
    limit: number,
    email?: string
  ): Promise<Suggestion[]> {
    const params = new URLSearchParams({
      search: query,
      per_page: String(Math.min(Math.max(limit, 1), 200)),
    });
    if (email) params.set("mailto", email);
    const url = `${OPENALEX_BASE}?${params}`;
    const res = await this.requestRetriable(
      url,
      undefined,
      OPENALEX_DELAYS_MS,
      (status) => `OpenAlex HTTP ${status}`,
      true
    );
    const json = JSON.parse(res.text) as { results?: OpenAlexWork[] };
    return (json.results ?? []).map((work) => mapOpenAlexWork(work));
  }

  async searchSemanticScholar(
    query: string,
    limit: number,
    apiKey?: string
  ): Promise<Suggestion[]> {
    const params = new URLSearchParams({
      query,
      limit: String(Math.min(Math.max(limit, 1), 100)),
      fields: S2_FIELDS,
    });
    const headers: Record<string, string> = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await this.requestRetriable(
      `${S2_BASE}?${params}`,
      { headers },
      DEFAULT_DELAYS_MS,
      (status) => `Semantic Scholar HTTP ${status}`,
      false
    );
    const json = JSON.parse(res.text) as { data?: S2Paper[] };
    return (json.data ?? []).map((paper) => mapS2Paper(paper));
  }

  async fetchOpenAlexWorkByDoi(
    doi: string,
    email?: string
  ): Promise<Suggestion | null> {
    const params = new URLSearchParams();
    if (email) params.set("mailto", email);
    const qs = params.toString();
    const url = `${OPENALEX_BASE}/doi:${doi}${qs ? `?${qs}` : ""}`;
    try {
      const res = await this.requestRetriable(
        url,
        undefined,
        OPENALEX_DELAYS_MS,
        (status) => `OpenAlex HTTP ${status}`,
        true
      );
      const work = JSON.parse(res.text) as OpenAlexWork;
      return mapOpenAlexWork(work);
    } catch (error) {
      if (error instanceof Error && /OpenAlex HTTP 404/.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async lookupS2Paper(
    externalId: string,
    apiKey?: string
  ): Promise<Suggestion | null> {
    const params = new URLSearchParams({ fields: S2_FIELDS });
    const headers: Record<string, string> = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    const url = `${S2_PAPER_BASE}/${externalId}?${params}`;
    try {
      const res = await this.requestRetriable(
        url,
        { headers },
        DEFAULT_DELAYS_MS,
        (status) => `Semantic Scholar HTTP ${status}`,
        false
      );
      const paper = JSON.parse(res.text) as S2Paper;
      return mapS2Paper(paper);
    } catch (error) {
      if (
        error instanceof Error &&
        /Semantic Scholar HTTP 404/.test(error.message)
      ) {
        return null;
      }
      throw error;
    }
  }

  async searchOpenAlexCiting(
    oaIds: string[],
    limit: number,
    email?: string
  ): Promise<Suggestion[]> {
    const params = new URLSearchParams({
      filter: `cites:${oaIds.join("|")}`,
      sort: "cited_by_count:desc",
      per_page: String(Math.min(Math.max(limit, 1), 200)),
    });
    if (email) params.set("mailto", email);
    const res = await this.requestRetriable(
      `${OPENALEX_BASE}?${params}`,
      undefined,
      OPENALEX_DELAYS_MS,
      (status) => `OpenAlex HTTP ${status}`,
      true
    );
    const json = JSON.parse(res.text) as { results?: OpenAlexWork[] };
    return (json.results ?? []).map((work) => mapOpenAlexWork(work, "related"));
  }

  async recommendFromPins(
    positiveIds: string[],
    negativeIds: string[],
    limit: number,
    apiKey?: string
  ): Promise<Suggestion[]> {
    const params = new URLSearchParams({
      fields: S2_FIELDS,
      limit: String(Math.min(Math.max(limit, 1), 100)),
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await this.requestRetriable(
      `${S2_RECOMMENDATIONS_URL}?${params}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          positivePaperIds: positiveIds,
          negativePaperIds: negativeIds,
        }),
      },
      DEFAULT_DELAYS_MS,
      (status) => `Semantic Scholar HTTP ${status}`,
      false
    );
    const json = JSON.parse(res.text) as { recommendedPapers?: S2Paper[] };
    return (json.recommendedPapers ?? []).map((paper) =>
      mapS2Paper(paper, "related")
    );
  }

  async resolveOpenAlexIds(pins: Suggestion[], email?: string): Promise<void> {
    const missing = pins.filter((p) => !p.oaId && p.doi);
    for (let i = 0; i < missing.length; i++) {
      if (i > 0) await this.sleep(OA_BATCH_PAUSE_MS);
      try {
        const found = await this.fetchOpenAlexWorkByDoi(
          missing[i].doi as string,
          email
        );
        if (found?.oaId) missing[i].oaId = found.oaId;
      } catch {
        // Best effort; related search proceeds without this pin's citations.
      }
    }
  }

  async resolvePaper(
    raw: string,
    opts?: { s2ApiKey?: string; openAlexEmail?: string }
  ): Promise<Suggestion> {
    const trimmed = raw.trim();
    const doi = extractDoi(trimmed);
    const arxivId = extractArxivId(trimmed);
    const isUrl = /^https?:\/\//i.test(trimmed);
    const url = doi && !isUrl ? `https://doi.org/${doi}` : trimmed;
    const ids: string[] = [];
    if (doi) ids.push(`DOI:${doi}`);
    if (arxivId) ids.push(`ArXiv:${arxivId}`);
    if (isUrl && !doi && !arxivId) ids.push(`URL:${encodeURIComponent(trimmed)}`);
    let sawError: Error | null = null;
    for (const id of ids) {
      try {
        const found = await this.lookupS2Paper(id, opts?.s2ApiKey);
        if (found) return found;
      } catch (error) {
        sawError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (doi) {
      try {
        const found = await this.fetchOpenAlexWorkByDoi(
          doi,
          opts?.openAlexEmail
        );
        if (found) return found;
      } catch (error) {
        sawError ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (sawError) throw sawError;
    return stubSuggestion(url);
  }
}

function mapOpenAlexWork(work: OpenAlexWork, origin?: "related"): Suggestion {
  const doi = work.doi ? normalizeDoi(work.doi) : undefined;
  const url = work.doi ?? work.landing_page_url ?? work.id ?? "";
  return {
    url,
    title: work.display_name ?? "",
    authors: (work.authorships ?? [])
      .map((a) => a.author?.display_name)
      .filter((n): n is string => Boolean(n)),
    publisher: work.primary_location?.source?.display_name ?? "",
    year: work.publication_year ?? yearFromDate(work.publication_date),
    date: work.publication_date ?? "",
    abstract: reconstructAbstract(work.abstract_inverted_index),
    oaUrl: work.open_access?.oa_url ?? work.best_oa_location?.pdf_url ?? "",
    doi,
    oaId: work.id ? openAlexIdOf(work.id) : undefined,
    citationCount: work.cited_by_count,
    source: "openalex",
    ...(origin ? { origin } : {}),
  };
}

function mapS2Paper(paper: S2Paper, origin?: "related"): Suggestion {
  const doi = paper.externalIds?.DOI;
  const url = doi
    ? `https://doi.org/${doi}`
    : (paper.url ?? (paper.paperId ? `https://www.semanticscholar.org/paper/${paper.paperId}` : ""));
  return {
    url,
    title: paper.title ?? "",
    authors: (paper.authors ?? [])
      .map((a) => a.name)
      .filter((n): n is string => Boolean(n)),
    publisher: paper.venue ?? "",
    year: yearFromDate(paper.publicationDate),
    date: paper.publicationDate ?? "",
    abstract: paper.abstract ?? "",
    oaUrl: paper.openAccessPdf?.url ?? "",
    doi,
    s2Id: paper.paperId,
    citationCount: paper.citationCount,
    source: "semanticscholar",
    ...(origin ? { origin } : {}),
  };
}

export function extractDoi(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^10\.\d{4,9}\/\S+$/.test(trimmed)) return normalizeDoi(trimmed);
  const url = /^https?:\/\/(dx\.)?doi\.org\/(10\.\S+)$/i.exec(trimmed);
  return url ? normalizeDoi(url[2]) : null;
}

export function extractArxivId(raw: string): string | null {
  const trimmed = raw.trim();
  const url = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#].*)?$/i.exec(
    trimmed
  );
  if (url) return url[1].replace(/v\d+$/i, "");
  const bare = /^(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(trimmed);
  return bare ? bare[1] : null;
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(parts[parts.length - 1] ?? "");
    const cleaned = last
      .replace(/\.(pdf|html?)$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
    return cleaned || parsed.hostname;
  } catch {
    return url;
  }
}

function stubSuggestion(url: string): Suggestion {
  return {
    url,
    title: titleFromUrl(url),
    authors: [],
    publisher: "",
    year: null,
    date: "",
    abstract: "",
    oaUrl: "",
    source: "semanticscholar",
  };
}
