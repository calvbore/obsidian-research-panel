import { Notice, Plugin, TFolder, WorkspaceLeaf } from "obsidian";
import { ObsidianHttp, VaultFileSystem } from "./adapters/obsidian";
import { LLMService } from "./services/LLMService";
import { SearchService } from "./services/SearchService";
import { ResearchStore } from "./stores/ResearchStore";
import { ResearchPanelView, VIEW_TYPE_RESEARCH_PANEL } from "./views/ResearchPanelView";
import { migrateLegacySettings, ResearchPanelSettingTab } from "./settings";
import type { PluginSettings } from "./types";

export class ResearchPanelPlugin extends Plugin {
  declare settings: PluginSettings;
  store!: ResearchStore;
  search!: SearchService;
  llm!: LLMService;

  async onload(): Promise<void> {
    await this.loadSettings();

    const http = new ObsidianHttp();
    this.store = new ResearchStore(new VaultFileSystem(this.app.vault));
    this.search = new SearchService({ http });
    this.llm = new LLMService(http);

    this.registerView(
      VIEW_TYPE_RESEARCH_PANEL,
      (leaf: WorkspaceLeaf) => new ResearchPanelView(leaf, this)
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFolder) {
          void this.store.handleFolderRename(oldPath, file.path);
        } else {
          void this.store.handleFileRename(oldPath, file.path);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFolder) {
          void this.store.handleFolderDelete(file.path);
        } else {
          void this.store.handleFileDelete(file.path);
        }
      })
    );

    this.addRibbonIcon("graduation-cap", "Open research panel", () => {
      void this.activateView();
    });
    this.addCommand({
      id: "open-research-panel",
      name: "Open research panel",
      callback: () => {
        void this.activateView();
      },
    });
    this.addSettingTab(new ResearchPanelSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Record<string, unknown>;
    this.settings = migrateLegacySettings(loaded ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshPanelView(): void {
    const { workspace } = this.app;
    if (!workspace?.getLeavesOfType) return;
    for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_RESEARCH_PANEL)) {
      const view = leaf.view;
      if (view instanceof ResearchPanelView) view.refresh();
    }
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_RESEARCH_PANEL);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open research panel");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_RESEARCH_PANEL, active: true });
    workspace.revealLeaf(leaf);
  }
}

export default ResearchPanelPlugin;
