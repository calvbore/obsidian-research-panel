import { Notice, setIcon, ItemView, Menu, TFile, WorkspaceLeaf } from "obsidian";
import type { ResearchPanelPlugin } from "../main";
import {
  AnalyzedDocument,
  extractLightweightTopics,
  MIN_WORDS_FOR_LLM,
  stripFrontmatter,
  wordCount,
} from "../services/DocumentAnalyzer";
import { formatCitation } from "../services/CitationFormatter";
import type {
  CitationFormat,
  ConnectionOutcome,
  DocumentResearchData,
  SourceError,
  Suggestion,
} from "../types";
import { topicSetHash, visibleSuggestions } from "../stores/ResearchStore";
import { llmConfigFrom } from "../settings";
import { sampleFeedback } from "../services/LLMService";
import { carrySummaries, derivePanelState, pickSummarizeTargets } from "./panelState";

export const VIEW_TYPE_RESEARCH_PANEL = "research-panel-view";

const CITATION_FORMATS: Array<{ value: CitationFormat; label: string }> = [
  { value: "apa", label: "Copy as APA" },
  { value: "mla", label: "Copy as MLA" },
  { value: "chicago", label: "Copy as Chicago" },
  { value: "plain", label: "Copy plain URL" },
];

const SUMMARY_TOP_N = 5;

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

