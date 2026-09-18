import { describe, expect, it } from "vitest";
import {
  activeProfile,
  llmConfigFrom,
  migrateLegacySettings,
  profileNameFromEndpoint,
} from "../../src/settings";
import type { LlmProfile } from "../../src/types";

function legacyData(): Record<string, unknown> {
  return {
    llmEndpoint: "http://localhost:11434/v1",
    llmApiKey: "secret",
    llmModel: "llama3.2",
    llmApiFormat: "openai",
    llmTemperature: "0.2",
    openAlexEmail: "me@example.com",
    maxResults: 15,
  };
}

describe("migrateLegacySettings", () => {
  it("creates one profile from legacy scalar settings and activates it", () => {
    const settings = migrateLegacySettings(legacyData());
    expect(settings.llmProfiles).toHaveLength(1);
    const profile = settings.llmProfiles[0];
    expect(profile.endpoint).toBe("http://localhost:11434/v1");
    expect(profile.apiKey).toBe("secret");
    expect(profile.model).toBe("llama3.2");
    expect(profile.format).toBe("openai");
    expect(profile.temperature).toBe("0.2");
    expect(profile.name).toBe("localhost:11434");
    expect(settings.activeProfileId).toBe(profile.id);
    expect(settings.openAlexEmail).toBe("me@example.com");
    expect(settings.maxResults).toBe(15);
  });

  it("uses Default for legacy data without an endpoint", () => {
    const settings = migrateLegacySettings({});
    const profile = settings.llmProfiles[0];
    expect(profile.endpoint).toBe("");
    expect(profile.name).toBe("Default");
    expect(settings.activeProfileId).toBe(profile.id);
  });

  it("defaults the related-work toggle on for fresh and legacy data", () => {
    expect(migrateLegacySettings({}).useRelatedFromPins).toBe(true);
    expect(migrateLegacySettings(legacyData()).useRelatedFromPins).toBe(true);
  });

  it("recreates a profile when the stored profile list is empty", () => {
    const data = { ...legacyData(), llmProfiles: [] };
    const settings = migrateLegacySettings(data);
    expect(settings.llmProfiles).toHaveLength(1);
    expect(settings.llmProfiles[0].endpoint).toBe("http://localhost:11434/v1");
  });

  it("passes through already-migrated settings untouched", () => {
    const profile: LlmProfile = {
      id: "p1",
      name: "Gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "key",
      model: "gemini-2.5-flash",
      format: "openai",
      temperature: "",
    };
    const data = {
      llmProfiles: [profile],
      activeProfileId: "p1",
      maxResults: 20,
    };
    const settings = migrateLegacySettings(data);
    expect(settings.llmProfiles).toEqual([profile]);
    expect(settings.activeProfileId).toBe("p1");
    expect(settings.maxResults).toBe(20);
  });

  it("falls back to the first profile when activeProfileId is stale", () => {
    const data = {
      llmProfiles: [
        { id: "a", name: "A", endpoint: "", apiKey: "", model: "", format: "openai", temperature: "" },
        { id: "b", name: "B", endpoint: "", apiKey: "", model: "", format: "openai", temperature: "" },
      ],
      activeProfileId: "missing",
    };
    const settings = migrateLegacySettings(data);
    expect(settings.activeProfileId).toBe("a");
  });
});

describe("llmConfigFrom", () => {
  it("resolves the active profile with temperature parsing", () => {
    const settings = migrateLegacySettings(legacyData());
    const config = llmConfigFrom(settings);
    expect(config.endpoint).toBe("http://localhost:11434/v1");
    expect(config.apiKey).toBe("secret");
    expect(config.model).toBe("llama3.2");
    expect(config.temperature).toBe(0.2);
  });

  it("omits temperature for blank or non-numeric values and defaults the key", () => {
    const settings = migrateLegacySettings({
      llmEndpoint: "http://x",
      llmTemperature: "abc",
    });
    const config = llmConfigFrom(settings);
    expect(config.temperature).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
    expect(config.model).toBe("gpt-4o-mini");
    settings.llmProfiles[0].temperature = "";
    expect(llmConfigFrom(settings).temperature).toBeUndefined();
  });

  it("falls back to the first profile when activeProfileId does not match", () => {
    const settings = migrateLegacySettings(legacyData());
    settings.llmProfiles.push({
      id: "p2",
      name: "Second",
      endpoint: "https://second.example/v1",
      apiKey: "",
      model: "m2",
      format: "openai",
      temperature: "0.1",
    });
    expect(activeProfile(settings).id).toBe(settings.llmProfiles[0].id);
    settings.activeProfileId = "p2";
    expect(llmConfigFrom(settings).endpoint).toBe("https://second.example/v1");
    expect(llmConfigFrom(settings).temperature).toBe(0.1);
  });
});

describe("profileNameFromEndpoint", () => {
  it("extracts the host and defaults for empty endpoints", () => {
    expect(profileNameFromEndpoint("https://api.anthropic.com/v1")).toBe(
      "api.anthropic.com"
    );
    expect(profileNameFromEndpoint("http://localhost:11434/v1/")).toBe(
      "localhost:11434"
    );
    expect(profileNameFromEndpoint("")).toBe("Default");
    expect(profileNameFromEndpoint("not a url")).toBe("Default");
  });
});
