export interface AnalyzedDocument {
  headings: string[];
  tags: string[];
  frontmatterKeywords: string[];
  bodyText: string;
}

export interface LightweightTopicSource {
  topics: string[];
}

export const MIN_WORDS_FOR_LLM = 100;
const MAX_LIGHTWEIGHT_TOPICS = 15;

export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const after = content.indexOf("\n", end + 1);
  return after === -1 ? "" : content.slice(after + 1);
}

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/);
  return words[0] ? words.length : 0;
}

function splitHeadingIntoPhrases(heading: string): string[] {
  return heading
    .split(/[|:;,–—\-()]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && s.length < 60);
}

export function extractLightweightTopics(
  doc: AnalyzedDocument
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (topic: string) => {
    const trimmed = topic.trim();
    if (trimmed.length < 3 || trimmed.length > 60) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const heading of doc.headings) {
    push(heading);
    if (out.length >= MAX_LIGHTWEIGHT_TOPICS) return out.slice(0, MAX_LIGHTWEIGHT_TOPICS);
    for (const phrase of splitHeadingIntoPhrases(heading)) push(phrase);
  }
  for (const keyword of doc.frontmatterKeywords) push(keyword);
  for (const tag of doc.tags) push(tag.replace(/^#/, ""));
  return out.slice(0, MAX_LIGHTWEIGHT_TOPICS);
}
