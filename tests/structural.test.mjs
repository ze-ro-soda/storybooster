import { throwIfRequestAborted } from "../core/request-lifecycle.js";
import { requestFailureDetails } from "../core/response-validation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readModuleSource } from "./helpers/read-modules.mjs";
import vm from "node:vm";

const source = readModuleSource();
const noop = () => {};
function functionSource(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf("\n}\n", start) + 2);
}
function harness(names, globals = {}) {
    const context = vm.createContext({ console, throwIfRequestAborted, requestFailureDetails, ...globals });
    vm.runInContext(names.map(functionSource).join("\n"), context);
    return context;
}
const errorWithCode = (code) => Object.assign(new Error(code), { code });
const payloadFunctions = [
    "extractJsonObject", "requireStructuredTextFields", "parseJsonOrTaggedPayload",
    "extractTaggedPlotEventResult", "parsePlotEventResult",
    "extractTaggedCharacterAnchorResult", "parseCharacterBoostAnchorResult",
    "normalizeCharacterBaselineRevisionPayload",
];
const fields = [{ id: "identity", label: "Identity" }, { id: "relationship", label: "Relationship" }];
const payloads = harness(payloadFunctions, {
    extractTextFromGenerationData: (value) => String(value ?? "").trim(),
    CHARACTER_BOOST_ANCHOR_MAX_CHARS: 700,
    CHARACTER_BASELINE_FIELD_MAX_CHARS: 1000,
    CHARACTER_BASELINE_FIELDS: fields,
});
for (const value of [null, [], {}, 123, true]) {
    assert.throws(() => payloads.parsePlotEventResult(JSON.stringify({ event: value })),
        (error) => error.code === "STORYBOOSTER_INVALID_FIELDS");
}
for (const value of [null, [], "text", {}]) {
    assert.throws(() => payloads.parsePlotEventResult(JSON.stringify(value)),
        (error) => error.code === "STORYBOOSTER_REQUIRED_FIELDS_MISSING");
}
assert.equal(payloads.parsePlotEventResult('<plot_event>A note containing {} reveals a clue.</plot_event>', { allowTagged: true }),
    "A note containing {} reveals a clue.");
assert.equal(payloads.parsePlotEventResult('Example: {}\n<plot_event>A door opens.</plot_event>', { allowTagged: true }), "A door opens.");
assert.equal(payloads.parsePlotEventResult('{"event":"A note contains <plot_event> as a label."}', { allowTagged: true }),
    "A note contains <plot_event> as a label.");
assert.throws(() => payloads.parsePlotEventResult("<plot_event>A door opens", { allowTagged: true }),
    (error) => error.code === "STORYBOOSTER_INCOMPLETE_TAGGED_OUTPUT");
assert.throws(() => payloads.parsePlotEventResult("unrecognizable text", { allowTagged: true }),
    (error) => error.code === "STORYBOOSTER_REQUIRED_FIELDS_MISSING");
assert.match(payloads.parseCharacterBoostAnchorResult(
    "<boost_anchor>Keep the note marked {} private and preserve the character's established boundaries.</boost_anchor>",
    "en", { allowTagged: true }).boostAnchor, /\{\}/);
assert.throws(() => payloads.parseCharacterBoostAnchorResult('{"boost_anchor":["a very long invalid anchor","with extra text"]}', "en"),
    (error) => error.code === "STORYBOOSTER_INVALID_FIELDS");
assert.throws(() => payloads.normalizeCharacterBaselineRevisionPayload({ fields: { identity: {}, relationship: "A sufficiently long relationship." } }, { fields: {} }),
    (error) => error.code === "STORYBOOSTER_INVALID_FIELDS");

const retryFunctions = ["shouldRetryStructuredJsonCompatibility", "getStructuredJsonCompatibilityReason",
    "requestStructuredJsonWithCompatibility", "shouldRetryCharacterAnchorWithoutSchema", "shouldRetryPlotEventWithoutSchema"];
