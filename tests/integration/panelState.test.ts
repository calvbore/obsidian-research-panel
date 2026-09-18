import { describe, expect, it } from "vitest";
import {
  carrySummaries,
  derivePanelState,
  pickSummarizeTargets,
} from "../../src/views/panelState";
import type { DocumentResearchData, Suggestion } from "../../src/types";

function recordWith(suggestions: number): DocumentResearchData {
  return {
    id: "r",
    notePath: "a.md",
    noteTitle: "a",
    manualTopics: [],
    pinned: [],
    dismissed: [],
    dismissedTopics: [],
    searchCount: 0,
    suggestions: Array.from({ length: suggestions }, (_, i) => ({
      url: String(i),
      title: String(i),
      authors: [],
      publisher: "",
      year: null,
      date: "",
      abstract: "",
      oaUrl: "",
      source: "openalex",
    })),
  };
}

const BASE = {
  hasEndpoint: true,
  activeFileExtension: "md",
  busy: false,
  record: null,
};

describe("derivePanelState", () => {
  it("unconfigured takes priority over everything", () => {
    expect(
      derivePanelState({ ...BASE, hasEndpoint: false, activeFileExtension: null })
    ).toBe("unconfigured");
  });

  it("non-document for missing or non-markdown leaves, even mid-busy", () => {
    expect(derivePanelState({ ...BASE, activeFileExtension: null })).toBe(
      "non-document"
    );
    expect(derivePanelState({ ...BASE, activeFileExtension: "pdf" })).toBe(
      "non-document"
    );
    expect(
      derivePanelState({
        ...BASE,
        activeFileExtension: "canvas",
        busy: true,
        record: recordWith(3),
      })
    ).toBe("non-document");
  });

  it("loading while busy regardless of cached results", () => {
    expect(
      derivePanelState({ ...BASE, busy: true, record: recordWith(2) })
    ).toBe("loading");
    expect(derivePanelState({ ...BASE, busy: true })).toBe("loading");
  });

  it("empty without results, ready with them", () => {
    expect(derivePanelState(BASE)).toBe("empty");
    expect(derivePanelState({ ...BASE, record: recordWith(0) })).toBe("empty");
    expect(
      derivePanelState({ ...BASE, record: recordWith(1) })
    ).toBe("ready");
  });
});

function suggestionOf(url: string, overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    url,
    title: url,
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

describe("carrySummaries", () => {
  it("copies prior summaries onto re-surfaced results by url", () => {
    const previous = [
      suggestionOf("a", { summary: "Old note" }),
      suggestionOf("b"),
    ];
    const incoming = [suggestionOf("a"), suggestionOf("b"), suggestionOf("c")];
    carrySummaries(previous, incoming);
    expect(incoming[0].summary).toBe("Old note");
    expect(incoming[1].summary).toBeUndefined();
    expect(incoming[2].summary).toBeUndefined();
  });

  it("never mutates the previous suggestions", () => {
    const previous = [suggestionOf("a", { summary: "Old note" })];
    carrySummaries(previous, [suggestionOf("a")]);
    expect(previous[0].summary).toBe("Old note");
  });
});

describe("pickSummarizeTargets", () => {
  it("spends the budget on the best-ranked papers without summaries", () => {
    const candidates = [
      suggestionOf("low1", { bucket: "low" }),
      suggestionOf("high", { bucket: "high" }),
      suggestionOf("medium", { bucket: "medium", summary: "already has one" }),
      suggestionOf("low2", { bucket: "low" }),
      suggestionOf("high2", { bucket: "high", summary: "carried over" }),
    ];
    const targets = pickSummarizeTargets(candidates, 2);
    expect(targets.map((s) => s.url)).toEqual(["high", "low1"]);
  });

  it("returns nothing when every candidate already has a summary", () => {
    const candidates = [
      suggestionOf("a", { bucket: "high", summary: "note" }),
      suggestionOf("b", { summary: "note" }),
    ];
    expect(pickSummarizeTargets(candidates, 5)).toEqual([]);
  });
});
