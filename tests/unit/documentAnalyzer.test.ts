import { describe, expect, it } from "vitest";
import {
  extractLightweightTopics,
  stripFrontmatter,
  wordCount,
} from "../../src/services/DocumentAnalyzer";

describe("stripFrontmatter + wordCount", () => {
  it("strips yaml frontmatter", () => {
    const doc = "---\ntitle: x\n---\nBody text here.";
    expect(stripFrontmatter(doc)).toBe("Body text here.");
  });

  it("leaves plain content untouched", () => {
    expect(stripFrontmatter("just text")).toBe("just text");
  });

  it("counts words including zero for empty input", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   \n  ")).toBe(0);
    expect(wordCount("one two three")).toBe(3);
  });
});

describe("extractLightweightTopics", () => {
  it("prefers headings, then keywords, then tags; dedupes case-insensitively", () => {
    const topics = extractLightweightTopics({
      headings: ["Transformer Architectures", "Attention: A Deep Dive"],
      tags: ["#ml", "transformer-architectures"],
      frontmatterKeywords: ["attention mechanisms"],
      bodyText: "",
    });
    const lower = topics.map((t) => t.toLowerCase());
    expect(lower[0]).toBe("transformer architectures");
    expect(lower).toContain("attention");
    expect(lower.indexOf("transformer architectures")).toBe(
      lower.lastIndexOf("transformer architectures")
    );
  });

  it("splits compound headings into phrases", () => {
    const topics = extractLightweightTopics({
      headings: ["Methods: RLHF and Scaling"],
      tags: [],
      frontmatterKeywords: [],
      bodyText: "",
    });
    const lower = topics.map((t) => t.toLowerCase());
    expect(lower).toContain("methods");
    expect(lower.some((t) => t.includes("rlhf"))).toBe(true);
  });

  it("caps output at fifteen topics and drops tiny fragments", () => {
    const topics = extractLightweightTopics({
      headings: Array.from({ length: 20 }, (_, i) => `Heading number ${i}`),
      tags: [],
      frontmatterKeywords: [],
      bodyText: "",
    });
    expect(topics.length).toBeLessThanOrEqual(15);
    expect(topics.every((t) => t.length >= 3)).toBe(true);
  });
});
