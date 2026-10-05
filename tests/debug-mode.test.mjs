import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers/diagnosis-fixture.mjs';
import { environment, loadModules } from './vm-harness.mjs';

const commands = new Map();
const f = await fixture({ configure: env => {
    env.context.SlashCommand = { fromProps: props => props };
    env.context.SlashCommandParser = { addCommandObject: props => commands.set(props.name, props) };
} });
const mode = f.m.namespace('core/debug-mode.js');
const ui = f.m.namespace('ui/debug-tools.js');
const tools = f.m.namespace('ui/tools.js');
assert.equal(mode.isDeveloperModeUnlocked(), false);
assert.ok(commands.has('sb-debug'));
assert.ok(!commands.has('sb-auto-test'));
assert.equal(await f.audit.runAutomaticAuditTest(), null);
assert.equal(f.bodies.length, 0);

// Capture mounted popup nodes and replace descendants when innerHTML changes.
let popupId = '', popupCount = 0, popupOptions;
const actions = new Map();
const password = { value: '', focus() {} };
const error = { hidden: true, textContent: '' };
const root = {
    html: '',
    set innerHTML(value) { this.html = value; actions.clear(); },
    get innerHTML() { return this.html; },
    querySelector(selector) {
        if (selector === '.rp-debug-password') return this.html.includes('rp-debug-password') ? password : null;
        if (selector === '.rp-debug-unlock-error') return error;
        const exists = this.html.includes(selector.slice(1));
        return exists ? { disabled: false, addEventListener: (event, callback) => actions.set(`${selector}:${event}`, callback) } : null;
    },
};
f.env.context.POPUP_TYPE = { TEXT: 1 };
f.env.context.callGenericPopup = (html, _type, _value, options) => { popupCount++; popupOptions = options; popupId = html.match(/id="([^"]+)"/)[1]; };
f.env.globals.document.getElementById = id => id === popupId ? root : null;
tools.openAuditRunTraceLog(); assert.equal(popupCount, 0);
await commands.get('sb-debug').callback();
assert.equal(popupCount, 1);
assert.match(root.innerHTML, /type="text"/);
assert.match(root.innerHTML, />개발자 도구 열기</);
assert.equal(popupOptions.okButton, '닫기');
assert.ok(!root.innerHTML.includes('자동진단 테스트'));
assert.ok(!root.innerHTML.includes('sb-debug'));
password.value = 'incorrect';
actions.get('.rp-debug-unlock-form:submit')({ preventDefault() {} });
assert.equal(mode.isDeveloperModeUnlocked(), false); assert.equal(password.value, '');
assert.equal(error.hidden, false); assert.equal(f.bodies.length, 0);
password.value = 'sb-debug';
actions.get('.rp-debug-unlock-form:submit')({ preventDefault() {} });
assert.equal(mode.isDeveloperModeUnlocked(), true); assert.equal(password.value, '');
assert.ok(root.innerHTML.includes('자동진단 테스트'));
assert.ok(commands.has('sb-auto-test')); assert.ok(commands.has('sb-audit-log'));

// The unlocked tool is the same automatic path; after locking, even a retained
// command/button callback cannot call the API again.
const oldTest = actions.get('.rp-debug-auto-test:click');
f.env.responses([JSON.stringify(f.feedback())]);
await oldTest({ currentTarget: { disabled: false } });
assert.equal(f.bodies.length, 2);
assert.equal(f.state.genreAnchor.lastAudit.mode, 'auto');
actions.get('.rp-debug-lock:click')();
assert.equal(mode.isDeveloperModeUnlocked(), false);
assert.ok(!root.innerHTML.includes('자동진단 테스트'));
await oldTest({ currentTarget: { disabled: false } });
await commands.get('sb-auto-test').callback();
assert.equal(f.bodies.length, 2);
assert.equal(await f.audit.runAutomaticAuditTest(), null);

// Hidden title gesture does not open anything until its fifth tap. Keyboard
// activation follows the same path and there is no visible settings tool.
const titleActions = new Map();
ui.wireDeveloperModeEntry({ querySelector: () => ({ addEventListener: (event, callback) => titleActions.set(event, callback) }) });
const before = popupCount;
for (let n = 0; n < 4; n++) titleActions.get('click')({});
assert.equal(popupCount, before);
titleActions.get('click')({ preventDefault() {}, stopPropagation() {} });
assert.equal(popupCount, before + 1);
for (let n = 0; n < 5; n++) titleActions.get('keydown')({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
assert.equal(popupCount, before + 2);
const source = fs.readFileSync(new URL('../ui/popup.js', import.meta.url), 'utf8');
assert.ok(!source.includes('rp-test-auto-audit'));
assert.ok(!source.includes('rp-audit-debug-tools'));

// No password or unlocked flag is persisted; a new page/module instance locks
// again without changing normal diagnosis or stored Jev credentials.
assert.ok(!f.env.globals.sessionStorage.getItem('storybooster.audit-runs.v1').includes('sb-debug'));
const reload = environment();
const fresh = await loadModules(reload);
assert.equal(fresh.namespace('core/debug-mode.js').isDeveloperModeUnlocked(), false);
console.log('Developer tools: hidden settings, visible development password, incorrect/correct unlock, locked APIs/commands, five-tap and keyboard entry, relock and refresh passed.');
