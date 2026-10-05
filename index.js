// StoryBooster entry point: bind UI callbacks, then initialize exactly once.
import { registerUiHooks } from './core/ui-hooks.js';
import { initializeStoryBooster } from './app/bootstrap.js';
import { safelyUpdateCharacterBoosterPanel, safelyUpdateGenreAnchorPanel, updateCharacterBaselineActionStates, updateGenreAnchorPanel } from './ui/panels.js';
import { populateGenreSelectionControls } from './ui/genre-controls.js';
import { automaticPlotGenerationInterceptor } from './features/automatic-plot.js';

globalThis.storyboosterAutomaticPlotInterceptor = automaticPlotGenerationInterceptor;

registerUiHooks({ populateGenreSelectionControls, safelyUpdateCharacterBoosterPanel, safelyUpdateGenreAnchorPanel, updateCharacterBaselineActionStates, updateGenreAnchorPanel });
initializeStoryBooster();