let structuredCalls = [];
const retry = harness(retryFunctions, {
    generateStructuredAnalysis: async (options) => {
        structuredCalls.push(options);
        throw errorWithCode("STORYBOOSTER_TRUNCATED_JSON");
    },
});
for (const sourceType of ["main", "profile"]) {
    for (const name of ["shouldRetryStructuredJsonCompatibility", "shouldRetryCharacterAnchorWithoutSchema", "shouldRetryPlotEventWithoutSchema"]) {
        assert.equal(retry[name](errorWithCode("STORYBOOSTER_TRUNCATED_JSON"), { source: sourceType }), true);
        assert.equal(retry[name](errorWithCode("STORYBOOSTER_REQUEST_TIMEOUT"), { source: sourceType }), false);
        assert.equal(retry[name](Object.assign(new Error("Unauthorized"), { status: 401 }), { source: sourceType }), false);
    }
    structuredCalls = [];
    const diagnostic = { retryCount: 0 };
    await assert.rejects(retry.requestStructuredJsonWithCompatibility({
        prompt: "test", transcript: "test", jsonSchema: {}, responseLength: 1200,
        connectionSnapshot: { source: sourceType }, diagnostic, parseResult: (value) => value,
    }), (error) => error.code === "STORYBOOSTER_TRUNCATED_JSON");
    assert.equal(structuredCalls.length, 3);
    assert.equal(structuredCalls[1].jsonSchema, null);
    assert.equal(structuredCalls[2].responseLength, 4800);
    assert.equal(diagnostic.retryCount, 2);
}

// Exercise actual save functions, including the original-to-revision autosave
// transition, rather than only looking for guard strings in the source.
const settings = { outputLanguage: "en", chats: {
    chat_A: { characterBoost: { baselineVersionId: "revision_A" } },
    chat_B: { characterBoost: { baselineVersionId: "" } },
}, characterBaselines: {} };
let currentIdentity = { key: "avatar:B", name: "Character B" };
let currentChat = "chat_B";
const baseline = {
    fields: { identity: { text: "Established identity description.", pinned: false },
        relationship: { text: "{{user}} is a trusted partner.", pinned: false } },
    boostAnchor: "Existing English anchor", sourceHash: "hash", boostAnchorNeedsRefresh: false,
};
const baselines = new Map([
    ["avatar:A|revision_A", structuredClone(baseline)],
    ["avatar:A|", structuredClone(baseline)],
    ["avatar:B|", structuredClone(baseline)],
]);
const editors = [];
let writes = 0, creates = 0, invalidations = 0;
const saves = harness([
    "getCurrentCharacterBaseline", "getCharacterEditTarget", "resolveCharacterSaveTarget",
    "updateCharacterEditorSaveTarget", "saveCharacterBaselineField", "saveCharacterBoostAnchor",
], {
    getCurrentCharacterIdentity: () => currentIdentity,
    getCurrentChatId: () => currentChat,
    ensureModuleSettings: () => settings,
    ensureChatState: (id) => settings.chats[id],
    ensureCharacterBoostState: (state) => state.characterBoost,
    getCharacterBaselineVersion: (key, id = "") => structuredClone(baselines.get(`${key}|${id}`) || null),
    getCharacterBaselineVersionStore: () => ({ versions: {} }),
    getCharacterBaselineVersionOptions: () => [],
    getCharacterBaselineFieldDefinition: (id) => fields.find((field) => field.id === id),
    getBoosterElements: () => editors,
    MAX_CHARACTER_BASELINE_VERSIONS: 10, CHARACTER_BASELINE_FIELD_MAX_CHARS: 1000, CHARACTER_BOOST_ANCHOR_MAX_CHARS: 700,
    writeCharacterBaselineVersion: (identity, value, id) => {
        writes++; baselines.set(`${identity.key}|${id}`, structuredClone(value)); return true;
    },
    createCharacterBaselineVersion: (identity, value, { chatId }) => {
        const id = `new_${++creates}`;
        baselines.set(`${identity.key}|${id}`, structuredClone(value));
        settings.chats[chatId].characterBoost.baselineVersionId = id;
        return { id };
    },
    invalidateCharacterAuditAfterBaselineChange: () => { invalidations++; },
    saveSettingsDebounced: noop, setCharacterFieldSaveStatus: noop,
    safelyUpdateGenrePrompt: () => true, safelyUpdateGenreAnchorPanel: noop,
});
const target = { identity: { key: "avatar:A", name: "Character A" }, chatId: "chat_A", versionId: "revision_A" };
assert.equal(saves.saveCharacterBaselineField("relationship", "New relationship description.", { target: { ...target } }), true);
assert.equal(settings.chats.chat_A.characterBoost.baselineVersionId, "revision_A");
assert.equal(baselines.get("avatar:B|").fields.relationship.text, baseline.fields.relationship.text);
assert.equal(saves.saveCharacterBoostAnchor({ canonicalText: "New English anchor", displayText: "New English anchor", displayLanguage: "en" }, target), true);
assert.equal(settings.chats.chat_A.characterBoost.baselineVersionId, "revision_A");

