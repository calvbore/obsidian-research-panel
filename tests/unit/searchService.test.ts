import { describe, expect, it } from "vitest";
import {
  dedupAndCap,
  dedupKeyOf,
  extractArxivId,
  extractDoi,
  interleave,
  interleaveMany,
  normalizeDoi,
  OA_BATCH_PAUSE_MS,
  pickBridgePair,
  reconstructAbstract,
  RELATED_OA_LIMIT,
  RELATED_S2_LIMIT,
  RESULTS_PER_QUERY,
  S2_SOLO_BUDGET,
  S2_SPACING_MS,
  SearchService,
  seededShuffle,
  truncateQuery,
  QUERY_MAX_LENGTH,
} from "../../src/services/SearchService";
import { FakeHttp, makeSleepRecorder } from "../helpers";
import type { Suggestion } from "../../src/types";

describe("reconstructAbstract", () => {
  it("rebuilds a sentence from an inverted index", () => {
    expect(
      reconstructAbstract({ hello: [0], world: [1], again: [2] })
    ).toBe("hello world again");
  });

  it("handles words at multiple positions", () => {
    expect(reconstructAbstract({ a: [0, 2], b: [1] })).toBe("a b a");
  });

  it("handles missing, empty, and single-word indexes", () => {
    expect(reconstructAbstract(null)).toBe("");
    expect(reconstructAbstract(undefined)).toBe("");
    expect(reconstructAbstract({})).toBe("");
    expect(reconstructAbstract({ word: [3] })).toBe("word");
  });
});

describe("dedup helpers", () => {
  it("normalizes DOIs across common variants", () => {
    expect(normalizeDoi("https://doi.org/10.1234/ABC")).toBe(
      "10.1234/abc"
    );
    expect(normalizeDoi("http://dx.doi.org/10.1234/x")).toBe("10.1234/x");
    expect(normalizeDoi("doi: 10.1234/y")).toBe("10.1234/y");
  });

  it("prefers DOI keys over titles when both exist", () => {
    const key = dedupKeyOf({
      title: "Some Title",
      doi: "https://doi.org/10.1/z",
    });
    expect(key).toBe("doi:10.1/z");
  });

  it("falls back to normalized titles ignoring case/punct/space", () => {
    expect(dedupKeyOf({ title: "A  Complex — Title!" })).toBe(
      dedupKeyOf({ title: "a complex title" })
    );
  });

  it("interleaves two lists alternately", () => {
    const mixed: Array<number | string> = interleave<number | string>([1, 2, 3], ["a", "b"]);
    expect(mixed).toEqual([1, "a", 2, "b", 3]);
    expect(interleave([], [1])).toEqual([1]);
  });

  it("round-robins many lists with interleaveMany", () => {
    const mixed = interleaveMany<number | string | boolean>([
      [1, 2, 3],
      ["a", "b"],
      [true],
    ]);
    expect(mixed).toEqual([1, "a", true, 2, "b", 3]);
    expect(interleaveMany([])).toEqual([]);
    expect(interleaveMany([[], [1]])).toEqual([1]);
  });

  it("shuffles deterministically per seed and preserves elements", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(seededShuffle(items, 7)).toEqual(seededShuffle(items, 7));
    expect(seededShuffle(items, 7)).not.toEqual(seededShuffle(items, 8));
    expect([...seededShuffle(items, 7)].sort((a, b) => a - b)).toEqual(items);
  });

  it("picks a deterministic two-topic bridge pair that varies by rotation", () => {
    const topics = ["t0", "t1", "t2", "t3", "t4"];
    expect(pickBridgePair(["only"], 0)).toBeNull();
    const pairs = new Set<string>();
    for (let rotation = 0; rotation < 10; rotation++) {
      const pair = pickBridgePair(topics, rotation) as string[];
      expect(pair).toHaveLength(2);
      expect(pair[0]).not.toBe(pair[1]);
      for (const topic of pair) expect(topics).toContain(topic);
      pairs.add(pair.join("|"));
      expect(pair).toEqual(pickBridgePair(topics, rotation));
    }
    expect(pairs.size).toBeGreaterThanOrEqual(3);
  });

  it("truncates long queries at the S2 limit on a word boundary", () => {
    const short = "already fine";
    expect(truncateQuery(short)).toBe(short);
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const cut = truncateQuery(long);
    expect(cut.length).toBeLessThanOrEqual(QUERY_MAX_LENGTH);
    expect(cut).toMatch(/word\d+$/);
    expect(cut.startsWith("word0")).toBe(true);
  });

  it("caps results after dedup", () => {
    const list = [
      makeS({ url: "1", doi: "10.1/a" }),
      makeS({ url: "2", doi: "10.1/A" }),
      makeS({ url: "3", title: "Same" }),
      makeS({ url: "4", title: "same." }),
      makeS({ url: "5" }),
    ];
    const capped = dedupAndCap(list, 2);
    expect(capped.map((s) => s.url)).toEqual(["1", "3"]);
  });

  function makeS(overrides: Partial<Suggestion>): Suggestion {
    return {
      url: "",
      title: "",
      authors: [],
      publisher: "",
      year: null,
      date: "",
      abstract: "",
      oaUrl: "",
      source: "openalex",
      ...overrides,
    };
  }
});

