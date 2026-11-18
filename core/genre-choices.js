import { GENRE_BOOST_CORRECTION_CODES } from './constants.js';
import { getLatestAssistantMessageId } from './context.js';
import { removeLiveCorrectionCodes } from './storage.js';
import { cancelAutomaticPlot } from './automatic-plot-state.js';
import { rememberChatPreferences } from './chat-preferences.js';

export function applyGenreChoices(state, primary, support) {
    primary = primary || null;
    support = support && support !== primary ? support : null;
    const old = state.genreSelection;
    if (old.primaryId === primary && (old.supportIds[0] || null) === support) return false;
    const anchor = state.genreAnchor;
    const armed = anchor.correctionArmedRevision > 0 && anchor.correctionArmedRevision === anchor.correctionRevision;
    const removed = removeLiveCorrectionCodes(anchor, old.primaryId !== primary ? GENRE_BOOST_CORRECTION_CODES : ['support_texture'], { emptyStatus: 'waiting' });
    if (removed && armed && anchor.correctionRemaining) anchor.correctionArmedRevision = anchor.correctionRevision;
    state.genreSelection = { primaryId: primary, supportIds: support ? [support] : [] };
    anchor.responseCount = 0;
    anchor.lastCountedMessageId = getLatestAssistantMessageId();
    cancelAutomaticPlot('genre_changed');
    rememberChatPreferences();
    return true;
}
