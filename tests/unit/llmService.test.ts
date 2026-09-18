import { describe, expect, it } from "vitest";
import {
  applyBuckets,
  FEEDBACK_BUDGET,
  LLMService,
  LLMServiceError,
  parseGroups,
  sampleFeedback,
  stripThink,
} from "../../src/services/LLMService";
import { FakeHttp } from "../helpers";
import type { DocumentResearchData, Suggestion } from "../../src/types";

const CONFIG = {
  endpoint: "http://localhost:11434/v1",
  apiKey: "secret",
  model: "llama3.2",
  format: "openai",
} as const;

const FOCUS = { topics: ["t"], document: "The document argues that grammar matters." };

function chatBody(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

function makeS(url: string, title = url): Suggestion {
  return {
    url,
    title,
    authors: [],
    publisher: "",
    year: null,
    date: "",
    abstract: `Abstract of ${title}`,
    oaUrl: "",
    source: "openalex",
  };
}

function makeRecord(
  suggestions: Suggestion[],
  pinned: string[],
  dismissed: string[]
): DocumentResearchData {
  return {
    id: "r",
    notePath: "notes/R.md",
    noteTitle: "R",
    manualTopics: ["t"],
    pinned,
    dismissed,
    dismissedTopics: [],
    searchCount: 0,
    suggestions,
  };
}

describe("chat plumbing", () => {
  it("appends /chat/completions and sends auth + model", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody("ok")));
    const llm = new LLMService(http);
    await llm.summarize(FOCUS, makeS("u"), CONFIG);
    const req = http.requests[0];
    expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(req.options?.headers?.["Authorization"]).toBe("Bearer secret");
    const body = JSON.parse(req.options!.body!);
    expect(body.model).toBe("llama3.2");
    expect(typeof body.messages[0].content).toBe("string");
  });

  it("normalizes trailing slashes and pre-suffixed endpoints", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody("ok")));
    const llm = new LLMService(http);
    await llm.summarize(FOCUS, makeS("u"), {
      ...CONFIG,
      endpoint: "https://api.example.com/v1/chat/completions/",
    });
    expect(http.requests[0].url).toBe(
      "https://api.example.com/v1/chat/completions"
    );
  });

  it("throws a typed error on non-200 responses", async () => {
    const http: FakeHttp = new FakeHttp(() => http.text(502, "bad gateway"));
    const llm = new LLMService(http);
    await expect(llm.extractTopics("text", CONFIG)).rejects.toBeInstanceOf(
      LLMServiceError
    );
  });

  it("throws on malformed JSON bodies", async () => {
    const http: FakeHttp = new FakeHttp(() => http.text(200, "<html>oops</html>"));
    const llm = new LLMService(http);
    await expect(llm.extractTopics("text", CONFIG)).rejects.toThrow(
      /malformed/i
    );
  });

  it("throws when endpoint is empty", async () => {
    const llm = new LLMService(new FakeHttp(() => {
      throw new Error("network must not be touched");
    }));
    await expect(
      llm.extractTopics("t", { endpoint: "", model: "m", format: "openai" })
    ).rejects.toThrow(/not configured/);
  });

  it("ping sends a one-word prompt and returns trimmed text", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody(" OK ")));
    const llm = new LLMService(http);
    const reply = await llm.ping(CONFIG);
    expect(reply).toBe("OK");
    const body = JSON.parse(http.requests[0].options!.body!);
    expect(body.messages[0].content).toContain("OK");
  });
});

