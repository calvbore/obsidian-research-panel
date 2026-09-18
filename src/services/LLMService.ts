import type { IHttpAdapter } from "../adapters/types";
import type {
  DocumentResearchData,
  LlmApiFormat,
  RelevanceBucket,
  Suggestion,
} from "../types";
import { seededShuffle } from "./SearchService";

export interface LLMConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  format: LlmApiFormat;
  temperature?: number;
}

const ANTHROPIC_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = "2023-06-01";

function completionsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function messagesUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (/\/messages$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
}

export class LLMServiceError extends Error {}

export interface ScoreFocus {
  topics: string[];
  document: string;
  pinnedExamples?: Suggestion[];
  dismissedExamples?: Suggestion[];
}

export const DOC_FOCUS_MAX_CHARS = 4000;

export const FEEDBACK_BUDGET = 5;
export const FEEDBACK_SNIPPET_CHARS = 200;

export function sampleFeedback(
  record: DocumentResearchData,
  rotation: number,
  excludeUrl?: string
): { pinnedExamples: Suggestion[]; dismissedExamples: Suggestion[] } {
  const byUrl = new Map(
    record.suggestions.map((s) => [s.url, s] as const)
  );
  const collect = (urls: string[], seed: number): Suggestion[] => {
    const items = urls
      .filter((u) => u !== excludeUrl)
      .map((u) => byUrl.get(u))
      .filter((s): s is Suggestion => Boolean(s));
    return seededShuffle(items, seed).slice(0, FEEDBACK_BUDGET);
  };
  return {
    pinnedExamples: collect(record.pinned, rotation + 1),
    dismissedExamples: collect(record.dismissed, rotation + 2),
  };
}

export class LLMService {
  constructor(private readonly http: IHttpAdapter) {}

  private async chat(content: string, config: LLMConfig): Promise<string> {
    if (!config.endpoint) {
      throw new LLMServiceError("LLM endpoint is not configured");
    }
    const raw =
      config.format === "anthropic"
        ? await this.chatAnthropic(content, config)
        : await this.chatOpenAI(content, config);
    const final = stripThink(raw);
    if (!final.trim()) {
      throw new LLMServiceError(
        "LLM returned no usable text (it may have produced only reasoning). Try a non-thinking model or disable thinking."
      );
    }
    return final;
  }