const unchangedTarget = { ...target, versionId: "", originalText: baseline.fields.relationship.text,
    originalDisplayText: "Persona A is a trusted partner." };
const countsBefore = [writes, creates, invalidations];
assert.equal(saves.saveCharacterBaselineField("relationship", unchangedTarget.originalDisplayText, { target: unchangedTarget }), true);
assert.deepEqual([writes, creates, invalidations], countsBefore);
assert.equal(baselines.get("avatar:A|").fields.relationship.text, "{{user}} is a trusted partner.");
assert.equal(baselines.get("avatar:A|").boostAnchorNeedsRefresh, false);
assert.equal(saves.saveCharacterBaselineField("relationship", "A change.", { target: { ...target, versionId: "deleted" } }), false);

currentIdentity = { key: "avatar:A", name: "Character A" };
currentChat = "chat_A";
settings.chats.chat_A.characterBoost.baselineVersionId = "revision_A";
const editor = { dataset: { identityKey: "avatar:A", characterName: "Character A", chatId: "chat_A",
    baselineVersionId: "", fieldId: "relationship", originalText: baseline.fields.relationship.text,
    originalDisplayText: "Persona A is a trusted partner." }, value: "First real edit." };
editors.push(editor);
assert.equal(saves.saveCharacterBaselineField("relationship", editor.value, { target: saves.getCharacterEditTarget(editor) }), true);
assert.equal(creates, 1); // An explicit original must not fall through to revision_A.
assert.equal(editor.dataset.baselineVersionId, "new_1");
editor.value = "Second real edit.";
assert.equal(saves.saveCharacterBaselineField("relationship", editor.value, { target: saves.getCharacterEditTarget(editor) }), true);
assert.equal(creates, 1);
assert.equal(baselines.get("avatar:A|new_1").fields.relationship.text, "Second real edit.");
const beforeNoOp = [writes, creates, invalidations];
assert.equal(saves.saveCharacterBaselineField("relationship", editor.value, { target: saves.getCharacterEditTarget(editor) }), true);
assert.deepEqual([writes, creates, invalidations], beforeNoOp);