describe("scoreBatch parsing", () => {
  it("parses messy output; invalid or missing lines default to low", async () => {
    const messy = [
      "Sure! Here are the ratings:",
      "",
      "1 - HIGH",
      "2: medium",
      "some commentary line without a number",
      "3. Low",
      "4: bogus-value",
    ].join("\n");
    const http: FakeHttp = new FakeHttp((url) => {
      if (url.includes("chat/completions"))
        return http.json(200, chatBody(messy));
      throw new Error("unexpected url");
    });
    const llm = new LLMService(http);
    const candidates = [makeS("a"), makeS("b"), makeS("c"), makeS("d")];
    const buckets = await llm.scoreBatch(
      { topics: ["topic"], document: FOCUS.document },
      candidates,
      CONFIG
    );
    expect(buckets.get("a")).toBe("high");
    expect(buckets.get("b")).toBe("medium");
    expect(buckets.get("c")).toBe("low");
    expect(buckets.get("d")).toBe("low");
  });

  it("defaults every candidate to low for an empty response", () => {
    const result = new Map<string, "high" | "medium" | "low">();
    const candidates = [makeS("x"), makeS("y")];
    for (const c of candidates) result.set(c.url, "low");
    applyBuckets("", candidates, result);
    expect(result.get("x")).toBe("low");
    expect(result.get("y")).toBe("low");
  });

  it("ignores out-of-range candidate numbers", () => {
    const result = new Map<string, "high" | "medium" | "low">();
    const candidates = [makeS("x")];
    for (const c of candidates) result.set(c.url, "low");
    applyBuckets("9: high", candidates, result);
    expect(result.get("x")).toBe("low");
  });
});

describe("extractTopics parsing", () => {
  it("splits commas/newlines, strips bullets and quotes, dedupes, caps at 8", async () => {
    const raw = `- NLP, machine learning\n"deep learning"\n'NLP'\nML\nt1,t2,t3,t4,t5,t6`;
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody(raw)));
    const llm = new LLMService(http);
    const topics = await llm.extractTopics("doc text", CONFIG);
    expect(topics).toEqual([
      "NLP",
      "machine learning",
      "deep learning",
      "ML",
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  });

  it("summarize strips wrapping quotes", async () => {
    const http: FakeHttp = new FakeHttp(() =>
      http.json(200, chatBody('"This is relevant because."'))
    );
    const llm = new LLMService(http);
    const summary = await llm.summarize(FOCUS, makeS("u"), CONFIG);
    expect(summary).toBe("This is relevant because.");
  });
});

describe("relevance scoring prompts", () => {
  it("scoreBatch sends the document excerpt and content-based rubric", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody("1: high")));
    const llm = new LLMService(http);
    await llm.scoreBatch(FOCUS, [makeS("a")], CONFIG);
    const content = JSON.parse(http.requests[0].options!.body!).messages[0]
      .content as string;
    expect(content).toContain("The document argues that grammar matters.");
    expect(content).toContain("research document in progress");
    expect(content).toContain("Do not stretch to find connections");
    expect(content).toContain("including directly opposing views");
    expect(content).toContain("Keyword overlap alone is never more than low");
    expect(content).toContain("Extracted topics (secondary hint only): t");
  });

  it("scoreSingle parses a single rating line", async () => {
    const http: FakeHttp = new FakeHttp(() =>
      http.json(200, chatBody("<think>hmm let me consider…</think>\n1: MEDIUM"))
    );
    const llm = new LLMService(http);
    const bucket = await llm.scoreSingle(FOCUS, makeS("a"), CONFIG);
    expect(bucket).toBe("medium");
    expect(http.requests[0].url).toContain("chat/completions");
  });

  it("summarize frames relevance against the document", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody("because.")));
    const llm = new LLMService(http);
    await llm.summarize(FOCUS, makeS("u"), CONFIG);
    const content = JSON.parse(http.requests[0].options!.body!).messages[0]
      .content as string;
    expect(content).toContain("what the document excerpt below is actually about");
    expect(content).toContain("say so plainly");
    expect(content).toContain("The document argues that grammar matters.");
  });

  it("stripThink removes closed think blocks and falls back to raw text", () => {
    expect(stripThink("<think>chain of thought</think>answer here")).toBe(
      "answer here"
    );
    expect(stripThink("A: high")).toBe("A: high");
    expect(stripThink("<think>never closed, answer inside")).toBe(
      "<think>never closed, answer inside"
    );
  });
});

