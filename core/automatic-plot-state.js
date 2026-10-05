import { recordAutomaticPlotTrace } from "./automatic-plot-trace.js";
import { runtime } from './runtime.js';
import { PLOT_PROMPT_KEY } from './constants.js';
import { extension_prompt_types, setExtensionPrompt, saveSettingsDebounced } from './sillytavern.js';
import { getBoosterElement } from './dom.js';

const CONTEXT_CANCELLATION_REASONS = new Set(['chat_changed', 'key_changed', 'generation_stopped', 'profile_changed', 'language_changed']);

export const automaticPlotRuntime = { epoch: 0, contextEpoch: 0, genreEpoch: 0, characterEpoch: 0, lastContextCancellationReason: 'chat_changed', pending: null, generating: false, checking: false, armed: null, state: null, lastCancellationReason: 'plot_state_changed' };
export function cancelAutomaticPlot(reason = 'plot_state_changed') {
    automaticPlotRuntime.lastCancellationReason = (CONTEXT_CANCELLATION_REASONS.has(reason) || ['genre_changed', 'character_changed'].includes(reason)) ? reason : 'plot_state_changed';
    // Plot-only edits must not invalidate independent genre/character audits.
    // Shared context changes retain a separate epoch so chat round trips and
    // generation stops cannot revive an old audit after a later plot edit.
    if (CONTEXT_CANCELLATION_REASONS.has(reason)) {
        automaticPlotRuntime.contextEpoch++;
        automaticPlotRuntime.lastContextCancellationReason = reason;
    }
    if (reason === 'genre_changed') automaticPlotRuntime.genreEpoch++;
    if (reason === 'character_changed') automaticPlotRuntime.characterEpoch++;
    const traceId = automaticPlotRuntime.pending?.traceId || automaticPlotRuntime.checkingTraceId || automaticPlotRuntime.preparingTraceId || automaticPlotRuntime.armed?.traceId;
    if (traceId) recordAutomaticPlotTrace(traceId, 'cancelled', { reason: automaticPlotRuntime.lastCancellationReason });
    automaticPlotRuntime.epoch++;
    automaticPlotRuntime.pending = null;
    automaticPlotRuntime.controller?.abort();
    automaticPlotRuntime.controller = null;
    // Only clear prompts owned by automatic plot; manual plot is independent.
    if (automaticPlotRuntime.armed && runtime.currentPlotInjectionText === automaticPlotRuntime.armed.prompt) {
        automaticPlotRuntime.armed.cancelled = true;
        setExtensionPrompt(PLOT_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        runtime.currentPlotInjectionText = '';
        runtime.plotPending = false;
    }
    automaticPlotRuntime.armed = null;
    const prefs = automaticPlotRuntime.state?.automaticPlot;
    if (prefs && ['observing', 'preparing', 'ready'].includes(prefs.status)) {
        prefs.status = 'idle'; prefs.lastDecision = '';
        saveSettingsDebounced();
        const status = getBoosterElement('rp-automatic-plot-status');
        if (status) { status.textContent = ''; status.hidden = true; }
    }
    automaticPlotRuntime.state = null;
    const cancel = getBoosterElement('rp-automatic-plot-cancel');
    if (cancel) { cancel.hidden = true; cancel.disabled = true; }
}