  private async chatOpenAI(content: string, config: LLMConfig): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: "user", content }],
    };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    const res = await this.http.request(completionsUrl(config.endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.status !== 200) {
      throw new LLMServiceError(
        `LLM HTTP ${res.status}: ${res.text.slice(0, 200)}`
      );
    }
    let json: ChatResponse;
    try {
      json = JSON.parse(res.text) as ChatResponse;
    } catch (e) {
      throw new LLMServiceError(`LLM returned malformed JSON: ${String(e)}`);
    }
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new LLMServiceError("LLM returned an empty completion");
    return text;
  }

  private async chatAnthropic(content: string, config: LLMConfig): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey ?? "",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: [{ role: "user", content }],
    };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    const res = await this.http.request(messagesUrl(config.endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.status !== 200) {
      throw new LLMServiceError(
        `LLM HTTP ${res.status}: ${res.text.slice(0, 200)}`
      );
    }
    let json: AnthropicResponse;
    try {
      json = JSON.parse(res.text) as AnthropicResponse;
    } catch (e) {
      throw new LLMServiceError(`LLM returned malformed JSON: ${String(e)}`);
    }
    const text = (json.content ?? [])
      .filter((block) => block.type !== "thinking" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (!text) {
      if (json.stop_reason === "max_tokens") {
        throw new LLMServiceError(
          "LLM response was truncated before any text (stop_reason: max_tokens). Try a smaller prompt or a non-thinking model."
        );
      }
      throw new LLMServiceError("LLM returned an empty completion");
    }
    return text;
  }

  async extractTopics(text: string, config: LLMConfig, excludeTopics?: string[]): Promise<string[]> {
    let prompt =
      "Extract 5-8 key research topics from this document as a short comma-separated list. " +
      "Reply with only the comma-separated list.\n\n";
    if (excludeTopics?.length) {
      prompt += `Do NOT include these already-known topics: ${excludeTopics.join(", ")}\n\n`;
    }
    prompt += truncate(text, 12000);
    const raw = await this.chat(prompt, config);
    return parseTopicList(raw);
  }

  async clusterTopics(topics: string[], config: LLMConfig): Promise<string[][]> {
    if (topics.length <= 1) return topics.map((t) => [t]);
    const prompt =
      "Group these research topics by subject similarity. Topics that are " +
      "unrelated to any other topic stay alone on their own line. Reply with " +
      "one group per line, listing that group's topics comma-separated. Use " +
      "each topic verbatim; every topic must appear on exactly one line.\n\n" +
      `Topics: ${topics.join(", ")}`;
    const raw = await this.chat(prompt, config);
    return parseGroups(raw, topics);
  }

  async scoreBatch(
    focus: ScoreFocus,
    candidates: Suggestion[],
    config: LLMConfig
  ): Promise<Map<string, RelevanceBucket>> {
    const result = new Map<string, RelevanceBucket>();
    for (const c of candidates) result.set(c.url, "low");
    if (candidates.length === 0) return result;
    const listing = candidates
      .map(
        (c, i) =>
          `${i + 1}. Title: ${c.title}\n   Abstract snippet: ${truncate(
            c.abstract || "(no abstract available)",
            600
          )}`
      )
      .join("\n");
    const feedback = this.feedbackSection(focus);
    const prompt = [
      "You are helping a researcher find literature for a research document in progress. The excerpt below may be partial.",
      "",
      this.documentSection(focus.document),
      "",
      `Extracted topics (secondary hint only): ${focus.topics.join(", ")}`,
      "",
      this.relevanceRubric(),
      ...(feedback ? ["", feedback] : []),
      "",
      "Respond with one line per candidate in exactly this format:",
      "<number>: <high|medium|low>",
      "",
      "Candidates:",
      listing,
    ].join("\n");
    const raw = await this.chat(prompt, config);
    applyBuckets(raw, candidates, result);
    return result;
  }

  async scoreSingle(
    focus: ScoreFocus,
    candidate: Suggestion,
    config: LLMConfig
  ): Promise<RelevanceBucket> {
    const feedback = this.feedbackSection(focus);
    const prompt = [
      "You are helping a researcher assess one paper against a research document in progress. The excerpt below may be partial.",
      "",
      this.documentSection(focus.document),
      "",
      `Extracted topics (secondary hint only): ${focus.topics.join(", ")}`,
      "",
      this.relevanceRubric(),
      ...(feedback ? ["", feedback] : []),
      "",
      "Respond with exactly one line in this format:",
      "1: <high|medium|low>",
      "",
      "Candidate:",
      `1. Title: ${candidate.title}`,
      `   Abstract snippet: ${truncate(candidate.abstract || "(no abstract available)", 600)}`,
    ].join("\n");
    const raw = await this.chat(prompt, config);
    const result = new Map<string, RelevanceBucket>();
    result.set(candidate.url, "low");
    applyBuckets(raw, [candidate], result);
    return result.get(candidate.url) ?? "low";
  }

  async summarize(
    focus: ScoreFocus,
    candidate: Suggestion,
    config: LLMConfig
  ): Promise<string> {
    const prompt = `In 1-2 concise sentences, explain why this paper is relevant to what the document excerpt below is actually about. Judge what the paper studies, not keyword overlap. If the paper is only tangentially related, say so plainly. Reply with only the explanation.

${this.documentSection(focus.document)}

Extracted topics (secondary hint only): ${focus.topics.join(", ")}

Title: ${candidate.title}
Abstract: ${truncate(candidate.abstract || "(none)", 1500)}`;
    const raw = await this.chat(prompt, config);
    return stripWrappingQuotes(raw.trim());
  }

  async ping(config: LLMConfig): Promise<string> {
    return (
      await this.chat("Reply with the single word OK and nothing else.", config)
    ).trim();
  }

  private documentSection(document: string): string {
    return `<document excerpt>
${truncate(document || "(empty document)", DOC_FOCUS_MAX_CHARS)}
</document excerpt>`;
  }

  private feedbackSection(focus: ScoreFocus): string {
    const parts: string[] = [];
    if (focus.pinnedExamples && focus.pinnedExamples.length > 0) {
      parts.push(
        "Pinned as relevant by the researcher — treat these as a model of what they want:",
        ...focus.pinnedExamples.map(
          (s, i) =>
            `${i + 1}. Title: ${s.title}\n   Snippet: ${truncate(
              s.abstract || "(none)",
              FEEDBACK_SNIPPET_CHARS
            )}`
        )
      );
    }
    if (focus.dismissedExamples && focus.dismissedExamples.length > 0) {
      parts.push(
        "Dismissed as irrelevant by the researcher — rate similar candidates low:",
        ...focus.dismissedExamples.map(
          (s, i) =>
            `${i + 1}. Title: ${s.title}\n   Snippet: ${truncate(
              s.abstract || "(none)",
              FEEDBACK_SNIPPET_CHARS
            )}`
        )
      );
    }
    if (parts.length === 0) return "";
    return `The researcher's own judgments from earlier searches:\n${parts.join("\n")}`;
  }

  private relevanceRubric(): string {
    return [
      "Rate relevance to the content shown. Judge what the paper actually studies.",
      "Do not stretch to find connections to the document. When in doubt, rate low.",
      "- high: directly addresses the same research question or subject, or applies the same core methods to the same problem",
      "- medium: a substantially related subtopic, methods that clearly transfer, or work the document would need to engage or cite — including directly opposing views",
      "- low: tangential to the document, or matching topic words while studying something unrelated. Keyword overlap alone is never more than low.",
    ].join("\n");
  }
}

