import { createSettingsStore } from '../../src/lib/settings.mjs';
import { createAiSettings } from '../../src/lib/ai-settings.mjs';

// Production-shaped wiring. Legacy vault APIs stay available only to tests that
// intentionally seed an old installation before migration.
export function sharedAiSettings({ pool, appSecret, ...options }) {
  const vault = createSettingsStore({ pool, appSecret, ...options });
  const aiSettings = createAiSettings({ pool, settings: vault, appSecret });
  const settings = { ...vault, ...aiSettings.classification };
  const assistantSettings = aiSettings.assistant;
  const saveAi = async (input) =>
    aiSettings.save({
      revision: (await aiSettings.getPublic()).discoveryRevision,
      ...input
    });
  const saveClassification = async (input) =>
    settings.saveProvider({
      aiRevision: (await aiSettings.getPublic()).discoveryRevision,
      ...input
    });
  const saveAssistant = async (input) =>
    assistantSettings.save({
      aiRevision: (await aiSettings.getPublic()).discoveryRevision,
      ...input
    });
  return { vault, aiSettings, settings, assistantSettings, saveAi, saveClassification, saveAssistant };
}