const OPENALEX_PAYLOAD = {
  results: [
    {
      id: "https://openalex.org/W1",
      doi: "https://doi.org/10.5555/openalex-1",
      display_name: "OpenAlex Paper One",
      publication_date: "2023-05-01",
      publication_year: 2023,
      cited_by_count: 42,
      authorships: [
        { author: { display_name: "Ada Lovelace" } },
        { author: { display_name: "Grace Hopper" } },
      ],
      primary_location: { source: { display_name: "Journal of Testing" } },
      open_access: { oa_url: "https://oa.example/pdf" },
      abstract_inverted_index: { Study: [0], of: [1], things: [2] },
    },
    {
      id: "https://openalex.org/W2",
      doi: null,
      display_name: "No Abstract Work",
      landing_page_url: "https://landing.example/w2",
    },
  ],
};

const S2_PAYLOAD = {
  data: [
    {
      paperId: "s2-1",
      title: "S2 Duplicate Of OpenAlex One",
      venue: "S2 Venue",
      publicationDate: "2022-02-02",
      abstract: "Direct abstract text.",
      citationCount: 7,
      externalIds: { DOI: "10.5555/openalex-1" },
      authors: [{ name: "Alan Turing" }],
      openAccessPdf: { url: "https://s2.example/pdf" },
    },
    {
      paperId: "s2-2",
      title: "Unique S2 Work",
      publicationDate: "2021-11-11",
      externalIds: {},
      authors: [],
      url: "https://semanticscholar.org/paper/s2-2",
    },
  ],
};

function openAlexUrl(): string {
  return "https://api.openalex.org/works?";
}

function s2Url(): string {
  return "https://api.semanticscholar.org/graph/v1/paper/search?";
}

