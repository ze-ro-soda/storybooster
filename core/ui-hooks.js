// UI callbacks are registered before initialization. Core and feature modules
// call this boundary instead of importing the popup and panel implementations.
let callbacks = null;
export function registerUiHooks(next) {
    for (const name of ["populateGenreSelectionControls","safelyUpdateCharacterBoosterPanel","safelyUpdateGenreAnchorPanel","updateCharacterBaselineActionStates","updateGenreAnchorPanel"]) {
        if (typeof next[name] !== 'function') throw new TypeError('Missing UI hook: ' + name);
    }
    callbacks = Object.freeze({ ...next });
}
export function populateGenreSelectionControls(...args) {
    if (!callbacks) throw new Error('StoryBooster UI hooks are not initialized');
    return callbacks.populateGenreSelectionControls(...args);
}
export function safelyUpdateCharacterBoosterPanel(...args) {
    if (!callbacks) throw new Error('StoryBooster UI hooks are not initialized');
    return callbacks.safelyUpdateCharacterBoosterPanel(...args);
}
export function safelyUpdateGenreAnchorPanel(...args) {
    if (!callbacks) throw new Error('StoryBooster UI hooks are not initialized');
    return callbacks.safelyUpdateGenreAnchorPanel(...args);
}
export function updateCharacterBaselineActionStates(...args) {
    if (!callbacks) throw new Error('StoryBooster UI hooks are not initialized');
    return callbacks.updateCharacterBaselineActionStates(...args);
}
export function updateGenreAnchorPanel(...args) {
    if (!callbacks) throw new Error('StoryBooster UI hooks are not initialized');
    return callbacks.updateGenreAnchorPanel(...args);
}
