export type RelevanceBucket = "high" | "medium" | "low";

export type SourceName = "openalex" | "semanticscholar";

export interface Suggestion {
  url: string;
  title: string;
  authors: string[];
  publisher: string;
  year: number | null;
  date: string;
  abstract: string;
  oaUrl: string;
  doi?: string;
  oaId?: string;
  s2Id?: string;
  citationCount?: number;
  source: SourceName;
  origin?: "related";
  bucket?: RelevanceBucket;
  summary?: string;
}

export interface TopicClusterCache {
  hash: string;
  groups: string[][];
}

export interface DocumentResearchData {
  id: string;
  notePath: string;
  noteTitle: string;
  manualTopics: string[];
  pinned: string[];
  dismissed: string[];
  dismissedTopics: string[];
  searchCount: number;
  topicClusters?: TopicClusterCache;
  orphaned?: boolean;
  suggestions: Suggestion[];
}

export type CitationFormat = "apa" | "mla" | "chicago" | "plain";

export type CitationInput = Pick<
  Suggestion,
  "title" | "authors" | "publisher" | "year" | "date" | "url"
>;

export interface SourceError {
  source: SourceName;
  message: string;
}

export interface ConnectionOutcome {
  topics: string[];
  found: number;
}

export type LlmApiFormat = "openai" | "anthropic";

export interface LlmProfile {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  format: LlmApiFormat;
  temperature: string;
}

export interface PluginSettings {
  llmProfiles: LlmProfile[];
  activeProfileId: string;
  openAlexEmail: string;
  semanticScholarApiKey: string;
  defaultCitationFormat: CitationFormat;
  maxResults: number;
  useRelatedFromPins: boolean;
}

export interface SearchOutcome {
  results: Suggestion[];
  errors: SourceError[];
  connections: ConnectionOutcome[];
}