describe("SearchService integration (fake http)", () => {
  it("parses OpenAlex works including inverted-index abstracts", async () => {
    const http: FakeHttp = new FakeHttp((url) =>
      url.startsWith(openAlexUrl())
        ? http.json(200, OPENALEX_PAYLOAD)
        : http.text(500, "nope")
    );
    const service = new SearchService({ http, maxRetries: 0 });
    const results = await service.searchOpenAlex("topics", 10);
    expect(results).toHaveLength(2);
    const first = results[0];
    expect(first.title).toBe("OpenAlex Paper One");
    expect(first.authors).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(first.publisher).toBe("Journal of Testing");
    expect(first.year).toBe(2023);
    expect(first.abstract).toBe("Study of things");
    expect(first.doi).toBe("10.5555/openalex-1");
    expect(first.url).toContain("doi.org");
    expect(first.oaUrl).toBe("https://oa.example/pdf");
    const second = results[1];
    expect(second.url).toBe("https://landing.example/w2");
    expect(second.abstract).toBe("");
  });

  it("retries Semantic Scholar on 429 with exponential delays", async () => {
    let calls = 0;
    const { sleep, delays } = makeSleepRecorder();
    const http: FakeHttp = new FakeHttp((url) => {
      if (!url.startsWith(s2Url())) throw new Error("unexpected " + url);
      calls++;
      if (calls < 3) return http.text(429, "slow down");
      return http.json(200, S2_PAYLOAD);
    });
    const service = new SearchService({ http, sleep });
    const results = await service.searchSemanticScholar("q", 10);
    expect(calls).toBe(3);
    expect(delays).toEqual([3000, 6000]);
    expect(results.map((r) => r.title)).toContain("Unique S2 Work");
    const dup = results.find((r) => r.title.includes("Duplicate"));
    expect(dup?.url).toBe("https://doi.org/10.5555/openalex-1");
  });

  it("does not retry non-retryable Semantic Scholar errors", async () => {
    let calls = 0;
    const http: FakeHttp = new FakeHttp(() => {
      calls++;
      return http.text(403, "forbidden");
    });
    const service = new SearchService({ http });
    await expect(service.searchSemanticScholar("q", 5)).rejects.toThrow(
      /403/
    );
    expect(calls).toBe(1);
  });

  it("retries OpenAlex on 429 with jittered backoff", async () => {
    let calls = 0;
    const { sleep, delays } = makeSleepRecorder();
    const http: FakeHttp = new FakeHttp((url) => {
      if (!url.startsWith(openAlexUrl())) throw new Error("unexpected " + url);
      calls++;
      if (calls === 1) return http.text(429, "slow down");
      return http.json(200, OPENALEX_PAYLOAD);
    });
    const service = new SearchService({ http, sleep, maxRetries: 1 });
    const results = await service.searchOpenAlex("q", 3);
    expect(calls).toBe(2);
    expect(results.map((r) => r.title)).toContain("OpenAlex Paper One");
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(750);
    expect(delays[0]).toBeLessThanOrEqual(1250);
  });

  it("does not retry non-retryable OpenAlex errors", async () => {
    let calls = 0;
    const http: FakeHttp = new FakeHttp(() => {
      calls++;
      return http.text(404, "not found");
    });
    const service = new SearchService({ http, maxRetries: 3 });
    await expect(service.searchOpenAlex("q", 3)).rejects.toThrow(
      /OpenAlex HTTP 404/
    );
    expect(calls).toBe(1);
  });

  it("exhausts OpenAlex retries before giving up", async () => {
    let calls = 0;
    const { sleep } = makeSleepRecorder();
    const http: FakeHttp = new FakeHttp(() => {
      calls++;
      return http.text(429, "slow down");
    });
    const service = new SearchService({ http, sleep, maxRetries: 2 });
    await expect(service.searchOpenAlex("q", 3)).rejects.toThrow(
      /OpenAlex HTTP 429/
    );
    expect(calls).toBe(3);
  });

  it("merges both sources, dedups, caps, and reports partial failure", async () => {
    const http: FakeHttp = new FakeHttp((url) => {
      if (url.startsWith(openAlexUrl())) return http.text(500, "boom");
      if (url.startsWith(s2Url())) return http.json(200, S2_PAYLOAD);
      throw new Error("unexpected " + url);
    });
    const { sleep } = makeSleepRecorder();
    const service = new SearchService({ http, sleep, maxRetries: 0 });
    const outcome = await service.search(["topic"], 10);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].source).toBe("openalex");
    expect(outcome.results.map((r) => r.source)).toEqual([
      "semanticscholar",
      "semanticscholar",
    ]);
    expect(outcome.results.every((r) => r.title.length > 0)).toBe(true);
  });

  it("enforces the cap across merged interleaved sources before any LLM call", async () => {
    const many = (n: number) => ({
      results: Array.from({ length: n }, (_, i) => ({
        id: `W${i}`,
        display_name: `OA Work ${i}`,
        publication_year: 2020 + i,
      })),
    });
    const http: FakeHttp = new FakeHttp((url) => {
      if (url.startsWith(openAlexUrl())) return http.json(200, many(8));
      if (url.startsWith(s2Url())) return http.json(200, S2_PAYLOAD);
      throw new Error("unexpected");
    });
    const service = new SearchService({ http, maxRetries: 0 });
    const outcome = await service.search(["t"], 6);
    expect(outcome.results).toHaveLength(6);
  });

  it("passes mailto for OpenAlex polite pool and api key for S2", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, { results: [], data: [] }));
    const service = new SearchService({ http, maxRetries: 0 });
    await service.search(["t"], 5, {
      openAlexEmail: "me@example.com",
      s2ApiKey: "key-123",
    });
    expect(http.requests[0].url).toContain("mailto=me%40example.com");
    expect(http.requests[1].options?.headers?.["x-api-key"]).toBe("key-123");
  });
});

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function oaPayload(search: string, count: number): unknown {
  return {
    results: Array.from({ length: count }, (_, i) => ({
      id: `https://openalex.org/W-${slug(search)}-${i}`,
      doi: `https://doi.org/10.1/${slug(search)}-${i}`,
      display_name: `OA ${search} #${i}`,
      publication_year: 2020 + i,
    })),
  };
}

