export class Plugin {}
export class ItemView {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export class Menu {}
export class TFolder {}
export class TFile {}
export class WorkspaceLeaf {}

export function setIcon(): void {}
export function requestUrl(): { status: number; text: string } {
  return { status: 0, text: "" };
}
