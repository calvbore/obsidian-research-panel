import { describe, expect, it } from "vitest";
import {
  mergeResults,
  ResearchStore,
  topicSetHash,
  visibleSuggestions,
} from "../../src/stores/ResearchStore";
import type { DocumentResearchData, Suggestion } from "../../src/types";
import { FakeFs } from "../helpers";

const ROOT = ".research-panel";
const INDEX = `${ROOT}/index.json`;

function makeRecord(
  overrides: Partial<DocumentResearchData> = {}
): DocumentResearchData {
  return {
    id: "rec-1",
    notePath: "notes/Alpha.md",
    noteTitle: "Alpha",
    manualTopics: [],
    pinned: [],
    dismissed: [],
    dismissedTopics: [],
    searchCount: 0,
    suggestions: [],
    ...overrides,
  };
}

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    url: "https://example.com/a",
    title: "A Paper",
    authors: ["A. Author"],
    publisher: "Venue",
    year: 2024,
    date: "2024-01-01",
    abstract: "",
    oaUrl: "",
    source: "openalex",
    ...overrides,
  };
}

async function createStoreWithRecord(
  record: DocumentResearchData = makeRecord()
): Promise<{ fs: FakeFs; store: ResearchStore; record: DocumentResearchData }> {
  const fs = new FakeFs();
  const store = new ResearchStore(fs);
  const loaded = await store.getOrCreate(record.notePath, record.noteTitle);
  Object.assign(loaded, { ...record, id: loaded.id });
  await store.save(loaded);
  return { fs, store, record: loaded };
}

describe("ResearchStore persistence", () => {
  it("creates a record and persists index atomically", async () => {
    const { fs } = await createStoreWithRecord();
    const index = JSON.parse(fs.files.get(INDEX)!);
    expect(Object.values(index)).toHaveLength(1);
    const dataFile = Array.from(fs.files.keys()).find(
      (k) => k.startsWith(`${ROOT}/`) && k !== INDEX && !k.endsWith(".tmp")
    );
    expect(dataFile).toBeDefined();
    expect(Array.from(fs.files.keys()).some((k) => k.endsWith(".tmp"))).toBe(
      false
    );
  });

  it("round-trips a record through a fresh store instance", async () => {
    const { fs, store, record } = await createStoreWithRecord();
    record.suggestions.push(makeSuggestion());
    await store.save(record);
    const loaded = await new ResearchStore(fs).get(record.notePath);
    expect(loaded?.suggestions).toHaveLength(1);
    expect(loaded?.noteTitle).toBe("Alpha");
  });

  it("normalizes a missing searchCount to zero on load", async () => {
    const fs = new FakeFs();
    fs.seed(
      `${ROOT}/legacy.json`,
      JSON.stringify({
        id: "legacy",
        notePath: "notes/Legacy.md",
        noteTitle: "Legacy",
        manualTopics: ["x"],
        pinned: [],
        dismissed: [],
        dismissedTopics: [],
        suggestions: [],
      })
    );
    fs.seed(INDEX, JSON.stringify({ "notes/Legacy.md": "legacy" }));
    const store = new ResearchStore(fs);
    const record = await store.get("notes/Legacy.md");
    expect(record?.searchCount).toBe(0);
  });

  it("persists searchCount and topicClusters across a round trip", async () => {
    const { fs, store, record } = await createStoreWithRecord();
    record.searchCount = 4;
    record.topicClusters = {
      hash: topicSetHash(record.manualTopics),
      groups: [["a", "b"], ["c"]],
    };
    await store.save(record);
    const loaded = await new ResearchStore(fs).get(record.notePath);
    expect(loaded?.searchCount).toBe(4);
    expect(loaded?.topicClusters).toEqual({
      hash: topicSetHash([]),
      groups: [["a", "b"], ["c"]],
    });
  });

  it("topicSetHash ignores order and case", () => {
    expect(topicSetHash(["Alpha", "beta"])).toBe(
      topicSetHash(["beta", "alpha"])
    );
    expect(topicSetHash(["alpha", "beta"])).not.toBe(
      topicSetHash(["alpha", "gamma"])
    );
  });

  it("updates noteTitle from basename on save", async () => {
    const { store, record } = await createStoreWithRecord();
    record.notePath = "other/Renamed.md";
    await store.save(record);
    expect(record.noteTitle).toBe("Renamed");
  });
});