function s2Payload(query: string): unknown {
  return {
    data: Array.from({ length: 2 }, (_, i) => ({
      paperId: `s2-${slug(query)}-${i}`,
      title: `S2 ${query} #${i}`,
      publicationDate: "2021-01-01",
      externalIds: {},
    })),
  };
}

interface QueryPlan {
  oaCounts?: Record<string, number>;
  oaFail?: string[];
  s2Fail?: boolean;
}

function makeQueryHttp(plan: QueryPlan): FakeHttp {
  return new FakeHttp((url) => {
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    if (url.startsWith(openAlexUrl())) {
      const search = params.get("search") ?? "";
      if (plan.oaFail?.includes(search)) return { status: 500, text: "boom" };
      return {
        status: 200,
        text: JSON.stringify(oaPayload(search, plan.oaCounts?.[search] ?? 2)),
      };
    }
    if (url.startsWith(s2Url())) {
      const query = params.get("query") ?? "";
      if (plan.s2Fail) return { status: 500, text: "boom" };
      return { status: 200, text: JSON.stringify(s2Payload(query)) };
    }
    throw new Error("unexpected " + url);
  });
}

function searchParamsOf(http: FakeHttp, base: string): string[] {
  return http.requests
    .filter((r) => r.url.startsWith(base))
    .map((r) => new URLSearchParams(r.url.slice(r.url.indexOf("?") + 1)).get("search") ?? "");
}

function s2QueriesOf(http: FakeHttp): string[] {
  return http.requests
    .filter((r) => r.url.startsWith(s2Url()))
    .map((r) => new URLSearchParams(r.url.slice(r.url.indexOf("?") + 1)).get("query") ?? "");
}