describe("provider formats", () => {
  it("omits temperature when unset and sends it when configured", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody("ok")));
    const llm = new LLMService(http);
    await llm.extractTopics("doc", { ...CONFIG, temperature: undefined });
    let body = JSON.parse(http.requests[0].options!.body!);
    expect("temperature" in body).toBe(false);
    await llm.extractTopics("doc", { ...CONFIG, temperature: 0.4 });
    body = JSON.parse(http.requests[1].options!.body!);
    expect(body.temperature).toBe(0.4);
  });

  it("anthropic format posts to /v1/messages with anthropic headers", async () => {
    const http: FakeHttp = new FakeHttp(() =>
      http.json(
        200,
        {
          content: [
            { type: "text", text: "neural networks, transformers" },
          ],
          stop_reason: "end_turn",
        }
      )
    );
    const llm = new LLMService(http);
    const topics = await llm.extractTopics("doc", {
      ...CONFIG,
      format: "anthropic",
      endpoint: "https://api.anthropic.com",
    });
    expect(topics).toEqual(["neural networks", "transformers"]);
    const req = http.requests[0];
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.options?.headers?.["x-api-key"]).toBe("secret");
    expect(req.options?.headers?.["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(req.options!.body!);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(typeof body.messages[0].content).toBe("string");
  });

  it("anthropic format ignores thinking blocks and reports truncation", async () => {
    let calls = 0;
    const http: FakeHttp = new FakeHttp(() => {
      calls++;
      if (calls === 1) {
        return http.json(200, {
          content: [
            { type: "thinking", text: "internal reasoning" },
            { type: "text", text: "1: high" },
          ],
          stop_reason: "end_turn",
        });
      }
      return http.json(200, {
        content: [{ type: "thinking", text: "reasoned forever" }],
        stop_reason: "max_tokens",
      });
    });
    const llm = new LLMService(http);
    const bucket = await llm.scoreSingle(
      FOCUS,
      makeS("a"),
      { ...CONFIG, format: "anthropic" }
    );
    expect(bucket).toBe("high");
    await expect(
      llm.extractTopics("doc", { ...CONFIG, format: "anthropic" })
    ).rejects.toThrow(/max_tokens/);
  });
});

describe("parseGroups", () => {
  const TOPICS = ["machine learning", "neural networks", "quantum computing", "biology", "history"];

  it("groups mentioned topics and turns the rest into singles", () => {
    const groups = parseGroups(
      "machine learning, neural networks\nquantum computing",
      TOPICS
    );
    expect(groups).toEqual([
      ["machine learning", "neural networks"],
      ["quantum computing"],
      ["biology"],
      ["history"],
    ]);
  });

  it("strips list markers and group labels", () => {
    const groups = parseGroups(
      "- machine learning, neural networks\nGroup 2: quantum computing\n* biology",
      TOPICS
    );
    expect(groups).toEqual([
      ["machine learning", "neural networks"],
      ["quantum computing"],
      ["biology"],
      ["history"],
    ]);
  });

  it("matches topics case-insensitively and drops unknown tokens", () => {
    const groups = parseGroups(
      "Machine Learning, neural networks, invented topic\nHistory",
      TOPICS
    );
    expect(groups).toEqual([
      ["machine learning", "neural networks"],
      ["history"],
      ["quantum computing"],
      ["biology"],
    ]);
  });

  it("never assigns a topic twice", () => {
    const groups = parseGroups(
      "machine learning\nmachine learning, neural networks",
      TOPICS
    );
    expect(groups).toEqual([
      ["machine learning"],
      ["neural networks"],
      ["quantum computing"],
      ["biology"],
      ["history"],
    ]);
  });

  it("falls back to all singles for empty or garbage output", () => {
    expect(parseGroups("", TOPICS)).toEqual(TOPICS.map((t) => [t]));
    expect(parseGroups("no recognizable topics here at all", TOPICS)).toEqual(
      TOPICS.map((t) => [t])
    );
  });

  it("sends a grouping prompt and returns parsed groups", async () => {
    const raw = "machine learning, neural networks\nquantum computing\nbiology\nhistory";
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody(raw)));
    const llm = new LLMService(http);
    const groups = await llm.clusterTopics(TOPICS, CONFIG);
    expect(groups).toEqual([
      ["machine learning", "neural networks"],
      ["quantum computing"],
      ["biology"],
      ["history"],
    ]);
    const body = JSON.parse(http.requests[0].options!.body!);
    expect(body.messages[0].content).toContain("Group these research topics");
    expect(body.messages[0].content).toContain("machine learning");
  });

  it("skips the LLM entirely for a single topic", async () => {
    const http: FakeHttp = new FakeHttp(() => {
      throw new Error("network must not be touched");
    });
    const llm = new LLMService(http);
    const groups = await llm.clusterTopics(["solo topic"], CONFIG);
    expect(groups).toEqual([["solo topic"]]);
    expect(http.requests).toHaveLength(0);
  });
});