// Draft edits survive re-rendering. Newly pinned fields cannot be approved.
const proposals = new Map();
let current = { identity: { key: "avatar:A", name: "Character A" }, versionId: "revision_A", baseline: structuredClone(baseline) };
let anchorCalls = 0, createdBaseline = null, anchorEffect = noop;
const notices = [];
const proposalKey = "chat_A::avatar:A";
const container = { dataset: { proposalKey, proposalCreatedAt: "1" } };
const elements = new Map();
function reviewElement(id, type, value) {
    const element = { dataset: { fieldId: id }, closest: () => container,
        classList: { contains: (name) => name === `rp-character-revision-${type}` },
        ...(type === "include" ? { checked: value } : { value }) };
    elements.set(`${type}:${id}`, element);
    return element;
}
const revision = harness([
    "getCharacterRevisionProposalKey", "getCharacterRevisionBaselineSignature", "ensureCharacterRevisionReview",
    "captureCharacterRevisionReview", "renderCharacterBaselineRevisionProposal", "escapeHtml",
    "applyCharacterBaselineRevisionProposal",
], {
    CHARACTER_BASELINE_FIELDS: fields, CHARACTER_BASELINE_FIELD_MAX_CHARS: 1000,
    CHARACTER_REVISION_ASSISTANT_REPLIES: 20, MAX_CHARACTER_BASELINE_VERSIONS: 10,
    characterBaselineRevisionProposals: proposals, characterBaselinePendingTasks: new Map(),
    getCurrentChatId: () => "chat_A", getCurrentCharacterBaseline: () => structuredClone(current),
    getCharacterBaselineVersionOptions: () => [], getCharacterBaselineFieldDefinition: (id) => fields.find((field) => field.id === id),
    resolveRoleMacrosForDisplay: (value) => value.replaceAll("{{user}}", "Persona A"),
    getActiveBoosterPopupRoot: () => ({ querySelector: (selector) => {
        const id = selector.match(/data-field-id="([^"]+)"/)?.[1];
        return elements.get(`${selector.includes("-include") ? "include" : "field"}:${id}`);
    } }),
    ensureModuleSettings: () => ({ outputLanguage: "en" }),
    createOperationContextSnapshot: (value) => value, createOperationDiagnostic: (value) => value,
    normalizeCharacterBaseline: structuredClone, safelyUpdateCharacterBoosterPanel: noop,
    resolveBackgroundConnectionSnapshot: async () => ({ source: "main" }), updateOperationDiagnosticConnection: noop,
    requestCharacterBoostAnchor: async () => { anchorCalls++; anchorEffect(); return { boostAnchor: "Anchor", boostAnchorDisplay: "Anchor" }; },
    isBoosterFeatureEnabled: () => true, isOperationContextCurrentChat: () => true, isOperationContextCurrentCharacter: () => true,
    createCharacterBaselineVersion: (identity, value) => { createdBaseline = value; return { label: "New version" }; },
    invalidateCharacterAuditAfterBaselineChange: noop, saveSettingsDebounced: noop,
    safelyUpdateGenrePrompt: noop, safelyUpdateGenreAnchorPanel: noop,
    toastr: { warning: (message) => notices.push(message), error: (message) => notices.push(message) },
    recordStoryBoosterError: noop, MODULE_NAME: "test", console: { error: noop },
});
function newProposal() {
    const proposal = { identityKey: "avatar:A", chatId: "chat_A", baseVersionId: "revision_A", baseVersionLabel: "Original",
        baseContentSignature: revision.getCharacterRevisionBaselineSignature(current.baseline),
        fields: { identity: { text: "New identity with established boundaries.", reason: "Requested change" },
            relationship: { text: "{{user}} is now a more trusted partner.", reason: "Requested change" } },
        changedFields: ["identity", "relationship"], createdAt: 1, mode: "directed" };
    proposals.set(proposalKey, proposal);
    elements.clear();
    for (const { id } of fields) {
        reviewElement(id, "include", true);
        reviewElement(id, "field", revision.ensureCharacterRevisionReview(proposal)[id].text);
    }
    return proposal;
}
let proposal = newProposal();
revision.captureCharacterRevisionReview(reviewElement("identity", "include", false));
revision.captureCharacterRevisionReview(reviewElement("relationship", "field", "A manually reviewed relationship <draft>."));
const firstRender = revision.renderCharacterBaselineRevisionProposal(current, "chat_A");
assert.match(firstRender, /A manually reviewed relationship &lt;draft&gt;/);
assert.doesNotMatch(firstRender.match(/<input[^>]+data-field-id="identity"[^>]*>/)[0], /checked/);
assert.equal(revision.renderCharacterBaselineRevisionProposal(current, "chat_A"), firstRender);
current.baseline.fields.relationship.pinned = true;
assert.match(revision.renderCharacterBaselineRevisionProposal(current, "chat_A"), /고정 · 현재 내용 유지/);
await revision.applyCharacterBaselineRevisionProposal();
assert.equal(anchorCalls, 0); // one unchecked, the other now pinned
assert.equal(createdBaseline, null);
elements.get("include:identity").checked = true;
await revision.applyCharacterBaselineRevisionProposal();
assert.equal(anchorCalls, 1);
assert.equal(createdBaseline.fields.relationship.text, baseline.fields.relationship.text);
assert.equal(createdBaseline.fields.relationship.pinned, true);

