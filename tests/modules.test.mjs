import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { declarations, root, verifyDeclarationParity, changedDeclarations } from './helpers/read-modules.mjs';

assert.equal(typeof vm.SourceTextModule, 'function', 'Run with node --experimental-vm-modules');
const records = verifyDeclarationParity();
assert.equal(records.filter(record => record.kind === 'FunctionDeclaration').length, 279);
const fixture = fs.readFileSync(new URL('tests/fixtures/storybooster-1.5.6.js', root), 'utf8');
const bridgeNames = fs.readFileSync(new URL('core/sillytavern.js', root), 'utf8').match(/export \{([^}]+)\}/)[1].split(',').map(name => name.trim());
const clone = value => JSON.parse(JSON.stringify(value));
function legacyProjection(value) {
    const copy = clone(value);
    function visit(v) {
        if (!v || typeof v !== 'object') return;
        // Only the two newly introduced opt-in preferences and schema revision
        // are projected away. Every old saved field is compared unchanged.
        delete v.jevEnabled; delete v.jevConsentVersion; delete v.automaticPlot;
        delete v.auditHistory; delete v.analysis; delete v.comparison;
        delete v.correctionByCode; delete v.correctionSummaries; delete v.feedbackConnection;
        if ([23,24,25].includes(v.settingsSchemaVersion)) v.settingsSchemaVersion = 22;
        Object.values(v).forEach(visit);
    }
    visit(copy); return copy;
}
const noop = () => {};
const fixedTime = 1790726400000;

function environment() {
    const listeners = new Map(), ready = [], prompts = [], requests = [], errors = [], intervals = [], notices = [];
    let responses = [], saves = 0;
    const storage = new Map();
    const settings = {};
    const context = {
        chatId: 'chat_A', characterId: 0, name1: 'Persona A', name2: 'Character A',
        characters: [{ avatar: 'character-A.png', data: { name: 'Character A',
            description: 'A reserved investigator.', personality: 'Observant and independent.', mes_example: 'Choose carefully.' } }],
        chat: [{ is_user: true, mes: 'Inspect the room.' }, { is_user: false, mes: 'The investigator checks the door.' }],
    };
    const respond = (...args) => {
        requests.push(args.map(value => value && typeof value === 'object' ? clone(value) : value));
        if (!responses.length) throw new Error('Unexpected AI request');
        const value = responses.shift();
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    };
    context.generateRawData = respond;
    context.ConnectionManagerRequestService = { sendRequest: respond };
    const event_types = Object.fromEntries(['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'CHARACTER_EDITED',
        'CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'CHAT_CHANGED'].map(name => [name, name]));
    const st = { extension_settings: settings, getContext: () => context,
        saveSettingsDebounced: () => { saves++; }, event_types,
        eventSource: { on: (name, callback) => { const callbacks = listeners.get(name) || []; callbacks.push(callback); listeners.set(name, callbacks); } },
        extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0 },
        setExtensionPrompt: (...args) => prompts.push(clone(args)),
    };
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedTime])); } static now() { return fixedTime; } }
    const globals = { ...st, AbortController, URL, Date: FixedDate, Intl, structuredClone,
        Math: Object.assign(Object.create(Math), { random: () => 0.375 }),
        console: { log: noop, warn: noop, debug: noop, error: (...args) => errors.push(args.map(String)) },
        jQuery: callback => ready.push(callback),
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop },
        sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
        toastr: Object.fromEntries(['error', 'warning', 'info', 'success'].map(name => [name, (...args) => notices.push([name, ...args])])),
        setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval: noop,
        setTimeout, clearTimeout,
    };
    globals.window = globals;
    return { context, st, globals, ready, prompts, requests, errors, notices, listeners, settings, intervals,
        responses: values => { responses = [...values]; requests.length = 0; }, saves: () => saves };
}

async function loadModules(env) {
    const context = vm.createContext(env.globals);
    const modules = new Map(), edges = new Map();
    const base = fileURLToPath(root);
    function get(filename) {
        if (modules.has(filename)) return modules.get(filename);
        let module;
        if (filename === path.join(base, 'core/sillytavern.js')) {
            // Verify host paths separately; replace only host APIs with controlled fixtures.
            const source = fs.readFileSync(filename, 'utf8');
            assert.match(source, /from "\.\.\/\.\.\/\.\.\/\.\.\/extensions\.js"/);
            assert.match(source, /from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/script\.js"/);
            module = new vm.SyntheticModule(bridgeNames, function () {
                for (const name of bridgeNames) this.setExport(name, env.st[name]);
            }, { context, identifier: filename });
        } else {
            module = new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), { context, identifier: filename });
        }
        modules.set(filename, module);
        return module;
    }
    const entry = get(path.join(base, 'index.js'));
    await entry.link((specifier, referring) => {
        assert.ok(specifier.startsWith('.'), 'Only explicit local imports are expected');
        const target = path.resolve(path.dirname(referring.identifier), specifier);
        assert.ok(target.startsWith(base), 'Only the host bridge may reference external files');
        const outgoing = edges.get(referring.identifier) || new Set(); outgoing.add(target); edges.set(referring.identifier, outgoing);
        return get(target);
    });
    await entry.evaluate();
    const visiting = new Set(), visited = new Set();
    function visit(filename) {
        assert.ok(!visiting.has(filename), 'Circular module import: ' + filename);
        if (visited.has(filename)) return;
        visiting.add(filename); for (const next of edges.get(filename) || []) visit(next);
        visiting.delete(filename); visited.add(filename);
    }
    visit(entry.identifier);
    const getFunction = name => {
        const owner = declarations.find(record => record.names.includes(name))?.owner;
        assert.ok(owner, name);
        return get(path.join(base, owner)).namespace[name];
    };
    return { get: getFunction, modules, runtime: get(path.join(base, 'core/runtime.js')).namespace.runtime };
}