export function parseTopicList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const parts = raw.split(/[,\n]/);
  for (let part of parts) {
    part = part
      .replace(/^[\s\-*\d.)\]]+/, "")
      .replace(/["'`]/g, "")
      .trim();
    if (part.length < 2 || part.length > 80) continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
    if (out.length >= 8) break;
  }
  return out;
}

function topicKey(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function parseGroups(raw: string, topics: string[]): string[][] {
  const remaining = new Map<string, string>();
  for (const topic of topics) remaining.set(topicKey(topic), topic);
  const groups: string[][] = [];
  for (const line of raw.split(/\n/)) {
    const cleaned = line
      .replace(/^\s*(?:[-*>•]+|group\s*\d+\s*:?\s*)/i, "")
      .trim();
    if (!cleaned) continue;
    const members: string[] = [];
    for (const part of cleaned.split(/[,;]/)) {
      const key = topicKey(part);
      if (!key || !remaining.has(key)) continue;
      members.push(remaining.get(key) as string);
      remaining.delete(key);
    }
    if (members.length > 0) groups.push(members);
  }
  for (const topic of remaining.values()) groups.push([topic]);
  return groups;
}

const BUCKET_LINE_RE = /^\s*(\d+)\s*[:.\-–)]\s*(high|medium|low)\b/gim;

export function applyBuckets(
  raw: string,
  candidates: Suggestion[],
  result: Map<string, RelevanceBucket>
): void {
  let match: RegExpExecArray | null;
  BUCKET_LINE_RE.lastIndex = 0;
  while ((match = BUCKET_LINE_RE.exec(raw)) !== null) {
    const index = Number(match[1]) - 1;
    const bucket = match[2].toLowerCase() as RelevanceBucket;
    const candidate = candidates[index];
    if (!candidate) continue;
    result.set(candidate.url, bucket);
  }
}

function stripWrappingQuotes(text: string): string {
  return text.replace(/^["'\s]+/, "").replace(/["'\s]+$/, "");
}

export function stripThink(text: string): string {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (cleaned) return cleaned;
  return text.trim();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}