proposal = newProposal();
current.baseline.fields.identity.text = "Changed in place after proposal generation.";
await revision.applyCharacterBaselineRevisionProposal();
assert.equal(anchorCalls, 1);
assert.equal(proposals.get(proposalKey), proposal); // keep draft for the user
assert.match(notices.at(-1), /기준 내용이 변경/);

proposal = newProposal();
createdBaseline = null;
anchorEffect = () => { current.baseline.fields.identity.pinned = true; };
await revision.applyCharacterBaselineRevisionProposal();
assert.equal(anchorCalls, 2);
assert.equal(createdBaseline, null); // late pin change cannot write an old snapshot
assert.equal(proposals.get(proposalKey), proposal);

// Run the actual nested plot request + validation block. Every semantic and
// compatibility repair shares the same total budget on both connection paths.
const plotStart = source.indexOf("        let plotAttempts = 0;");
const plotEnd = source.indexOf('        if (!isBoosterFeatureEnabled("plot")) {', plotStart);
assert.ok(plotStart > 0 && plotEnd > plotStart);
const plotCode = `(async () => { ${source.slice(plotStart, plotEnd)} return eventText; })()`;
async function runPlot(responses, sourceType = "main") {
    const calls = [];
    const diagnostic = { retryCount: 0 };
    const context = harness([...payloadFunctions,
        "shouldRetryPlotEventWithoutSchema", "shouldRetryTaggedPlotEvent",
        "getPlotCandidateFormatIssues", "isRoleplayLikePlotCandidate", "isPlotOutputLanguageMismatch"], {
        extractTextFromGenerationData: (value) => String(value ?? "").trim(),
        MAX_PLOT_GENERATION_ATTEMPTS: 3, CHARACTER_BASELINE_FIELDS: fields,
        generateStructuredAnalysis: async (options) => {
            calls.push(options);
            const response = responses[calls.length - 1];
            if (response instanceof Error) throw response;
            return response;
        },
        plotPrompt: "test", plotTaggedOutputInstruction: "tags", plotJsonOutputInstruction: "JSON",
        plotTranscript: "test", plotJsonSchema: {}, plotTokenBudget: 1200,
        connectionSnapshot: { source: sourceType }, plotDiagnostic: diagnostic,
        status: {}, surpriseType: "", plotOutputLanguage: "ko", getPlotOutputInstruction: () => "Korean",
    });
    try { return { result: await vm.runInContext(plotCode, context), calls, diagnostic }; }
    catch (error) { return { error, calls, diagnostic }; }
}
for (const sourceType of ["main", "profile"]) {
    const failed = await runPlot([
        errorWithCode("STORYBOOSTER_TRUNCATED_JSON"),
        "<plot_event>unfinished", "<plot_event>This scene is a completed scene.</plot_event>",
    ], sourceType);
    assert.equal(failed.calls.length, 3);
    assert.equal(failed.diagnostic.retryCount, 2);
    assert.equal(failed.error.code, "STORYBOOSTER_REQUEST_BUDGET_EXHAUSTED");
    const success = await runPlot([
        '{"event":"This scene is a completed scene."}',
        '{"event":"A sealed door opens and exposes a hidden path."}',
        '{"event":"잠긴 문이 열리며 숨겨진 통로가 드러나 일행에게 새로운 선택을 남긴다."}',
    ], sourceType);
    assert.equal(success.calls.length, 3);
    assert.equal(success.diagnostic.retryCount, 2);
    assert.match(success.result, /숨겨진 통로/);
    const taggedSuccess = await runPlot([
        "{}", "<plot_event>A sealed door opens.</plot_event>",
        "<plot_event>잠긴 문이 열리며 새로운 통로가 드러난다.</plot_event>",
    ], sourceType);
    assert.equal(taggedSuccess.calls.length, 3);
    assert.equal(taggedSuccess.calls[2].jsonSchema, null); // remember successful compatibility mode
    assert.match(taggedSuccess.result, /새로운 통로/);
}
console.log("StoryBooster 1.7.0 structural regressions passed.");