describe("SearchService multi-topic orchestration", () => {
  const TOPICS = ["alpha", "beta", "gamma", "delta", "epsilon"];

  function makeService(plan: QueryPlan, sleep?: (ms: number) => Promise<void>) {
    const http = makeQueryHttp(plan);
    const service = new SearchService({
      http,
      sleep: sleep ?? (async () => undefined),
      maxRetries: 0,
    });
    return { http, service };
  }

  it("paces OpenAlex launches in batches of five", async () => {
    const topics = Array.from({ length: 12 }, (_, i) => `topic${i}`);
    const { sleep, delays } = makeSleepRecorder();
    const { http, service } = makeService({}, sleep);
    await service.search(topics, 10);
    const oaCount = searchParamsOf(http, openAlexUrl()).length;
    expect(oaCount).toBe(13);
    expect(delays.filter((d) => d === OA_BATCH_PAUSE_MS)).toHaveLength(2);
    expect(delays.filter((d) => d === S2_SPACING_MS)).toHaveLength(4);
  });

  it("queries each topic, each group, and the bridge pair on OpenAlex", async () => {
    const { http, service } = makeService({});
    await service.search(TOPICS, 10, { groups: [["alpha", "beta"]] });
    const oa = searchParamsOf(http, openAlexUrl());
    const expected = new Set([
      ...TOPICS,
      "alpha beta",
      (pickBridgePair(TOPICS, 0) as string[]).join(" "),
    ]);
    expect(oa).toHaveLength(expected.size);
    for (const query of expected) expect(oa).toContain(query);
    for (const r of http.requests.filter((req) => req.url.startsWith(openAlexUrl()))) {
      expect(new URLSearchParams(r.url.slice(r.url.indexOf("?") + 1)).get("per_page")).toBe(
        String(RESULTS_PER_QUERY)
      );
    }
  });

  it("rotates the S2 solo subset with the rotation counter", async () => {
    const { http, service } = makeService({});
    await service.search(TOPICS, 10, { rotation: 0 });
    await service.search(TOPICS, 10, { rotation: 1 });
    const queries = s2QueriesOf(http);
    const solo = (list: string[]) => list.filter((q) => !q.includes(" "));
    expect(solo(queries.slice(0, S2_SOLO_BUDGET)).sort()).toEqual(
      ["alpha", "beta", "gamma", "delta"].sort()
    );
    expect(solo(queries.slice(S2_SOLO_BUDGET + 1, S2_SOLO_BUDGET * 2 + 1)).sort()).toEqual(
      ["alpha", "beta", "gamma", "epsilon"].sort()
    );
  });

  it("gives every topic S2 coverage when few enough for the budget", async () => {
    const { http, service } = makeService({});
    await service.search(["a", "b", "c"], 10);
    const solo = s2QueriesOf(http).filter((q) => !q.includes(" "));
    expect(solo.sort()).toEqual(["a", "b", "c"]);
  });

  it("spaces consecutive S2 calls by the rate-limit interval", async () => {
    const { sleep, delays } = makeSleepRecorder();
    const http = makeQueryHttp({});
    const service = new SearchService({ http, sleep, maxRetries: 0 });
    await service.search(TOPICS, 10);
    expect(delays.filter((d) => d === S2_SPACING_MS)).toEqual(
      Array.from({ length: S2_SOLO_BUDGET }, () => S2_SPACING_MS)
    );
  });

  it("reports zero-result groups and bridge pairs as connections", async () => {
    const bridge = pickBridgePair(TOPICS, 0) as string[];
    const { service } = makeService({
      oaCounts: {
        "beta gamma": 0,
        [bridge.join(" ")]: 0,
      },
    });
    const outcome = await service.search(TOPICS, 10, {
      groups: [["beta", "gamma"]],
    });
    const multi = outcome.connections.filter((c) => c.topics.length >= 2);
    expect(multi).toHaveLength(2);
    for (const c of multi) expect(c.found).toBe(0);
    const groupEntry = multi.find((c) => c.topics.join("|") === "beta|gamma");
    expect(groupEntry).toBeDefined();
    const bridgeEntry = multi.find((c) => c.topics.join("|") === bridge.join("|"));
    expect(bridgeEntry).toBeDefined();
    expect(outcome.connections.every((c) => c.topics.length >= 2)).toBe(true);
  });

  it("keeps searching when one OpenAlex query fails and aggregates the error", async () => {
    const { service } = makeService({ oaFail: ["gamma"] });
    const outcome = await service.search(TOPICS, 10);
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].source).toBe("openalex");
    expect(outcome.errors[0].message).toContain("1 of");
  });

  it("caps merged results and samples distinct queries in the top slice", async () => {
    const topics = ["t0", "t1", "t2", "t3", "t4", "t5"];
    const { service } = makeService({});
    const outcome = await service.search(topics, 5);
    expect(outcome.results).toHaveLength(5);
    expect(new Set(outcome.results.map((r) => r.title)).size).toBe(5);
  });

  it("truncates over-long queries before sending", async () => {
    const longTopic = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const { http, service } = makeService({});
    await service.search([longTopic], 5);
    const oa = searchParamsOf(http, openAlexUrl());
    const s2 = s2QueriesOf(http);
    for (const query of [...oa, ...s2]) {
      expect(query.length).toBeLessThanOrEqual(QUERY_MAX_LENGTH);
    }
  });

  it("uses a single query and no bridge for one topic", async () => {
    const { http, service } = makeService({});
    const { sleep, delays } = makeSleepRecorder();
    void sleep;
    const outcome = await service.search(["solo"], 5);
    expect(searchParamsOf(http, openAlexUrl())).toEqual(["solo"]);
    expect(s2QueriesOf(http)).toEqual(["solo"]);
    expect(outcome.connections).toEqual([]);
    expect(delays).toEqual([]);
  });

  it("omits singleton groups from multi-topic queries", async () => {
    const { http, service } = makeService({});
    const outcome = await service.search(["a", "b"], 10, {
      groups: [["a"], ["b"]],
    });
    const oa = searchParamsOf(http, openAlexUrl());
    expect(oa.filter((q) => q.includes(" "))).toHaveLength(1);
    expect(outcome.connections).toHaveLength(1);
  });
});