const legacy = environment(), modern = environment();
const oldContext = vm.createContext(legacy.globals);
const legacySource = fixture.replace(/^import \{[\s\S]*?\} from "[^"\n]+";\n/gm, '');
vm.runInContext(legacySource, oldContext);
const old = name => vm.runInContext(name, oldContext);
const current = await loadModules(modern);
assert.equal(modern.ready.length, 1);
assert.equal(legacy.ready.length, 1);
await legacy.ready[0](); await modern.ready[0]();
assert.deepEqual(modern.errors, []);
assert.deepEqual(legacyProjection(modern.settings), clone(legacy.settings));
assert.deepEqual(modern.prompts, legacy.prompts);
assert.equal(modern.saves(), legacy.saves());
assert.deepEqual([...modern.listeners.keys()], [...legacy.listeners.keys()]);
for (const callbacks of modern.listeners.values()) assert.equal(callbacks.length, 1);
assert.equal(modern.intervals.length, legacy.intervals.length);

function same(name, ...args) {
    const expected = old(name)(...structuredClone(args));
    const actual = current.get(name)(...structuredClone(args));
    const project = (value, modern = false) => {
        if (name === 'createDefaultModuleSettings') return legacyProjection(value);
        if (name === 'getGenreSelectionSignature' && modern) return value.replace(/^auto-plot:off::/, '');
        if (name === 'renderBoosterPopupHtml') {
            if (modern) value = value.replaceAll('표현 반복을', '표현 다양성을').replace(/<div class="rp-recommend-actions">\s*(<button id="rp-recommend-apply-btn"[^]*?<\/button>)\s*<button id="rp-recommend-cancel-btn"[^]*?<\/button>\s*<\/div>/, '$1').replace(/            <details class="rp-baseline-backup">[\s\S]*?<\/details>\n/, '')
                .replace(/        <details class="rp-automatic-plot-settings">[\s\S]*?<\/details>\n\n/, '\n')
                .replace(/            <div class="rp-booster-heading-statuses">\n/g, '')
                .replace(/            <div id="rp-(?:genre|character)-jev-status"[^\n]+\n            <\/div>\n/g, '');
            return value.replace(/\s+/g, ' ').trim();
        }
        return clone(value);
    };
    assert.deepEqual(project(actual, true), project(expected), name);
    return actual;
}
same('createDefaultModuleSettings');
same('getCurrentRoleDisplayNames');
same('getCurrentCharacterIdentity');
same('getRoleplayTranscript', { assistantRepliesWithUserContext: 20 });
same('resolveRoleMacrosForDisplay', '{{char}} trusts {{user}}.');
same('getGenreSelectionSignature', { primaryId: 'romance', supportIds: ['mystery'] });
same('renderBoosterPopupHtml', 'test-popup');
same('parsePlotEventResult', '{"event":"A note appears under the door."}');
same('parseCharacterBoostAnchorResult', '<boost_anchor>Preserve restrained dialogue, established boundaries, independent decisions, and the investigator\'s deliberate manner.</boost_anchor>', 'en', { allowTagged: true });

// Persisted settings are shared by UI, audit, character and plot modules.
const moduleName = 'rp-genre-plot-booster';
const identity = current.get('getCurrentCharacterIdentity')();
const baseline = { fields: { core_identity: { text: 'A reserved investigator with firm personal boundaries.', pinned: true },
    relationship_response: { text: '{{user}} is a trusted partner.' } },
    boostAnchor: 'Preserve restrained dialogue and independent decisions.', sourceHash: identity.sourceHash, updatedAt: fixedTime };
for (const get of [old, current.get]) {
    get('ensureModuleSettings')().outputLanguage = 'en';
    get('ensureChatState')().genreSelection = { primaryId: 'mystery', supportIds: ['romance'] };
}
same('writeCharacterBaselineVersion', identity, baseline, '');
same('getCharacterBoosterReadiness');
same('createCharacterBaselineVersion', identity, baseline, { chatId: 'chat_A', revisionMode: 'directed', evidenceLevel: 'limited' });
same('getCharacterBaselineVersionOptions', identity);
same('renderBoosterPopupHtml', 'test-popup');
old('updateGenrePrompt')(); current.get('updateGenrePrompt')();
assert.deepEqual(modern.prompts, legacy.prompts);
assert.equal(current.runtime.currentStoryInjectionText, vm.runInContext('currentStoryInjectionText', oldContext));
assert.match(current.runtime.currentStoryInjectionText, /PRIMARY GENRE/);
assert.match(current.runtime.currentStoryInjectionText, /restrained dialogue/);

