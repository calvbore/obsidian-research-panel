import { describe, expect, it } from "vitest";
import {
  formatCitation,
} from "../../src/services/CitationFormatter";
import type { CitationInput } from "../../src/types";

const COMPLETE: CitationInput = {
  url: "https://example.com/paper",
  title: "A Study of Things",
  authors: ["John Smith", "Jane Doe"],
  publisher: "University Press",
  year: 2024,
  date: "2024-03-04",
};

describe("formatCitation", () => {
  it("formats APA with complete metadata", () => {
    expect(formatCitation(COMPLETE, "apa")).toBe(
      "John Smith, & Jane Doe (2024). A Study of Things. University Press. https://example.com/paper"
    );
  });

  it("formats MLA with complete metadata", () => {
    expect(formatCitation(COMPLETE, "mla")).toBe(
      'John Smith, Jane Doe. "A Study of Things." University Press, 2024, https://example.com/paper.'
    );
  });

  it("formats Chicago with complete metadata", () => {
    expect(formatCitation(COMPLETE, "chicago")).toBe(
      'John Smith, Jane Doe. "A Study of Things." University Press. 2024. https://example.com/paper.'
    );
  });

  it("plain format is exactly the URL", () => {
    expect(formatCitation(COMPLETE, "plain")).toBe(
      "https://example.com/paper"
    );
  });

  it("APA falls back to n.d. and omits missing publisher/authors gracefully", () => {
    const partial: CitationInput = {
      ...COMPLETE,
      authors: [],
      year: null,
      date: "",
      publisher: "",
    };
    expect(formatCitation(partial, "apa")).toBe(
      "(n.d.). A Study of Things. https://example.com/paper"
    );
  });

  it("MLA replaces dangling comma when no year exists but publisher does", () => {
    const partial: CitationInput = { ...COMPLETE, year: null, date: "" };
    expect(formatCitation(partial, "mla")).toBe(
      'John Smith, Jane Doe. "A Study of Things." University Press. https://example.com/paper.'
    );
  });

  it("extracts a year from a date string when year is null", () => {
    const partial: CitationInput = { ...COMPLETE, year: null };
    expect(formatCitation(partial, "apa")).toContain("(2024)");
  });

  it("handles title+url only across formats without crashing", () => {
    const minimal: CitationInput = {
      url: "https://x/y",
      title: "T",
      authors: [],
      publisher: "",
      year: null,
      date: "",
    };
    expect(formatCitation(minimal, "apa")).toBe("(n.d.). T. https://x/y");
    expect(formatCitation(minimal, "mla")).toBe('"T." https://x/y.');
    expect(formatCitation(minimal, "chicago")).toBe('"T." https://x/y.');
    expect(formatCitation(minimal, "plain")).toBe("https://x/y");
  });

  it("handles completely empty metadata except url", () => {
    const bare: CitationInput = {
      url: "https://z",
      title: "",
      authors: [],
      publisher: "",
      year: null,
      date: "",
    };
    for (const fmt of ["apa", "mla", "chicago"] as const) {
      expect(formatCitation(bare, fmt)).toBe("https://z");
    }
  });
});
