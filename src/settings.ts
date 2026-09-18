import { PluginSettingTab, App, Notice, Setting, DropdownComponent } from "obsidian";
import type { ResearchPanelPlugin } from "./main";
import type { LLMConfig } from "./services/LLMService";
import type { CitationFormat, LlmApiFormat, LlmProfile, PluginSettings } from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
  llmProfiles: [],
  activeProfileId: "",
  openAlexEmail: "",
  semanticScholarApiKey: "",
  defaultCitationFormat: "apa",
  maxResults: 10,
  useRelatedFromPins: true,
};

export function newProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function profileNameFromEndpoint(endpoint: string): string {
  const m = /^https?:\/\/([^/?#]+)/.exec(endpoint.trim());
  return m ? m[1] : "Default";
}

export function activeProfile(settings: PluginSettings): LlmProfile {
  const profiles = settings.llmProfiles;
  return (
    profiles.find((p) => p.id === settings.activeProfileId) ?? profiles[0]
  );
}

export function llmConfigFrom(settings: PluginSettings): LLMConfig {
  const profile = activeProfile(settings);
  const raw = profile.temperature.trim();
  const parsed = raw ? Number(raw) : NaN;
  return {
    endpoint: profile.endpoint,
    apiKey: profile.apiKey || undefined,
    model: profile.model || "gpt-4o-mini",
    format: profile.format,
    temperature: raw && Number.isFinite(parsed) ? parsed : undefined,
  };
}

export function migrateLegacySettings(
  loaded: Record<string, unknown>
): PluginSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(loaded as Partial<PluginSettings>) };
  const profiles = merged.llmProfiles;
  if (profiles && profiles.length > 0) {
    if (!profiles.some((p) => p.id === merged.activeProfileId)) {
      merged.activeProfileId = profiles[0].id;
    }
    return merged;
  }
  const legacy = loaded as {
    llmEndpoint?: unknown;
    llmApiKey?: unknown;
    llmModel?: unknown;
    llmApiFormat?: unknown;
    llmTemperature?: unknown;
  };
  const endpoint =
    typeof legacy.llmEndpoint === "string" ? legacy.llmEndpoint : "";
  const profile: LlmProfile = {
    id: newProfileId(),
    name: profileNameFromEndpoint(endpoint),
    endpoint,
    apiKey: typeof legacy.llmApiKey === "string" ? legacy.llmApiKey : "",
    model: typeof legacy.llmModel === "string" ? legacy.llmModel : "",
    format: legacy.llmApiFormat === "anthropic" ? "anthropic" : "openai",
    temperature:
      typeof legacy.llmTemperature === "string" ? legacy.llmTemperature : "",
  };
  return { ...merged, llmProfiles: [profile], activeProfileId: profile.id };
}

const CITATION_FORMATS: Array<{ value: CitationFormat; label: string }> = [
  { value: "apa", label: "APA" },
  { value: "mla", label: "MLA" },
  { value: "chicago", label: "Chicago" },
  { value: "plain", label: "Plain URL" },
];

const API_FORMATS: Array<{ value: LlmApiFormat; label: string }> = [
  {
    value: "openai",
    label: "OpenAI-compatible (Ollama, LM Studio, OpenAI, OpenRouter, Groq…)",
  },
  { value: "anthropic", label: "Anthropic (api.anthropic.com)" },
];

export class ResearchPanelSettingTab extends PluginSettingTab {
  private editingId: string | null = null;
  private activeProfileDropdown: DropdownComponent | null = null;
  private manageProfileDropdown: DropdownComponent | null = null;

  constructor(app: App, private readonly plugin: ResearchPanelPlugin) {
    super(app, plugin);
  }

  private async persist(): Promise<void> {
    await this.plugin.saveSettings();
    this.plugin.refreshPanelView();
  }

