/** Re-Export-Fassade für die aus obsidian-kit vendorten Modell-Metadaten-Module.
 *  Historie: früher eigene Implementierung hier, jetzt in obsidian-kit extrahiert
 *  (model-context.ts 0.7.0, reasoning.ts 0.6.0) und vendored statt dupliziert. */
export type { ModelContext } from '../vendor/kit/model-context';
export { parseLmStudioContext, parseOllamaContext } from '../vendor/kit/model-context';
export { suppressParams, isAlwaysOnThinker } from '../vendor/kit/reasoning';