describe("paper id extraction", () => {
  it("extracts DOIs from bare forms and doi.org URLs", () => {
    expect(extractDoi("10.1234/abc.def")).toBe("10.1234/abc.def");
    expect(extractDoi("  https://doi.org/10.1234/Xyz_1  ")).toBe(
      "10.1234/xyz_1"
    );
    expect(extractDoi("http://dx.doi.org/10.1/x")).toBe("10.1/x");
    expect(extractDoi("https://arxiv.org/abs/2106.15931")).toBeNull();
    expect(extractDoi("not a doi")).toBeNull();
  });

  it("extracts arXiv ids from abs/pdf URLs and bare ids", () => {
    expect(extractArxivId("https://arxiv.org/abs/2106.15931v2")).toBe(
      "2106.15931"
    );
    expect(extractArxivId("https://arxiv.org/pdf/2106.15931.pdf")).toBe(
      "2106.15931"
    );
    expect(extractArxivId("2106.15931")).toBe("2106.15931");
    expect(extractArxivId("https://doi.org/10.1/x")).toBeNull();
    expect(extractArxivId("random text")).toBeNull();
  });
});

const S2_PAPER_URL = "https://api.semanticscholar.org/graph/v1/paper/";
const S2_RECOMMEND_URL =
  "https://api.semanticscholar.org/recommendations/v1/papers/";

function s2PaperPayload(): unknown {
  return {
    paperId: "s2-resolved",
    title: "Resolved Paper",
    publicationDate: "2020-01-01",
    abstract: "An abstract.",
    externalIds: { DOI: "10.5555/resolved" },
    authors: [{ name: "Ada Lovelace" }],
  };
}

describe("resolvePaper", () => {
  it("resolves a DOI through the S2 paper endpoint first", async () => {
    const http: FakeHttp = new FakeHttp((url) => {
      if (!url.startsWith(S2_PAPER_URL)) throw new Error("unexpected " + url);
      expect(url).toContain("/DOI:10.1234/abc");
      expect(url).toContain("fields=");
      return http.json(200, s2PaperPayload());
    });
    const service = new SearchService({ http, maxRetries: 0 });
    const suggestion = await service.resolvePaper("10.1234/ABC");
    expect(suggestion.title).toBe("Resolved Paper");
    expect(suggestion.url).toBe("https://doi.org/10.5555/resolved");
    expect(suggestion.s2Id).toBe("s2-resolved");
    expect(suggestion.doi).toBe("10.5555/resolved");
  });

  it("resolves arXiv URLs through the S2 ArXiv id", async () => {
    const http: FakeHttp = new FakeHttp((url) => {
      expect(url).toContain("/ArXiv:2106.15931");
      return http.json(200, s2PaperPayload());
    });
    const service = new SearchService({ http, maxRetries: 0 });
    const suggestion = await service.resolvePaper(
      "https://arxiv.org/abs/2106.15931v3"
    );
    expect(suggestion.title).toBe("Resolved Paper");
  });

  it("falls back to OpenAlex by DOI when S2 lookups fail", async () => {
    const http: FakeHttp = new FakeHttp((url) => {
      if (url.startsWith(S2_PAPER_URL)) return http.text(500, "boom");
      if (url.startsWith("https://api.openalex.org/works/doi:")) {
        return http.json(200, OPENALEX_PAYLOAD.results[0]);
      }
      throw new Error("unexpected " + url);
    });
    const service = new SearchService({ http, maxRetries: 0 });
    const suggestion = await service.resolvePaper("https://doi.org/10.5555/openalex-1");
    expect(suggestion.title).toBe("OpenAlex Paper One");
    expect(suggestion.oaId).toBe("W1");
  });

  it("stubs a suggestion when an unindexed URL is not found anywhere", async () => {
    const http: FakeHttp = new FakeHttp((url) => {
      expect(url).toContain("/URL:https%3A%2F%2Fexample.com%2Fsome-paper");
      return http.text(404, "not found");
    });
    const service = new SearchService({ http, maxRetries: 0 });
    const suggestion = await service.resolvePaper("https://example.com/some-paper");
    expect(suggestion.url).toBe("https://example.com/some-paper");
    expect(suggestion.title).toBe("some paper");
    expect(suggestion.abstract).toBe("");
  });

  it("returns null from fetchOpenAlexWorkByDoi on 404", async () => {
    const http: FakeHttp = new FakeHttp(() => http.text(404, "nope"));
    const service = new SearchService({ http, maxRetries: 0 });
    expect(await service.fetchOpenAlexWorkByDoi("10.1/missing")).toBeNull();
  });
});