  private updateProfileOptionLabels(profile: LlmProfile): void {
    const label = profile.name || profile.endpoint || profile.id;
    for (const dropdown of [this.activeProfileDropdown, this.manageProfileDropdown]) {
      if (!dropdown) continue;
      const option = dropdown.selectEl.querySelector(
        `option[value="${profile.id}"]`
      );
      if (option) option.textContent = label;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;
    const profiles = settings.llmProfiles;
    if (profiles.length === 0) {
      profiles.push({
        id: newProfileId(),
        name: "Default",
        endpoint: "",
        apiKey: "",
        model: "",
        format: "openai",
        temperature: "",
      });
    }
    const profileOptions = Object.fromEntries(
      profiles.map((p) => [p.id, p.name || p.endpoint || p.id])
    );

    new Setting(containerEl).setName("LLM profiles").setHeading();
    this.activeProfileDropdown = null;
    this.manageProfileDropdown = null;
    new Setting(containerEl)
      .setName("Active profile")
      .setDesc("The LLM endpoint the research panel uses right now; also switchable from the panel header.")
      .addDropdown((dropdown) => {
        this.activeProfileDropdown = dropdown;
        return dropdown
          .addOptions(profileOptions)
          .setValue(activeProfile(settings).id)
          .onChange(async (value) => {
            settings.activeProfileId = value;
            await this.persist();
          });
      });

    if (this.editingId == null || !profiles.some((p) => p.id === this.editingId)) {
      this.editingId = activeProfile(settings).id;
    }
    const manage = new Setting(containerEl)
      .setName("Edit profile")
      .setDesc("Choose a profile to edit its fields below, or add a new one.");
    manage.addDropdown((dropdown) => {
      this.manageProfileDropdown = dropdown;
      return dropdown
        .addOptions(profileOptions)
        .setValue(this.editingId ?? profiles[0].id)
        .onChange((value) => {
          this.editingId = value;
          this.display();
        });
    });
    manage
      .addButton((button) =>
        button.setButtonText("New").onClick(async () => {
          const profile: LlmProfile = {
            id: newProfileId(),
            name: `Profile ${profiles.length + 1}`,
            endpoint: "",
            apiKey: "",
            model: "",
            format: "openai",
            temperature: "",
          };
          settings.llmProfiles = [...profiles, profile];
          this.editingId = profile.id;
          await this.persist();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("Delete").onClick(async () => {
          const editing = profiles.find((p) => p.id === this.editingId);
          if (!editing) return;
          const remaining = profiles.filter((p) => p.id !== editing.id);
          if (remaining.length === 0) return;
          settings.llmProfiles = remaining;
          if (settings.activeProfileId === editing.id) {
            settings.activeProfileId = remaining[0].id;
          }
          this.editingId = settings.activeProfileId;
          await this.persist();
          this.display();
        })
      );

    const editing = profiles.find((p) => p.id === this.editingId);
    if (editing) this.renderProfileFields(containerEl, editing);

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Sends a one-word prompt with the active profile's endpoint, key, and model.")
      .addButton((button) =>
        button.setButtonText("Test connection").onClick(async () => {
          button.setDisabled(true).setButtonText("Testing…");
          try {
            const reply = await this.plugin.llm.ping(llmConfigFrom(settings));
            new Notice(
              `Connection OK — model replied: ${reply.slice(0, 40) || "(empty)"}`
            );
          } catch (error) {
            new Notice(`Connection failed: ${String(error)}`);
          } finally {
            button.setDisabled(false).setButtonText("Test connection");
          }
        })
      );

    new Setting(containerEl).setName("Academic APIs").setHeading();
    new Setting(containerEl)
      .setName("OpenAlex contact email")
      .setDesc(
        "Enters the polite pool with better rate limits; no key required."
      )
      .addText((text) =>
        text
          .setPlaceholder("you@example.com")
          .setValue(settings.openAlexEmail)
          .onChange(async (value) => {
            settings.openAlexEmail = value.trim();
            await this.persist();
          })
      );
    new Setting(containerEl)
      .setName("Semantic Scholar API key")
      .setDesc(
        "Recommended: authenticated requests get a guaranteed 1 req/sec."
      )
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(settings.semanticScholarApiKey)
          .onChange(async (value) => {
            settings.semanticScholarApiKey = value.trim();
            await this.persist();
          })
      );

    new Setting(containerEl).setName("Results").setHeading();
    new Setting(containerEl)
      .setName("Default citation format")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(
            Object.fromEntries(CITATION_FORMATS.map((f) => [f.value, f.label]))
          )
          .setValue(settings.defaultCitationFormat)
          .onChange(async (value) => {
            settings.defaultCitationFormat =
              value as CitationFormat;
            await this.persist();
          })
      );
    new Setting(containerEl)
      .setName("Max results per search")
      .setDesc("Candidates fetched per refresh before LLM scoring.")
      .addSlider((slider) =>
        slider
          .setLimits(5, 30, 5)
          .setValue(settings.maxResults)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.maxResults = value;
            await this.persist();
          })
      );
    new Setting(containerEl)
      .setName("Find related work from pinned papers")
      .setDesc(
        "Each refresh also looks up papers citing your pins (OpenAlex) and similar papers (Semantic Scholar recommendations), steering away from dismissed ones."
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.useRelatedFromPins).onChange(async (value) => {
          settings.useRelatedFromPins = value;
          await this.persist();
        })
      );
  }

  private renderProfileFields(
    containerEl: HTMLElement,
    profile: LlmProfile
  ): void {
    const textField = (
      name: string,
      desc: string,
      placeholder: string,
      key: "name" | "endpoint" | "apiKey" | "model" | "temperature"
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          text
            .setPlaceholder(placeholder)
            .setValue(profile[key])
            .onChange(async (value) => {
              profile[key] = value.trim();
              if (key === "name") this.updateProfileOptionLabels(profile);
              await this.plugin.saveSettings();
            });
          if (key === "name") {
            text.inputEl.addEventListener("blur", () =>
              this.plugin.refreshPanelView()
            );
          }
          return text;
        });
    };
    textField("Profile name", "Shown in the profile dropdowns.", "e.g. Local ollama", "name");
    textField(
      "Endpoint URL",
      "OpenAI-compatible chat completions endpoint (Ollama, LM Studio, OpenAI, OpenRouter, Groq, or Google's free Gemini tier), or the Anthropic base URL.",
      "http://localhost:11434/v1  |  https://generativelanguage.googleapis.com/v1beta/openai",
      "endpoint"
    );
    new Setting(containerEl)
      .setName("API format")
      .setDesc("Request/response shape used by the endpoint.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(
            Object.fromEntries(API_FORMATS.map((f) => [f.value, f.label]))
          )
          .setValue(profile.format)
          .onChange(async (value) => {
            profile.format = value as LlmApiFormat;
            await this.plugin.saveSettings();
          })
      );
    textField("API key", "Leave empty for local servers without auth.", "sk-...", "apiKey");
    textField("Model", "", "llama3.2  |  gemini-2.5-flash  |  claude-3-haiku", "model");
    textField(
      "Temperature",
      "Optional sampling temperature. Leave empty to omit the parameter entirely (recommended for reasoning models like o1, which reject it).",
      "0.2",
      "temperature"
    );
  }
}