describe("sampleFeedback", () => {
  const SUGGESTIONS = Array.from({ length: 8 }, (_, i) => makeS(`u${i}`));
  const PINNED = SUGGESTIONS.map((s) => s.url);
  const DISMISSED = ["u0", "u1", "u2"];

  it("caps each list at the feedback budget", () => {
    const record = makeRecord(SUGGESTIONS, PINNED, DISMISSED);
    const feedback = sampleFeedback(record, 0);
    expect(feedback.pinnedExamples).toHaveLength(FEEDBACK_BUDGET);
    expect(feedback.dismissedExamples).toHaveLength(3);
    expect(feedback.pinnedExamples.every((s) => PINNED.includes(s.url))).toBe(true);
  });

  it("is deterministic per rotation and varies across rotations", () => {
    const record = makeRecord(SUGGESTIONS, PINNED, []);
    const first = sampleFeedback(record, 0);
    expect(sampleFeedback(record, 0).pinnedExamples.map((s) => s.url)).toEqual(
      first.pinnedExamples.map((s) => s.url)
    );
    const second = sampleFeedback(record, 1);
    expect(second.pinnedExamples.map((s) => s.url)).not.toEqual(
      first.pinnedExamples.map((s) => s.url)
    );
  });

  it("excludes a url and skips urls without stored suggestions", () => {
    const record = makeRecord(SUGGESTIONS, [...PINNED, "gone"], ["u3"]);
    const feedback = sampleFeedback(record, 0, "u0");
    expect(feedback.pinnedExamples.some((s) => s.url === "u0")).toBe(false);
    expect(feedback.pinnedExamples.some((s) => s.url === "gone")).toBe(false);
    expect(feedback.dismissedExamples.map((s) => s.url)).toEqual(["u3"]);
  });

  it("returns empty lists when there is no history", () => {
    const record = makeRecord(SUGGESTIONS, [], []);
    const feedback = sampleFeedback(record, 0);
    expect(feedback.pinnedExamples).toEqual([]);
    expect(feedback.dismissedExamples).toEqual([]);
  });
});

describe("feedback in scoring prompts", () => {
  it("scoreBatch includes pinned and dismissed exemplars", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody("1: low")));
    const llm = new LLMService(http);
    await llm.scoreBatch(
      {
        ...FOCUS,
        pinnedExamples: [makeS("pin1", "Kept Paper")],
        dismissedExamples: [makeS("drop1", "Dropped Paper")],
      },
      [makeS("a")],
      CONFIG
    );
    const content = JSON.parse(http.requests[0].options!.body!).messages[0]
      .content as string;
    expect(content).toContain("own judgments from earlier searches");
    expect(content).toContain("Pinned as relevant");
    expect(content).toContain("Kept Paper");
    expect(content).toContain("Dismissed as irrelevant");
    expect(content).toContain("Dropped Paper");
    expect(content).toContain("rate similar candidates low");
  });

  it("omits the feedback section when no examples are given", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody("1: low")));
    const llm = new LLMService(http);
    await llm.scoreBatch(FOCUS, [makeS("a")], CONFIG);
    const content = JSON.parse(http.requests[0].options!.body!).messages[0]
      .content as string;
    expect(content).not.toContain("own judgments from earlier searches");
  });

  it("scoreSingle includes feedback exemplars too", async () => {
    const http: FakeHttp = new FakeHttp(() => http.json(200, chatBody("1: high")));
    const llm = new LLMService(http);
    await llm.scoreSingle(
      { ...FOCUS, dismissedExamples: [makeS("d1", "Bad Paper")] },
      makeS("a"),
      CONFIG
    );
    const content = JSON.parse(http.requests[0].options!.body!).messages[0]
      .content as string;
    expect(content).toContain("Dismissed as irrelevant");
    expect(content).toContain("Bad Paper");
  });
});