describe("rename resilience", () => {
  it("handles single file rename: index entry and record path updated", async () => {
    const { fs, store, record } = await createStoreWithRecord();
    await store.handleFileRename(record.notePath, "notes/Beta.md");
    const index = JSON.parse(fs.files.get(INDEX)!);
    expect(index["notes/Beta.md"]).toBeDefined();
    expect(index["notes/Alpha.md"]).toBeUndefined();
    const reloaded = await new ResearchStore(fs).get("notes/Beta.md");
    expect(reloaded?.notePath).toBe("notes/Beta.md");
  });

  it("handles folder rename: all nested entries rewritten", async () => {
    const fs = new FakeFs();
    const store = new ResearchStore(fs);
    const a = await store.getOrCreate("projects/sub/A.md", "A");
    const b = await store.getOrCreate("projects/sub/deep/B.md", "B");
    await store.handleFolderRename("projects/sub", "archive/moved");

    const index = JSON.parse(fs.files.get(INDEX)!);
    expect(index["archive/moved/A.md"]).toBe(a.id);
    expect(index["archive/moved/deep/B.md"]).toBe(b.id);
    expect(Object.keys(index)).toEqual([
      "archive/moved/A.md",
      "archive/moved/deep/B.md",
    ]);
    const reloadedB = await new ResearchStore(fs).get(
      "archive/moved/deep/B.md"
    );
    expect(reloadedB?.id).toBe(b.id);
  });

  it("ignores renames for unknown paths", async () => {
    const { fs } = await createStoreWithRecord();
    const store = new ResearchStore(fs);
    await store.handleFileRename("unknown/path.md", "new/path.md");
    expect(fs.files.get(INDEX)).toContain("notes/Alpha.md");
  });

  it("fuzzy fallback finds a record by basename after external moves", async () => {
    const { fs, record } = await createStoreWithRecord(
      makeRecord({ notePath: "docs/alpha-report.md" })
    );
    const staleIndex = JSON.parse(fs.files.get(INDEX)!);
    delete staleIndex["docs/alpha-report.md"];
    staleIndex["old-location/alpha-report.md"] = record.id;
    fs.seed(INDEX, JSON.stringify(staleIndex));

    const found = await new ResearchStore(fs).get("somewhere-new/alpha-report.md");
    expect(found?.id).toBe(record.id);
  });
});

describe("delete handling", () => {
  it("removes index entry but retains data file marked orphaned", async () => {
    const { fs, record } = await createStoreWithRecord();
    const store = new ResearchStore(fs);
    await store.handleFileDelete(record.notePath);
    const index = JSON.parse(fs.files.get(INDEX)!);
    expect(Object.keys(index)).toHaveLength(0);
    const retainedFile = Array.from(fs.files.entries()).find(
      ([path, content]) =>
        path !== INDEX &&
        path.endsWith(".json") &&
        content.includes(record.id)
    );
    expect(retainedFile).toBeDefined();
    const retained = JSON.parse(retainedFile![1]);
    expect(retained.orphaned).toBe(true);
  });

  it("folder delete orphans every nested record", async () => {
    const fs = new FakeFs();
    const store = new ResearchStore(fs);
    await store.getOrCreate("tree/x/1.md", "1");
    await store.getOrCreate("tree/y/2.md", "2");
    await store.getOrCreate("outside/3.md", "3");
    await store.handleFolderDelete("tree/x");
    const index = JSON.parse(fs.files.get(INDEX)!);
    expect(index["outside/3.md"]).toBeDefined();
    expect(index["tree/y/2.md"]).toBeDefined();
    expect(index["tree/x/1.md"]).toBeUndefined();
  });
});

