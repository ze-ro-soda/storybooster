import assert from 'node:assert/strict';
import { environment, loadModules } from '../vm-harness.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const correction = 'Preserve the established voice, careful judgment, and supported relationship-specific warmth. In the next reply, make a context-appropriate choice from the character’s own motives and follow through within the character’s control. Avoid repeatedly asking the user to decide the character’s actions. Keep the user free to respond or decline, and do not decide their thoughts, actions, dialogue, feelings or consent. Do not invent a new event or reset the current scene. Express the repair through an observable choice or action while preserving the already healthy traits and natural development.';

async function fixture({ configure = () => {}, developerMode = false } = {}) {
    const env = environment();
    env.context.chat = Array.from({ length: 10 }, (_, n) => [
        { is_user: true, mes: `The partner offers an option ${n}.` },
        { is_user: false, mes: `The investigator considers the option ${n}.` },
    ]).flat();
    env.context.getRequestHeaders = () => ({ 'X-CSRF-Token': 'fixture' });
    const bodies = [];
    let choose = (id, q) => id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present';
    env.globals.fetch = async (_url, options) => {
        const body = JSON.parse(JSON.parse(options.body).custom_include_body);
        bodies.push(body);
        return { ok: true, json: async () => ({ model: 'jev-test', answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
            const selected = choose(id, q);
            const choice = /^repetition__(match|pattern)_/.test(id) && !Object.hasOwn(q.criteria, selected) ? 'none' : selected;
            return [id, { type: 'choice', choice, confidence: 0.95, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
        })) }) };
    };
    configure(env);
    const m = await loadModules(env); await env.ready[0]();
    if (developerMode) m.namespace('core/debug-mode.js').unlockDeveloperMode('sb-debug');
    const storage = m.namespace('core/storage.js'), audit = m.namespace('features/audit.js');
    const diagnosis = m.namespace('features/jev-diagnosis.js'), client = m.namespace('core/jev-client.js');
    const settings = storage.ensureModuleSettings(), state = storage.ensureChatState();
    settings.jevEnabled = true; settings.jevConsentVersion = 1; settings.outputLanguage = 'en';
    state.genreSelection.primaryId = 'romance'; state.genreSelection.supportIds = ['mystery'];
    const identity = m.namespace('core/context.js').getCurrentCharacterIdentity();
    storage.writeCharacterBaselineVersion(identity, { fields: {
        core_identity: { text: 'A restrained independent investigator with firm boundaries.', pinned: true },
        relationship_response: { text: 'A trusted partner; increased warmth is supported within that relationship.' },
    }, boostAnchor: 'Preserve independent judgment, restraint and relationship-specific trust.', sourceHash: identity.sourceHash, updatedAt: Date.now() }, '');
    client.setJevSessionKey('synthetic-key');
    const selection = () => audit.getBoosterSelection(state);
    const run = scope => {
        const selected = audit.getScopedAuditSelection(selection(), scope);
        return diagnosis.runJevDiagnosis({ selection: selected, transcript: 'Numbered synthetic replies.', reviewedResponses: 10,
            schema: audit.buildGenreAuditJsonSchema(scope, 'en'), outputLanguage: 'en',
            parseResult: raw => audit.parseGenreAuditResult(raw, Boolean(selected.supportGenre), 10, scope, 'en', false) });
    };
    const feedback = (scope = 'combined', targets = []) => ({
        reasons: Object.fromEntries(diagnosis.getJevDimensions(audit.getScopedAuditSelection(selection(), scope)).map(d => [d.id,
            targets.includes(d.id) ? 'The character repeatedly defers independent judgment despite opportunities to act.' : 'The observed behavior remains appropriate to the scene and selected standard.'])),
        corrections: Object.fromEntries(targets.map(k => [k, correction])),
        next_corrections: Object.fromEntries(targets.map(code => [code, 'Let the next response reflect the established motive through a concrete choice.'])),
        character_focus_fields: targets.some(k => k.startsWith('character_') || k === 'char_agency') ? ['core_identity'] : [],
    });
    return { env, m, storage, audit, diagnosis, client, settings, state, bodies, selection, run, feedback,
        decide: fn => { choose = fn; } };
}


export { fixture };