describe("related-work lookups", () => {
  it("queries OpenAlex with a union cites filter and relevance sorting", async () => {
    const http: FakeHttp = new FakeHttp((url) => {
      const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      expect(params.get("filter")).toBe("cites:W1|W2");
      expect(params.get("sort")).toBe("cited_by_count:desc");
      expect(params.get("per_page")).toBe(String(RELATED_OA_LIMIT));
      expect(params.get("mailto")).toBe("me@example.com");
      return http.json(200, OPENALEX_PAYLOAD);
    });
    const service = new SearchService({ http, maxRetries: 0 });
    const results = await service.searchOpenAlexCiting(["W1", "W2"], RELATED_OA_LIMIT, "me@example.com");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.origin === "related")).toBe(true);
    expect(results[0].oaId).toBe("W1");
  });

  it("posts recommendations with positive and negative paper ids", async () => {
    const http: FakeHttp = new FakeHttp((url, options) => {
      expect(url.startsWith(S2_RECOMMEND_URL)).toBe(true);
      expect(options?.method).toBe("POST");
      expect(options?.headers?.["x-api-key"]).toBe("key-1");
      const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      expect(params.get("limit")).toBe(String(RELATED_S2_LIMIT));
      const body = JSON.parse(options?.body ?? "{}") as {
        positivePaperIds: string[];
        negativePaperIds: string[];
      };
      expect(body.positivePaperIds).toEqual(["s2pin", "DOI:10.1/pin"]);
      expect(body.negativePaperIds).toEqual(["DOI:10.1/bad"]);
      return http.json(200, { recommendedPapers: [s2PaperPayload()] });
    });
    const service = new SearchService({ http, maxRetries: 0 });
    const results = await service.recommendFromPins(
      ["s2pin", "DOI:10.1/pin"],
      ["DOI:10.1/bad"],
      RELATED_S2_LIMIT,
      "key-1"
    );
    expect(results).toHaveLength(1);
    expect(results[0].origin).toBe("related");
    expect(results[0].s2Id).toBe("s2-resolved");
  });

  it("fills missing OpenAlex ids for pins that carry a DOI", async () => {
    const { sleep, delays } = makeSleepRecorder();
    const http: FakeHttp = new FakeHttp((url) => {
      expect(url).toContain("/doi:10.5555/openalex-1");
      return http.json(200, OPENALEX_PAYLOAD.results[1]);
    });
    const service = new SearchService({ http, sleep, maxRetries: 0 });
    const pins: Suggestion[] = [
      makePin({ doi: "10.5555/openalex-1" }),
      makePin({ oaId: "W9" }),
      makePin({}),
    ];
    await service.resolveOpenAlexIds(pins);
    expect(pins[0].oaId).toBe("W2");
    expect(pins[1].oaId).toBe("W9");
    expect(pins[2].oaId).toBeUndefined();
    expect(delays).toEqual([]);
  });

  it("keeps going when a pin id resolution fails", async () => {
    const http: FakeHttp = new FakeHttp(() => http.text(429, "slow"));
    const service = new SearchService({ http, maxRetries: 0 });
    const pins: Suggestion[] = [makePin({ doi: "10.1/a" })];
    await expect(service.resolveOpenAlexIds(pins)).resolves.toBeUndefined();
    expect(pins[0].oaId).toBeUndefined();
  });
});

function makePin(overrides: Partial<Suggestion>): Suggestion {
  return {
    url: "https://doi.org/10.1/pin",
    title: "Pinned Paper",
    authors: [],
    publisher: "",
    year: 2020,
    date: "",
    abstract: "Pinned abstract.",
    oaUrl: "",
    source: "openalex",
    ...overrides,
  };
}

