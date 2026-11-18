// A single opt-in configuration per card; no transcripts, API keys or running state.
import { getCurrentChatId, getCurrentCharacterIdentity, isUnstartedRoleplay } from './context.js';
import { ensureModuleSettings, ensureChatState, getAvailableGenres, getCharacterBaselineVersionOptions, getCharacterBaselineVersion } from './storage.js';
import { saveSettingsDebounced } from './sillytavern.js';

let visited;
const choices = s => ({primary: s.genreSelection?.primaryId || '', support: s.genreSelection?.supportIds?.[0] || '',
    version: s.characterBoost?.baselineVersionId || '', secret: s.plotSecretMode === true, automatic: s.automaticPlot?.enabled === true});
const nonempty = c => Object.values(c).some(Boolean);
function location() {
    const id = getCurrentChatId(), identity = getCurrentCharacterIdentity();
    if (id === 'no-chat-open' || !identity?.key.startsWith('avatar:')) return null;
    const state = ensureChatState(id);
    if (state.carryOwner && state.carryOwner !== identity.key) return null;
    return {id, key: identity.key, state};
}
function record(loc) {
    const settings = ensureModuleSettings(), prefs = choices(loc.state);
    if (!settings.characterChatPreferences || typeof settings.characterChatPreferences !== 'object' || Array.isArray(settings.characterChatPreferences)) settings.characterChatPreferences = {};
    const table = settings.characterChatPreferences;
    table[loc.key] = { source: loc.id, ...prefs };
    loc.state.carryOwner = loc.key;
    delete loc.state.carryEligible;
    saveSettingsDebounced();
}
export function rememberChatPreferences() {
    const loc = location(); if (!loc) return;
    record(loc);
    if (visited?.state === loc.state) visited.start = JSON.stringify(choices(loc.state));
}
export function observeChatPreferences() {
    const loc = location();
    if (visited?.state !== loc?.state || visited?.key !== loc?.key) {
        if (visited && JSON.stringify(choices(visited.state)) !== visited.start) record(visited);
        visited = loc && { ...loc, start: JSON.stringify(choices(loc.state)) };
    }
    const saved = loc && ensureModuleSettings().characterChatPreferences?.[loc.key];
    if (loc && ((!saved && nonempty(choices(loc.state))) || (saved?.source === loc.id && JSON.stringify(choicesFromSource(saved)) !== JSON.stringify(choices(loc.state))))) record(loc);
}
function clean(loc, src) {
    const options = getAvailableGenres(), genre = id => options.find(g => g.id === id);
    const p = genre(src.primary), s = genre(src.support);
    const v = src.version && getCharacterBaselineVersionOptions(loc.key).find(x => x.id === src.version);
    return {primary:p?.id || '', support:s && s.id !== p?.id ? s.id : '', version:v?.id || '', secret:src.secret === true, automatic:src.automatic === true,
        label:[p?.label || '주 장르 없음', s && s.id !== p?.id ? s.label : '', v?.label || (getCharacterBaselineVersion(loc.key,'') ? '원본 기준' : '캐릭터 기준 없음'), src.secret ? '비밀 모드 켜짐' : '', '자동 랜덤박스 ' + (src.automatic ? '켜짐' : '꺼짐')].filter(Boolean).join(' · ')};
}
function fresh(loc) {
    return loc && !nonempty(choices(loc.state)) && !loc.state.genreAnchor.lastAudit && !loc.state.genreAnchor.correctionRemaining &&
        !loc.state.plotHistory?.length && !loc.state.plotShelf?.length && isUnstartedRoleplay();
}
export function takePreferenceOffer() {
    const loc = location(); if (!loc?.state.carryEligible) return null;
    delete loc.state.carryEligible; saveSettingsDebounced();
    const src = ensureModuleSettings().characterChatPreferences?.[loc.key];
    if (!fresh(loc) || !src || src.source === loc.id || !nonempty(choicesFromSource(src))) return null;
    const proposed = clean(loc, src);
    if (!nonempty(choicesFromSource(proposed))) return null;
    return { id:loc.id, key:loc.key, state:loc.state, proposed, epoch:visited, used:false };
}
function choicesFromSource({primary,support,version,secret,automatic}) { return {primary,support,version,secret,automatic}; }
export function acceptPreferenceOffer(offer) {
    const loc = location();
    if (!offer || offer.used || !fresh(loc) || loc.key !== offer.key || loc.id !== offer.id || loc.state !== offer.state || offer.epoch !== visited) return false;
    offer.used = true;
    const c = clean(loc, offer.proposed);
    if (JSON.stringify(c) !== JSON.stringify(offer.proposed)) return false;
    loc.state.genreSelection = { primaryId:c.primary || null, supportIds:c.support ? [c.support] : [] };
    loc.state.characterBoost.baselineVersionId = c.version;
    loc.state.plotSecretMode = c.secret;
    (loc.state.automaticPlot ||= {}).enabled = c.automatic;
    rememberChatPreferences(); return true;
}