// A one-shot injection is consumed by the same persistent event handler.
for (const get of [old, current.get]) get('triggerPlotEvent')('A letter arrives.', 'test');
assert.equal(current.runtime.plotPending, true);
assert.deepEqual(modern.prompts, legacy.prompts);
for (const env of [legacy, modern]) await env.listeners.get('MESSAGE_RECEIVED')[0](1);
assert.equal(current.runtime.plotPending, false);
assert.equal(current.runtime.currentPlotInjectionText, '');
assert.deepEqual(modern.prompts, legacy.prompts);

// Real imported request path: schema -> schema-free JSON -> final repair.
for (const source of ['main', 'profile']) {
    const snapshot = { source, profileId: 'profile_A', apiType: 'openai' };
    const diagnostics = [], results = [];
    for (const [env, get] of [[legacy, old], [modern, current.get]]) {
        env.responses(['{}', '{"event":', '{"event":"A note reveals a useful clue."}']);
        const diagnostic = get('createOperationDiagnostic')({ task: 'module_retry_test' });
        const result = await get('requestStructuredJsonWithCompatibility')({ prompt: 'Return an event.', transcript: 'A quiet room.',
            jsonSchema: { name: 'test_event', schema: { type: 'object' } }, responseLength: 1200, connectionSnapshot: snapshot,
            task: 'module_retry_test', diagnostic, parseResult: get('parsePlotEventResult') });
        results.push(result); diagnostics.push(diagnostic);
        assert.equal(env.requests.length, 3);
        assert.equal(diagnostic.requestCount, 3); assert.equal(diagnostic.retryCount, 2);
    }
    assert.equal(results[0], results[1]);
    assert.deepEqual(modern.requests, legacy.requests);
    for (const key of ['requestCount', 'retryCount', 'compatibilityFallback', 'retryReason', 'method']) assert.equal(diagnostics[0][key], diagnostics[1][key], key);
}

// Character anchors still recover empty JSON with tagged output.
for (const [env, get] of [[legacy, old], [modern, current.get]]) {
    env.responses(['{}', '<boost_anchor>Preserve restrained dialogue, firm personal boundaries, and independent investigative decisions.</boost_anchor>']);
    const result = await get('requestCharacterBoostAnchor')({ identity, baseline, outputLanguage: 'en', connectionSnapshot: { source: 'main' },
        diagnostic: get('createOperationDiagnostic')({ task: 'anchor_test' }) });
    assert.match(result.boostAnchor, /restrained dialogue/);
    assert.equal(env.requests.length, 2);
}
assert.deepEqual(modern.requests, legacy.requests);

// Plot generation executes against the imported transport and shared store.
for (const [env, get] of [[legacy, old], [modern, current.get]]) {
    const elements = new Map(['rp-event-result-wrap', 'rp-event-result', 'rp-event-status', 'rp-event-generate-btn', 'rp-plot-idea'].map(id => [id,
        { value: '', textContent: '', dataset: {}, style: {}, focus: noop, classList: { toggle: noop, add: noop, remove: noop }, setAttribute: noop }]));
    const popup = { isConnected: true, dataset: { plotMode: 'free' }, querySelector: selector => elements.get(selector.slice(1)) || null,
        querySelectorAll: () => [], classList: { toggle: noop } };
    env.globals.document.querySelectorAll = selector => selector === '#rp-booster-popup' ? [popup] : [];
    env.responses(['{}', '<plot_event>A sealed letter arrives at the investigator\'s door.</plot_event>']);
    await get('generateEventCandidate')('generate');
    assert.equal(env.requests.length, 2);
    assert.match(elements.get('rp-event-result').value, /sealed letter/);
    popup.isConnected = false;
    env.globals.document.querySelectorAll = () => [];
}
assert.deepEqual(modern.requests, legacy.requests);
assert.deepEqual(legacyProjection(modern.settings), clone(legacy.settings));

// Switching chats clears transient injection without losing character versions.
for (const [env, get] of [[legacy, old], [modern, current.get]]) {
    get('triggerPlotEvent')('A bell rings.', 'test');
    env.context.chatId = 'chat_B';
    await env.listeners.get('CHAT_CHANGED')[0]();
}
assert.equal(current.runtime.plotPending, false);
assert.equal(current.runtime.currentPlotInjectionText, '');
same('getCharacterBaselineVersionOptions', identity);
assert.deepEqual(legacyProjection(modern.settings), clone(legacy.settings));
assert.deepEqual(modern.prompts, legacy.prompts);
assert.deepEqual(modern.errors, []);
assert.ok(modern.settings[moduleName].chats.chat_A);
assert.ok(modern.settings[moduleName].chats.chat_B);
console.log(`Module loading, ${records.length - changedDeclarations.size} unchanged declaration comparisons, initialization, UI, storage, retries and chat events passed (${current.modules.size} modules).`);