describe("SearchService pin-aware search", () => {
  function makeRelatedService(plan: {
    citesFail?: boolean;
    recsFail?: boolean;
  }) {
    const http: FakeHttp = new FakeHttp((url) => {
      const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      if (url.startsWith(S2_RECOMMEND_URL)) {
        if (plan.recsFail) return http.text(500, "boom");
        return http.json(200, {
          recommendedPapers: [
            { paperId: "s2rec", title: "Recommended Work", publicationDate: "2024-01-01" },
          ],
        });
      }
      if (url.startsWith(s2Url())) return http.json(200, S2_PAYLOAD);
      if (url.startsWith(S2_PAPER_URL)) return http.text(404, "not found");
      if (url.startsWith(openAlexUrl())) {
        if (params.get("filter")?.startsWith("cites:")) {
          if (plan.citesFail) return http.text(500, "boom");
          return http.json(200, {
            results: [
              {
                id: "https://openalex.org/W77",
                display_name: "Citing Work",
                publication_year: 2024,
              },
            ],
          });
        }
        return http.json(200, {
          results: [
            {
              id: "https://openalex.org/W50",
              display_name: "OA Topic Work",
              publication_year: 2020,
            },
          ],
        });
      }
      throw new Error("unexpected " + url);
    });
    const service = new SearchService({
      http,
      sleep: async () => undefined,
      maxRetries: 0,
    });
    return { http, service };
  }

  it("adds related results from both sources and excludes known urls", async () => {
    const { http, service } = makeRelatedService({});
    const outcome = await service.search(["topic"], 10, {
      relatedPins: [makePin({ oaId: "W9", s2Id: "s2pin" })],
      dismissedPins: [makePin({ url: "https://doi.org/10.1/bad", doi: "10.1/bad" })],
      excludeUrls: ["https://doi.org/10.5555/openalex-1"],
    });
    const citesCalls = http.requests.filter((r) =>
      r.url.includes("filter=cites")
    );
    expect(citesCalls).toHaveLength(1);
    expect(citesCalls[0].url).toContain("cites%3AW9");
    const recCalls = http.requests.filter((r) => r.url.startsWith(S2_RECOMMEND_URL));
    expect(recCalls).toHaveLength(1);
    const body = JSON.parse(recCalls[0].options?.body ?? "{}") as {
      positivePaperIds: string[];
      negativePaperIds: string[];
    };
    expect(body.positivePaperIds).toEqual(["s2pin"]);
    expect(body.negativePaperIds).toEqual(["DOI:10.1/bad"]);
    const related = outcome.results.filter((r) => r.origin === "related");
    expect(related.map((r) => r.title)).toEqual(
      expect.arrayContaining(["Citing Work", "Recommended Work"])
    );
    expect(outcome.results.some((r) => r.title === "OA Topic Work")).toBe(true);
    expect(outcome.errors).toEqual([]);
  });

  it("surfaces related lookup failures without failing the search", async () => {
    const { service } = makeRelatedService({ citesFail: true, recsFail: true });
    const outcome = await service.search(["topic"], 10, {
      relatedPins: [makePin({ oaId: "W9", s2Id: "s2pin" })],
    });
    expect(outcome.results.some((r) => r.title === "OA Topic Work")).toBe(true);
    expect(outcome.errors.map((e) => e.source).sort()).toEqual([
      "openalex",
      "semanticscholar",
    ]);
    expect(outcome.errors[0].message).toContain("Related-work");
  });

  it("makes no related calls without pins", async () => {
    const { http, service } = makeRelatedService({});
    await service.search(["topic"], 10);
    expect(http.requests.filter((r) => r.url.startsWith(S2_RECOMMEND_URL))).toHaveLength(0);
    expect(http.requests.filter((r) => r.url.includes("filter=cites"))).toHaveLength(0);
  });

  it("skips the OpenAlex citations call when no pin has an OpenAlex id", async () => {
    const { http, service } = makeRelatedService({});
    await service.search(["topic"], 10, {
      relatedPins: [makePin({ s2Id: "s2pin", doi: "10.1/gone" })],
    });
    expect(http.requests.filter((r) => r.url.includes("filter=cites"))).toHaveLength(0);
    const doiCalls = http.requests.filter((r) => r.url.includes("/doi:"));
    expect(doiCalls).toHaveLength(1);
    const recCalls = http.requests.filter((r) => r.url.startsWith(S2_RECOMMEND_URL));
    expect(recCalls).toHaveLength(1);
  });
});
