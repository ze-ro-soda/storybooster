import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const declarations = JSON.parse(fs.readFileSync(new URL('tests/helpers/declaration-map.json', root), 'utf8'));

assert.equal(typeof vm.SourceTextModule, 'function', 'Run with node --experimental-vm-modules');
const fixture = fs.readFileSync(new URL('tests/fixtures/storybooster-1.5.6.js', root), 'utf8');
const bridgeNames = fs.readFileSync(new URL('core/sillytavern.js', root), 'utf8').match(/export \{([^}]+)\}/)[1].split(',').map(name => name.trim());
const clone = value => JSON.parse(JSON.stringify(value));
const noop = () => {};
const fixedTime = 1790726400000;

export function environment() {
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
        'CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'CHAT_CHANGED', 'GENERATION_STOPPED'].map(name => [name, name]));
    const st = { accountsEnabled: true, extension_settings: settings, getContext: () => context,
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

export async function loadModules(env) {
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
            assert.match(source, /from "\.\.\/\.\.\/\.\.\/\.\.\/user\.js"/);
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
    return { get: getFunction, namespace: file => get(path.join(base, file)).namespace, modules, runtime: get(path.join(base, 'core/runtime.js')).namespace.runtime };
}