export class ResearchPanelView extends ItemView {
  private record: DocumentResearchData | null = null;
  private activePath: string | null = null;
  private busy = false;
  private busyLabel = "";
  private errors: SourceError[] = [];
  private llmError: string | null = null;
  private connections: ConnectionOutcome[] = [];
  private reassessingUrl: string | null = null;
  private dismissedOpen = false;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ResearchPanelPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_RESEARCH_PANEL;
  }

  getDisplayText(): string {
    return "Research Panel";
  }

  getIcon(): string {
    return "graduation-cap";
  }

  refresh(): void {
    this.render();
  }

  async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.syncToActiveFile();
      })
    );
    await this.syncToActiveFile();
  }

  private async syncToActiveFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      this.activePath = null;
      this.record = null;
      this.render();
      return;
    }
    if (this.activePath === file.path && this.record) return;
    this.activePath = file.path;
    this.record = await this.plugin.store.get(file.path);
    this.errors = [];
    this.llmError = null;
    this.render();
  }

  private get hasEndpoint(): boolean {
    return llmConfigFrom(this.plugin.settings).endpoint.trim().length > 0;
  }

  private render(): void {
    const phase = derivePanelState({
      hasEndpoint: this.hasEndpoint,
      activeFileExtension: this.activeExtension(),
      busy: this.busy,
      record: this.record,
    });
    const content = this.contentEl;
    content.empty();
    content.addClass("research-panel-view");

    if (phase === "unconfigured") {
      this.renderUnconfigured(content);
      return;
    }
    if (phase === "non-document") {
      content.createDiv({
        text: "This is not a working text document.",
        cls: "research-placeholder",
      });
      return;
    }
    this.renderHeader(content);
    this.renderPinRow(content);
    this.renderErrors(content);
    this.renderConnections(content);
    this.renderChips(content);

    if (phase === "loading") this.renderSkeleton(content);
    if (phase === "empty") {
      content.createDiv({ text: "No relevant documents found.", cls: "research-placeholder" });
      content.createDiv({
        text: "Edit the topic chips above and search again.",
        cls: "research-hint",
      });
    }
    if (this.record && this.record.suggestions.length > 0) {
      this.renderResults(content, phase === "loading");
    }
  }

  private activeExtension(): string | null {
    const file = this.app.workspace.getActiveFile();
    return file ? file.extension : null;
  }

  private renderUnconfigured(container: HTMLElement): void {
    container.createDiv({
      text: "Configure an LLM endpoint in settings to enable research search.",
      cls: "research-placeholder",
    });
    const button = container.createEl("button", { text: "Open Settings" });
    button.onclick = () => {
      const withSetting = this.app as unknown as {
        setting?: { open(): void; openTabById(id: string): void };
      };
      withSetting.setting?.open();
      withSetting.setting?.openTabById(this.plugin.manifest.id);
    };
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv("research-header");
    const profiles = this.plugin.settings.llmProfiles;
    if (profiles.length > 0) {
      const profileSelect = header.createEl("select", {
        cls: "research-profile-select dropdown",
      });
      profileSelect.disabled = this.busy;
      profileSelect.setAttribute("aria-label", "Active LLM profile");
      profileSelect.setAttribute("title", "Active LLM profile");
      for (const profile of profiles) {
        const option = profileSelect.createEl("option", {
          text: profile.name || profile.endpoint || profile.id,
          value: profile.id,
        });
        if (profile.id === this.plugin.settings.activeProfileId) {
          option.selected = true;
        }
      }
      profileSelect.onchange = () => {
        this.plugin.settings.activeProfileId = profileSelect.value;
        void this.plugin.saveSettings();
        this.render();
      };
    }

    const reextract = header.createEl("button", { text: "Re-extract Topics" });
    reextract.disabled = this.busy;
    reextract.setAttribute("aria-label", "Re-extract topics from the document with the LLM");
    reextract.setAttribute("title", "Re-extract topics from the document with the LLM");
    reextract.onclick = () => void this.onReextractClicked();

    const hasResults = Boolean(this.record?.suggestions.length);
    const searchBtn = header.createEl("button", {
      text: hasResults ? "Refresh" : "Search",
    });
    searchBtn.disabled = this.busy;
    searchBtn.addClass("mod-cta");
    searchBtn.setAttribute("aria-label", "Search academic APIs for the current topics");
    searchBtn.setAttribute("title", "Search academic APIs for the current topics");
    searchBtn.onclick = () => void this.onSearchClicked();
  }

  private renderPinRow(container: HTMLElement): void {
    const row = container.createDiv("research-pin-row");
    const input = row.createEl("input", {
      type: "text",
      attr: { placeholder: "Paste a paper URL or DOI to pin…" },
    }) as HTMLInputElement;
    input.setAttribute("aria-label", "Add a paper by URL or DOI and pin it");
    const button = row.createEl("button", { text: "Pin" });
    button.disabled = this.busy;
    button.setAttribute("aria-label", "Resolve and pin the paper");
    button.setAttribute("title", "Resolve and pin the paper");
    const submit = () => void this.onManualPin(input);
    button.onclick = submit;
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submit();
    });
  }

  private async onManualPin(input: HTMLInputElement): Promise<void> {
    const record = this.record;
    if (!record || this.busy || this.reassessingUrl) return;
    const typed = input.value.trim();
    if (!typed) return;
    this.busy = true;
    this.busyLabel = "Resolving paper…";
    this.render();
    try {
      const suggestion = await this.plugin.search.resolvePaper(typed, {
        s2ApiKey: this.plugin.settings.semanticScholarApiKey || undefined,
        openAlexEmail: this.plugin.settings.openAlexEmail || undefined,
      });
      const known = new Set(record.suggestions.map((s) => s.url));
      if (!known.has(suggestion.url)) record.suggestions.push(suggestion);
      if (!record.pinned.includes(suggestion.url)) {
        record.pinned.push(suggestion.url);
      }
      await this.plugin.store.save(record);
      this.record = record;
      new Notice(`Pinned: ${suggestion.title || suggestion.url}`);
    } catch (error) {
      this.llmError = `Could not add paper: ${String(error)}`;
      const fresh = this.contentEl.querySelector<HTMLInputElement>(
        ".research-pin-row input"
      );
      if (fresh) fresh.value = typed;
    } finally {
      this.busy = false;
      this.busyLabel = "";
      this.render();
    }
  }

  private renderErrors(container: HTMLElement): void {
    this.errors.forEach((error, index) => {
      const row = container.createDiv("research-error");
      row.createSpan({ text: `${error.source}: ${error.message}` });
      const dismiss = row.createSpan({ cls: "clickable-icon research-action" });
      setIcon(dismiss, "x");
      dismiss.setAttribute("aria-label", "Dismiss this error message");
      dismiss.setAttribute("title", "Dismiss this error message");
      dismiss.onclick = () => {
        this.errors.splice(index, 1);
        this.render();
      };
    });
    if (this.llmError) {
      const row = container.createDiv("research-error");
      row.createSpan({ text: this.llmError });
      const dismiss = row.createSpan({ cls: "clickable-icon research-action" });
      setIcon(dismiss, "x");
      dismiss.setAttribute("aria-label", "Dismiss this error message");
      dismiss.setAttribute("title", "Dismiss this error message");
      dismiss.onclick = () => {
        this.llmError = null;
        this.render();
      };
    }
  }

  private renderConnections(container: HTMLElement): void {
    for (const connection of this.connections) {
      if (connection.found > 0) continue;
      const label =
        connection.topics.length > 2
          ? `No results for combined topics: ${connection.topics.join(", ")}`
          : `No literature found connecting “${connection.topics[0]}” + “${connection.topics[1]}”`;
      container.createDiv({
        text: label,
        cls: "research-connection-note",
      });
    }
  }

  private renderChips(container: HTMLElement): void {
    const record = this.record;
    if (!record) return;
    const wrap = container.createDiv("research-chips");
    record.manualTopics.forEach((topic, index) => {
      const chip = wrap.createDiv("research-chip");
      chip.createSpan({ text: topic, cls: "research-chip-text" });
      const editBtn = chip.createSpan({ cls: "research-chip-icon clickable-icon" });
      setIcon(editBtn, "pencil");
      editBtn.setAttribute("aria-label", `Edit topic "${topic}"`);
      editBtn.setAttribute("title", `Edit topic "${topic}"`);
      editBtn.onclick = () => this.editChip(wrap, index);
      const delBtn = chip.createSpan({ cls: "research-chip-icon clickable-icon" });
      setIcon(delBtn, "x");
      delBtn.setAttribute("aria-label", `Remove topic "${topic}"`);
      delBtn.setAttribute("title", `Remove topic "${topic}"`);
      delBtn.onclick = () => {
        if (!record.dismissedTopics.includes(topic)) {
          record.dismissedTopics.push(topic);
        }
        record.manualTopics.splice(index, 1);
        void this.persistAndRender();
      };
    });
    const addRow = wrap.createDiv("research-chip-add");
    const input = addRow.createEl("input", {
      type: "text",
      attr: { placeholder: "Add topic…" },
    }) as HTMLInputElement;
    input.setAttribute("aria-label", "Add a topic manually");
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      if (!record.manualTopics.some((t) => t.toLowerCase() === value.toLowerCase())) {
        record.manualTopics.push(value);
        void this.persistAndRender();
      }
    });
  }

  private editChip(wrap: HTMLElement, index: number): void {
    const record = this.record;
    if (!record) return;
    const chips = Array.from(wrap.querySelectorAll<HTMLElement>(".research-chip"));
    const chip = chips[index];
    if (!chip) return;
    const original = record.manualTopics[index];
    chip.empty();
    const input = chip.createEl("input", { type: "text" }) as HTMLInputElement;
    input.value = original;
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (value && value !== original) {
        record.manualTopics[index] = value;
      }
      void this.persistAndRender();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      this.render();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        cancel();
      }
    });
    input.addEventListener("blur", commit);
  }

  private renderSkeleton(container: HTMLElement): void {
    const skeleton = container.createDiv("research-skeleton");
    skeleton.createDiv({ text: this.busyLabel || "Working…", cls: "research-skeleton-label" });
    for (let i = 0; i < 3; i++) {
      skeleton.createDiv("research-skeleton-row");
    }
  }

  private renderResults(container: HTMLElement, loadingOverlay: boolean): void {
    const record = this.record;
    if (!record) return;
    const list = visibleSuggestions(record);
    if (list.length === 0 && !loadingOverlay) {
      container.createDiv({ text: "All results are dismissed.", cls: "research-hint" });
    }
    const cardsWrap = container.createDiv("research-cards");
    for (const suggestion of list) {
      this.renderCard(cardsWrap, record, suggestion);
    }
    this.renderDismissedSection(container, record);
  }

  private renderCard(
    container: HTMLElement,
    record: DocumentResearchData,
    suggestion: Suggestion
  ): void {
    const card = container.createDiv("research-card");
    if (record.pinned.includes(suggestion.url)) card.addClass("is-pinned");
    const topRow = card.createDiv("research-card-top");
    topRow.createSpan({
      text: suggestion.bucket ? capitalize(suggestion.bucket) : "",
      cls: `research-badge research-badge-${suggestion.bucket ?? "none"}`,
    });
    if (suggestion.origin === "related") {
      topRow.createSpan({
        text: "related",
        cls: "research-badge research-badge-related",
      });
    }
    const titleLink = topRow.createEl("a", {
      text: suggestion.title || suggestion.url,
      href: suggestion.url,
    });
    titleLink.setAttr("target", "_blank");
    titleLink.setAttr("rel", "noopener");

    const metaParts = [
      suggestion.authors.slice(0, 3).join(", "),
      suggestion.publisher,
      publicationLabel(suggestion),
    ].filter(Boolean);
    if (metaParts.length > 0) {
      card.createDiv({ text: metaParts.join(" · "), cls: "research-card-meta" });
    }
    if (suggestion.summary) {
      card.createDiv({ text: suggestion.summary, cls: "research-card-summary" });
    }
    const abstract = suggestion.abstract ?? "";
    if (abstract) {
      const toggleWrap = card.createDiv("research-abstract-toggle-wrap");
      const toggleBtn = toggleWrap.createEl("button", { text: "Abstract" });
      toggleBtn.setAttribute("aria-label", "Toggle full abstract");
      toggleBtn.setAttribute("title", "Toggle full abstract");
      const snippet = card.createDiv({
        text: truncateText(abstract, 240),
        cls: "research-card-snippet",
      });
      const full = card.createDiv({
        text: abstract,
        cls: "research-card-abstract",
      });
      full.hide();
      let open = false;
      toggleBtn.onclick = () => {
        open = !open;
        if (open) {
          full.show();
          snippet.hide();
          toggleBtn.setText("Hide abstract");
        } else {
          full.hide();
          snippet.show();
          toggleBtn.setText("Abstract");
        }
      };
    }
    const actions = card.createDiv("research-card-actions");
    const reassessing = this.reassessingUrl === suggestion.url;
    const reassessBusy = this.reassessingUrl != null;
    const reassessBtn = this.iconAction(
      actions,
      reassessing ? "loader" : "refresh-cw",
      reassessing ? "Reassessing relevance…" : "Reassess relevance",
      () => void this.onReassessClicked(suggestion)
    );
    if (reassessBusy) reassessBtn.addClass("is-disabled");
    if (reassessing) reassessBtn.addClass("is-working");
    this.iconAction(actions, record.pinned.includes(suggestion.url) ? "pin-off" : "pin",
      record.pinned.includes(suggestion.url) ? "Unpin" : "Pin",
      () => this.togglePinned(record, suggestion));
    this.iconAction(actions, "x", "Dismiss", () => this.dismissSuggestion(record, suggestion));
    const copyBtn = this.iconAction(actions, "copy", "Copy reference", () => undefined);
    copyBtn.addEventListener("click", (event) => {
      this.openCitationMenu(event, suggestion);
    });
    this.iconAction(actions, "external-link", "Open URL", () =>
      window.open(suggestion.url, "_blank")
    );
    if (suggestion.oaUrl) {
      const oa = actions.createEl("a", { href: suggestion.oaUrl });
      oa.setAttr("target", "_blank");
      oa.setAttr("rel", "noopener");
      oa.addClass("clickable-icon");
      oa.setAttribute("aria-label", "Open-access PDF");
      oa.setAttribute("title", "Open-access PDF");
      setIcon(oa, "file-text");
    }
  }

  private iconAction(
    container: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLElement {
    const button = container.createSpan({ cls: "clickable-icon research-action" });
    setIcon(button, icon);
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.onclick = onClick;
    return button;
  }

  private openCitationMenu(event: MouseEvent, suggestion: Suggestion): void {
    const menu = new Menu();
    for (const format of CITATION_FORMATS) {
      menu.addItem((item) =>
        item.setTitle(format.label).onClick(async () => {
          await copyText(formatCitation(suggestion, format.value));
          new Notice(`Copied ${format.value.toUpperCase()} reference`);
        })
      );
    }
    menu.showAtMouseEvent(event);
  }

  private togglePinned(record: DocumentResearchData, suggestion: Suggestion): void {
    const idx = record.pinned.indexOf(suggestion.url);
    if (idx >= 0) record.pinned.splice(idx, 1);
    else record.pinned.push(suggestion.url);
    void this.persistAndRender();
  }

  private dismissSuggestion(record: DocumentResearchData, suggestion: Suggestion): void {
    if (!record.dismissed.includes(suggestion.url)) {
      record.dismissed.push(suggestion.url);
    }
    const pinIdx = record.pinned.indexOf(suggestion.url);
    if (pinIdx >= 0) record.pinned.splice(pinIdx, 1);
    void this.persistAndRender();
  }

  private undismissSuggestion(record: DocumentResearchData, url: string): void {
    record.dismissed = record.dismissed.filter((u) => u !== url);
    void this.persistAndRender();
  }

  private renderDismissedSection(container: HTMLElement, record: DocumentResearchData): void {
    if (record.dismissed.length === 0) return;
    const byTitle = new Map(
      record.suggestions.map((s) => [s.url, s.title || s.url] as const)
    );
    const section = container.createDiv("research-dismissed");
    const heading = section.createEl("button", { cls: "research-dismissed-heading" });
    heading.setText(
      this.dismissedOpen ? `Dismissed (${record.dismissed.length}) ▾` : `Dismissed (${record.dismissed.length}) ▸`
    );
    heading.setAttribute("aria-label", "Toggle dismissed results");
    heading.setAttribute("title", "Toggle dismissed results");
    heading.onclick = () => {
      this.dismissedOpen = !this.dismissedOpen;
      this.render();
    };
    if (!this.dismissedOpen) return;
    for (const url of record.dismissed) {
      const row = section.createDiv("research-dismissed-row");
      row.createSpan({ text: byTitle.get(url) ?? url, cls: "research-dismissed-title" });
      const undo = row.createSpan({ cls: "clickable-icon research-action" });
      setIcon(undo, "undo-2");
      undo.setAttribute("aria-label", "Undismiss");
      undo.setAttribute("title", "Undismiss");
      undo.onclick = () => this.undismissSuggestion(record, url);
    }
  }

  private async persistAndRender(): Promise<void> {
    try {
      if (this.record) await this.plugin.store.save(this.record);
    } catch (e) {
      console.error("Research panel: failed to save", e);
    }
    this.render();
  }

  private async analyzedDocument(file: TFile): Promise<AnalyzedDocument> {
    const cache = this.app.metadataCache.getFileCache(file);
    const headings = (cache?.headings ?? []).map((h) => h.heading);
    const tags = new Set<string>();
    for (const tag of cache?.tags ?? []) tags.add(tag.tag);
    const frontmatterTags = cache?.frontmatter?.tags;
    if (Array.isArray(frontmatterTags)) {
      for (const t of frontmatterTags) tags.add(String(t));
    } else if (typeof frontmatterTags === "string") {
      for (const t of frontmatterTags.split(/[,\s]+/)) tags.add(t);
    }
    const keywords = cache?.frontmatter?.keywords;
    const keywordList = Array.isArray(keywords)
      ? keywords.map(String)
      : typeof keywords === "string"
        ? keywords.split(",").map((k) => k.trim())
        : [];
    const rawContent = await this.app.vault.cachedRead(file);
    const bodyText = stripFrontmatter(rawContent);
    return {
      headings,
      tags: Array.from(tags),
      frontmatterKeywords: keywordList,
      bodyText,
    };
  }

  private async computeTopics(file: TFile, allowLlm: boolean, excludeTopics?: string[]): Promise<string[]> {
    const doc = await this.analyzedDocument(file);
    const lightweight = extractLightweightTopics(doc);
    const enoughWords = wordCount(doc.bodyText) >= MIN_WORDS_FOR_LLM;
    if (!allowLlm || !enoughWords || !this.hasEndpoint) return lightweight;
    try {
      this.busyLabel = "Extracting topics…";
      this.render();
      const topics = await this.plugin.llm.extractTopics(
        doc.bodyText,
        this.llmConfig(),
        excludeTopics
      );
      if (topics.length > 0) return topics;
    } catch (error) {
      this.llmError = `Topic extraction failed; using lightweight topics. ${String(error)}`;
    }
    return lightweight;
  }

  private llmConfig() {
    return llmConfigFrom(this.plugin.settings);
  }

  private async onReextractClicked(): Promise<void> {
    if (this.busy || this.reassessingUrl) return;
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    this.busy = true;
    this.errors = [];
    this.llmError = null;
    this.busyLabel = "Extracting topics…";
    this.render();
    try {
      const record = await this.plugin.store.getOrCreate(file.path, file.basename);
      const dismissed = new Set(record.dismissedTopics.map((t) => t.toLowerCase()));
      const existing = new Set(record.manualTopics.map((t) => t.toLowerCase()));
      const excludeTopics = [...existing, ...dismissed];
      const newTopics = await this.computeTopics(file, true, excludeTopics);
      const merged = [...record.manualTopics];
      for (const t of newTopics) {
        if (!existing.has(t.toLowerCase()) && !dismissed.has(t.toLowerCase())) {
          merged.push(t);
        }
      }
      record.manualTopics = merged;
      await this.plugin.store.save(record);
      this.record = record;
      if (newTopics.length > 0) {
        new Notice(`Extracted ${newTopics.length} new topics`);
      } else {
        new Notice("No new topics found — try adding headings, tags, or keywords");
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async onSearchClicked(): Promise<void> {
    if (this.busy || this.reassessingUrl) return;
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    this.busy = true;
    this.errors = [];
    this.llmError = null;
    this.connections = [];
    try {
      const record = await this.plugin.store.getOrCreate(file.path, file.basename);
      if (record.manualTopics.length === 0) {
        record.manualTopics = await this.computeTopics(file, true);
        await this.plugin.store.save(record);
      }
      if (record.manualTopics.length === 0) {
        new Notice("No topics available — add a topic chip first.");
        return;
      }
      const topics = [...record.manualTopics];
      const groups = await this.getGroups(record);
      this.busyLabel = "Searching…";
      this.render();
      const pinnedSuggestions = record.pinned
        .map((url) => record.suggestions.find((s) => s.url === url))
        .filter((s): s is Suggestion => Boolean(s));
      const dismissedSuggestions = record.dismissed
        .map((url) => record.suggestions.find((s) => s.url === url))
        .filter((s): s is Suggestion => Boolean(s));
      const { results, errors, connections } = await this.plugin.search.search(
        topics,
        this.plugin.settings.maxResults,
        {
          openAlexEmail: this.plugin.settings.openAlexEmail || undefined,
          s2ApiKey: this.plugin.settings.semanticScholarApiKey || undefined,
          groups,
          rotation: record.searchCount,
          relatedPins: this.plugin.settings.useRelatedFromPins
            ? pinnedSuggestions
            : [],
          dismissedPins: dismissedSuggestions,
          excludeUrls: [...record.pinned, ...record.dismissed],
        }
      );
      this.errors = errors;
      this.connections = connections;
      if (results.length > 0) {
        const priorSuggestions = record.suggestions;
        carrySummaries(priorSuggestions, results);
        const newUrls = new Set(results.map((r) => r.url));
        const keptPinned = priorSuggestions.filter(
          (s) => record.pinned.includes(s.url) && !newUrls.has(s.url)
        );
        record.suggestions = [...keptPinned, ...results];
      }
      record.searchCount += 1;
      await this.plugin.store.save(record);
      this.record = record;
      this.render();
      const doc = await this.analyzedDocument(file);
      await this.scoreAndSummarize(record, results, topics, doc.bodyText);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async getGroups(record: DocumentResearchData): Promise<string[][]> {
    const hash = topicSetHash(record.manualTopics);
    if (record.topicClusters && record.topicClusters.hash === hash) {
      return record.topicClusters.groups;
    }
    let groups: string[][] = record.manualTopics.map((t) => [t]);
    if (this.hasEndpoint && record.manualTopics.length > 1) {
      try {
        this.busyLabel = "Grouping topics…";
        this.render();
        groups = await this.plugin.llm.clusterTopics(
          record.manualTopics,
          this.llmConfig()
        );
      } catch (error) {
        this.llmError = `Topic grouping failed; searching topics individually. ${String(error)}`;
      }
    }
    record.topicClusters = { hash, groups };
    await this.plugin.store.save(record);
    return groups;
  }

  private async scoreAndSummarize(
    record: DocumentResearchData,
    candidates: Suggestion[],
    topics: string[],
    documentText: string
  ): Promise<void> {
    if (candidates.length === 0 || !this.hasEndpoint) return;
    const focus = {
      topics,
      document: documentText,
      ...sampleFeedback(record, record.searchCount),
    };
    try {
      this.busyLabel = "Scoring relevance…";
      this.render();
      const buckets = await this.plugin.llm.scoreBatch(focus, candidates, this.llmConfig());
      for (const candidate of candidates) {
        candidate.bucket = buckets.get(candidate.url) ?? "low";
      }
      await this.plugin.store.save(record);
      this.render();
    } catch (error) {
      this.llmError = `LLM scoring failed; results shown unscored. ${String(error)}`;
      this.render();
      return;
    }
    const targets = pickSummarizeTargets(candidates, SUMMARY_TOP_N);
    if (targets.length === 0) return;
    let done = 0;
    let failed = 0;
    let lastError: unknown = null;
    for (const candidate of targets) {
      this.busyLabel = `Summarizing (${done + 1}/${targets.length})…`;
      this.render();
      try {
        candidate.summary = await this.plugin.llm.summarize(
          focus,
          candidate,
          this.llmConfig()
        );
      } catch (error) {
        failed++;
        lastError = error;
      }
      done++;
      await this.plugin.store.save(record);
      this.render();
    }
    if (failed > 0) {
      this.llmError = `${failed} of ${targets.length} summaries failed — use ↻ on a card to retry. ${String(lastError)}`;
    }
  }

  private async onReassessClicked(suggestion: Suggestion): Promise<void> {
    if (this.busy || this.reassessingUrl) return;
    const record = this.record;
    const file = this.app.workspace.getActiveFile();
    if (!record || !file || file.extension !== "md") return;
    const target = record.suggestions.find((s) => s.url === suggestion.url);
    if (!target) return;
    if (!this.hasEndpoint) return;
    this.reassessingUrl = target.url;
    try {
      const focus = {
        topics: [...record.manualTopics],
        document: (await this.analyzedDocument(file)).bodyText,
        ...sampleFeedback(record, record.searchCount, target.url),
      };
      target.bucket = await this.plugin.llm.scoreSingle(
        focus,
        target,
        this.llmConfig()
      );
      await this.plugin.store.save(record);
      this.render();
      this.busyLabel = "Updating relevance note…";
      this.render();
      target.summary = await this.plugin.llm.summarize(focus, target, this.llmConfig());
      await this.plugin.store.save(record);
    } catch (error) {
      this.llmError = `Reassess relevance failed: ${String(error)}`;
    } finally {
      this.reassessingUrl = null;
      this.busyLabel = "";
      this.render();
    }
  }
}

function publicationLabel(s: Suggestion): string {
  if (s.date) return s.date;
  if (s.year != null) return String(s.year);
  return "";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}