describe("index self-heal", () => {
  it("rebuilds from embedded notePath when index.json is corrupt", async () => {
    const { fs, record } = await createStoreWithRecord();
    fs.seed(INDEX, "{corrupted json!!");
    const recovered = await new ResearchStore(fs).get(record.notePath);
    expect(recovered?.id).toBe(record.id);
    const healed = JSON.parse(fs.files.get(INDEX)!);
    expect(healed[record.notePath]).toBe(record.id);
  });

  it("rebuilds when index.json is missing entirely", async () => {
    const { fs, record } = await createStoreWithRecord();
    fs.files.delete(INDEX);
    const recovered = await new ResearchStore(fs).get(record.notePath);
    expect(recovered?.id).toBe(record.id);
  });

  it("excludes orphaned records from rebuilt index", async () => {
    const { fs, record } = await createStoreWithRecord();
    const dataFile = Array.from(fs.files.entries()).find(
      ([k, v]) => k.startsWith(`${ROOT}/`) && k !== INDEX && v.includes("Alpha")
    )!;
    const parsed = JSON.parse(dataFile[1]);
    parsed.orphaned = true;
    fs.seed(dataFile[0], JSON.stringify(parsed));
    fs.files.delete(INDEX);
    const store = new ResearchStore(fs);
    expect(await store.get(record.notePath)).toBeNull();
  });
});

describe("mergeResults", () => {
  it("appends only unknown, non-pinned, non-dismissed urls", () => {
    const existing = makeSuggestion({ url: "https://x/1" });
    const pinned = makeSuggestion({ url: "https://x/pin", title: "Pinned T" });
    const dismissed = makeSuggestion({ url: "https://x/dis", title: "Dismissed T" });
    const fresh = makeSuggestion({ url: "https://x/new", title: "Fresh T" });
    const record = makeRecord({
      suggestions: [existing],
      pinned: [pinned.url],
      dismissed: [dismissed.url],
    });
    const added = mergeResults(record, [existing, pinned, dismissed, fresh]);
    expect(added.map((s) => s.url)).toEqual([fresh.url]);
    expect(record.suggestions.map((s) => s.url)).toEqual([
      existing.url,
      fresh.url,
    ]);
  });

  it("keeps pins intact across repeated merges", () => {
    const record = makeRecord({ pinned: ["https://x/pin"] });
    const pinDup = makeSuggestion({
      url: "https://x/pin",
      title: "Same Title",
    });
    mergeResults(record, [pinDup]);
    expect(record.suggestions).toHaveLength(0);
    expect(record.pinned).toEqual(["https://x/pin"]);
  });
});

describe("visibleSuggestions ordering", () => {
  const low = makeSuggestion({ url: "u-low", bucket: "low", year: 2020 });
  const highOld = makeSuggestion({ url: "u-high-old", bucket: "high", year: 2001 });
  const med = makeSuggestion({ url: "u-med", bucket: "medium", year: 2015 });
  const unscored = makeSuggestion({ url: "u-unscored" });
  const highNew = makeSuggestion({ url: "u-high-new", bucket: "high", year: 2024 });

  function build(): DocumentResearchData {
    return makeRecord({
      pinned: ["u-med"],
      suggestions: [low, highOld, med, unscored, highNew],
    });
  }

  it("orders pinned first, then buckets, then recency", () => {
    const order = visibleSuggestions(build()).map((s) => s.url);
    expect(order).toEqual([
      "u-med",
      "u-high-new",
      "u-high-old",
      "u-low",
      "u-unscored",
    ]);
  });

  it("hides dismissed results", () => {
    const record = build();
    record.dismissed.push("u-high-new");
    const order = visibleSuggestions(record).map((s) => s.url);
    expect(order).not.toContain("u-high-new");
  });
});
