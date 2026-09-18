import type { CitationFormat, CitationInput } from "../types";

function extractYear(input: CitationInput): string {
  if (input.year != null) return String(input.year);
  const m = /(\d{4})/.exec(input.date ?? "");
  return m ? m[1] : "";
}

function joinAuthors(authors: string[], style: "apa" | "plain"): string {
  if (authors.length === 0) return "";
  const names = authors.map((a) => a.trim()).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (style === "apa") {
    return [...names.slice(0, -1), `& ${names[names.length - 1]}`].join(", ");
  }
  return names.join(", ");
}

function ensurePeriod(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function formatCitation(
  input: CitationInput,
  format: CitationFormat
): string {
  switch (format) {
    case "plain":
      return input.url;
    case "apa":
      return apaCitation(input);
    case "mla":
      return mlaCitation(input);
    case "chicago":
      return chicagoCitation(input);
  }
}

function authorYearSegment(input: CitationInput): string {
  const authors = joinAuthors(input.authors ?? [], "apa");
  const year = extractYear(input) || "n.d.";
  return authors ? `${authors} (${year})` : `(${year})`;
}

function hasContent(input: CitationInput): boolean {
  return Boolean(
    (input.title ?? "").trim() ||
      (input.publisher ?? "").trim() ||
      (input.authors ?? []).some((a) => a.trim())
  );
}

function apaCitation(input: CitationInput): string {
  if (!hasContent(input)) return input.url;
  const segments = [
    ensurePeriod(authorYearSegment(input)),
    ensurePeriod(input.title ?? ""),
    ensurePeriod(input.publisher ?? ""),
    input.url,
  ];
  return segments.filter(Boolean).join(" ").trim();
}

function mlaCitation(input: CitationInput): string {
  if (!hasContent(input)) return input.url;
  const segments: string[] = [];
  const authors = joinAuthors(input.authors ?? [], "plain");
  if (authors) segments.push(ensurePeriod(authors));
  if (input.title) segments.push(`"${input.title}."`);
  if (input.publisher) segments.push(`${input.publisher},`);
  const year = extractYear(input);
  if (year) segments.push(`${year},`);
  else if (segments.length && segments[segments.length - 1].endsWith(","))
    segments[segments.length - 1] = segments[segments.length - 1].replace(
      /,$/,
      "."
    );
  if (input.url) segments.push(`${input.url}.`);
  return segments.join(" ").trim();
}

function chicagoCitation(input: CitationInput): string {
  if (!hasContent(input)) return input.url;
  const segments: string[] = [];
  const authors = joinAuthors(input.authors ?? [], "plain");
  if (authors) segments.push(ensurePeriod(authors));
  if (input.title) segments.push(`"${input.title}."`);
  if (input.publisher) segments.push(ensurePeriod(input.publisher));
  const year = extractYear(input);
  if (year) segments.push(ensurePeriod(year));
  if (input.url) segments.push(input.url + ".");
  return segments.join(" ").trim();
}
