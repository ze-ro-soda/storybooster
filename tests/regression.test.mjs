import { completeLegacyPolicyFixture } from './helpers/legacy-policy-fixture.mjs';
import { addLegacyAuditPolicySchema, finalizeLegacyAudit as strictFinalizeLegacyAudit, legacyAuditPolicyPrompt } from '../features/legacy-diagnosis.js';
import { runAbortableRequest, throwIfRequestAborted } from "../core/request-lifecycle.js";
import { requestFailureDetails } from "../core/response-validation.js";
import { normalizeAuditAnalysis, normalizeAuditComparison, normalizeAuditHistory, markAuditHistoryApplied } from '../core/audit-history.js';
import assert from "node:assert/strict";
import fs from "node:fs";
import { readModuleSource } from "./helpers/read-modules.mjs";

// Historical extraction fixtures supply explicit new schema observations.
const finalizeLegacyAudit = (result, parsed, language) => strictFinalizeLegacyAudit(result, completeLegacyPolicyFixture(parsed), language, true);

// Extraction-only tests stub cancellation; actual cancellation is tested in automatic-plot.test.mjs.
const cancelAutomaticPlot = () => {};
const normalizeAuditCorrections = () => ({}); // Legacy fixtures contain no per-code custom text; imported-path tests cover it.
const root = new URL("../", import.meta.url);
const source = readModuleSource();
const css = fs.readFileSync(new URL("style.css", root), "utf8");
const readme = fs.readFileSync(new URL("README.md", root), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", root), "utf8"));

assert.equal(manifest.version, "1.7.1");
function functionSource(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
    assert.ok(start >= 0, `Missing function: ${name}`);
    return source.slice(start, source.indexOf("\n}\n", start) + 2);
}
const structuredPayloadHelpers = ["requireStructuredTextFields", "parseJsonOrTaggedPayload"].map(functionSource).join("\n");
assert.ok(css.trim().length > 0);
assert.match(source, /settingsSchemaVersion:\s*25/);
assert.match(source, /delete state\.characterBoost\.enabled/);
assert.doesNotMatch(source, /state\.characterBoost\.enabled\s*=/);
assert.doesNotMatch(source, /characterBoost:\s*\{\s*enabled:/);

// Settings migration/normalization is load-time work. Repeated getters must
// return the prepared object without rebuilding normalized collections.
assert.match(source, /const preparedModuleSettings = new WeakSet\(\)/);
assert.match(source, /function createDefaultModuleSettings\(/);
assert.match(source, /function migrateModuleSettings\(/);
assert.match(source, /function normalizeModuleSettings\(/);
const moduleSettingsStart = source.indexOf("function createDefaultModuleSettings(");
const moduleSettingsEnd = source.indexOf(
    "function isBoosterFeatureEnabled(",
    moduleSettingsStart
);
assert.ok(moduleSettingsStart >= 0 && moduleSettingsEnd > moduleSettingsStart);
const moduleSettingsHelpers = {};
eval(`
    const MODULE_NAME = "rp-genre-plot-booster";
    const DEFAULT_PLOT_MAX_TOKENS = 1200;
    const MIN_PLOT_MAX_TOKENS = 200;
    const MAX_PLOT_MAX_TOKENS = 4000;
    const DEFAULT_AUDIT_INTERVAL = 10;
    const MIN_AUDIT_INTERVAL = 5;
    const MAX_AUDIT_INTERVAL = 15;
    const EVENT_CATEGORIES = [{ id: "information" }];
    const extension_settings = {
        [MODULE_NAME]: {
            chats: {},
            customGenres: [{ id: "custom-one", label: " Custom " }],
            customPlotCategories: [],
            characterBaselines: {},
            characterBaselineVersions: {},
            plotMaxTokens: 9999,
            outputLanguage: "ko",
            characterCardChangeDetection: true,
            selectedPlotCategoryId: "information",
            analysisProfileId: "",
            plotProfileId: "",
            auditInterval: 10,
            enabledFeatures: { genre: true, character: true, plot: true },
            settingsSchemaVersion: 22,
        },
    };
    const normalizeCharacterBaselineVersionStore = (value) => ({
        nextNumber: Number.isSafeInteger(value?.nextNumber) ? value.nextNumber : 1,
        versions: value?.versions && typeof value.versions === "object" ? value.versions : {},
    });
    const preparedModuleSettings = new WeakSet();
    const saveSettingsDebounced = () => {};
    const getCurrentChatId = () => "test-chat";
    ${source.slice(moduleSettingsStart, moduleSettingsEnd)}
    moduleSettingsHelpers.ensure = ensureModuleSettings;
    moduleSettingsHelpers.migrate = migrateModuleSettings;
`);
const preparedSettings = moduleSettingsHelpers.ensure();
const preparedGenres = preparedSettings.customGenres;
assert.equal(preparedGenres[0].label, "Custom");
assert.equal(preparedSettings.plotMaxTokens, 4000);
assert.match(source, /const MAX_PLOT_MAX_TOKENS = 4000/);
assert.match(source, /max="\$\{MAX_PLOT_MAX_TOKENS\}"/);
assert.match(source, /Math\.min\(roundedValue, MAX_PLOT_MAX_TOKENS\)/);
assert.equal(moduleSettingsHelpers.ensure(), preparedSettings);
assert.equal(moduleSettingsHelpers.ensure().customGenres, preparedGenres);
const legacySettings = {
    settingsSchemaVersion: 17,
    chats: {
        legacy: {
            characterBoost: { enabled: true },
            plotSecretMode: true,
        },
    },
    characterBaselines: {},
};
assert.equal(moduleSettingsHelpers.migrate(legacySettings), true);
assert.equal(legacySettings.settingsSchemaVersion, 25);
assert.equal(Object.hasOwn(legacySettings.chats.legacy.characterBoost, "enabled"), false);
assert.equal(legacySettings.chats.legacy.plotSecretMode, false);
assert.equal(legacySettings.chats.legacy.characterBoost.baselineVersionId, "");
assert.deepEqual(legacySettings.characterBaselineVersions, {});

// Background operations own an immutable start-time snapshot so switching
// chats or editing live state cannot mutate an in-flight request payload.
assert.match(source, /function createOperationContextSnapshot\(/);
const operationContextStart = source.indexOf(
    "function createOperationContextSnapshot("
);
const operationContextEnd = source.indexOf(
    "function isOperationContextCurrentChat(",
    operationContextStart
);
assert.ok(operationContextStart >= 0 && operationContextEnd > operationContextStart);
const operationContextHelpers = {};
eval(`
    const getCurrentChatId = () => "unused";
    ${source.slice(operationContextStart, operationContextEnd)}
    operationContextHelpers.create = createOperationContextSnapshot;
`);
const sourceMessages = [{ is_user: false, mes: "original" }];
const operationContext = operationContextHelpers.create({
    chatId: 17,
    chatSnapshot: sourceMessages,
    characterKey: "char:test",
    profileId: "profile:test",
    outputLanguage: "invalid",
    responseLength: 4000,
    selectionSignature: "romance|crime",
    correctionRevision: 3,
});
sourceMessages[0].mes = "mutated";
assert.equal(operationContext.chatId, "17");
assert.equal(operationContext.chatSnapshot[0].mes, "original");
assert.equal(operationContext.outputLanguage, "ko");
assert.equal(operationContext.responseLength, 4000);
assert.equal(operationContext.correctionRevision, 3);
assert.equal(Object.isFrozen(operationContext), true);
assert.equal(Object.isFrozen(operationContext.chatSnapshot), true);
assert.equal(Object.isFrozen(operationContext.chatSnapshot[0]), true);

// Each newly opened popup is wired through its own instance marker instead of
// accidentally binding to an older hidden popup left in the DOM.
assert.match(source, /data-storybooster-popup-instance/);
assert.match(source, /activeBoosterPopupRoot = popupRoot/);
assert.doesNotMatch(source, /document\.getElementById\("rp-event-result"\)/);

// Background requests cannot leave the popup controls locked forever. Profile
// requests are also aborted once the timeout is reached.
assert.match(source, /const BACKGROUND_REQUEST_TIMEOUT_MS = 180000/);
assert.match(source, /STORYBOOSTER_REQUEST_TIMEOUT/);
assert.match(source, /const controller = new AbortController\(\)/);
assert.match(source, /signal: requestSignal/);
assert.match(source, /controller\.abort\(\)/);
assert.ok(
    (source.match(/signal: requestSignal/g) || []).length >= 4,
    "profile and all current-connection background paths should receive abort signals"
);
assert.match(source, /function requestCurrentRoleplayGenerationStop\(\)/);
assert.match(source, /context\?\.stopGeneration/);
assert.match(source, /document\.getElementById\("mes_stop"\)/);
assert.match(
    source,
    /roleplayStopRequested = requestCurrentRoleplayGenerationStop\(\)/
);

// Connection-profile diagnostics pass the native JSON schema through
// SillyTavern's override payload. Structured genre and character tasks share
// the same schema-free JSON fallback and final repair flow.
assert.match(source, /apiType: String\(profile\.apiType \|\| ""\)/);
assert.match(source, /\{ json_schema: compatibleJsonSchema \}/);
assert.match(source, /jsonSchema: compatibleJsonSchema/);
assert.match(source, /STORYBOOSTER_INCOMPLETE_RATINGS/);
assert.match(source, /function requestStructuredJsonWithCompatibility\(/);
assert.match(source, /COMPATIBILITY FALLBACK: The provider did not return a usable structured result/);
assert.match(source, /FINAL REPAIR: The previous schema-free JSON response was empty/);
assert.match(source, /Math\.max\(4800, Number\(responseLength \|\| 0\) \* 2\)/);
assert.match(source, /retryOnLength: false/);
assert.ok(
    (source.match(/requestStructuredJsonWithCompatibility\(/g) || []).length >= 6,
    "genre and character structured tasks should share the compatibility helper"
);
assert.match(readme, /형식·언어 보정을 \*\*모두 합쳐 최대 3회\*\*/);
assert.match(
    source,
    /const AUDIT_RESPONSE_LENGTHS = Object\.freeze\(\{\s*genre: AUDIT_WRITING_OUTPUT_TOKENS,\s*character: AUDIT_WRITING_OUTPUT_TOKENS,\s*combined: AUDIT_WRITING_OUTPUT_TOKENS,/s
);
assert.match(
    source,
    /AUDIT_RESPONSE_LENGTHS\[scope\] \|\| AUDIT_RESPONSE_LENGTHS\.combined/
);
const normalizeTextStart = source.indexOf("function normalizeGeneratedText(");
const normalizeTextEnd = source.indexOf(
    "function extractTextFromGenerationData(",
    normalizeTextStart
);
const normalizeTextHelpers = {};
eval(`
    ${source.slice(normalizeTextStart, normalizeTextEnd)}
    normalizeTextHelpers.normalizeGeneratedText = normalizeGeneratedText;
`);
assert.deepEqual(
    JSON.parse(normalizeTextHelpers.normalizeGeneratedText({ stable: true })),
    { stable: true }
);
const generationTextEnd = source.indexOf(
    "function isLengthLimitedGeneration(",
    normalizeTextStart
);
const generationTextHelpers = {};
eval(`
    const THINKING_OUTPUT_ERROR = "thinking output";
    const EMPTY_STRUCTURED_OUTPUT_ERROR = "empty structured output";
    ${source.slice(normalizeTextStart, generationTextEnd)}
    generationTextHelpers.extract = extractTextFromGenerationData;
    generationTextHelpers.assertPresent = assertStructuredOutputPresent;
`);
assert.equal(generationTextHelpers.extract({}), "{}");
assert.throws(
    () => generationTextHelpers.assertPresent({}, "{}"),
    (error) => error.code === "STORYBOOSTER_EMPTY_STRUCTURED_OUTPUT"
);
const reasoningOnlyResult = {
    choices: [{ message: { content: "", reasoning: "hidden reasoning only" } }],
};
assert.equal(
    generationTextHelpers.extract(reasoningOnlyResult),
    ""
);
assert.throws(
    () =>
        generationTextHelpers.assertPresent(
            reasoningOnlyResult,
            "hidden reasoning only"
        ),
    (error) => error.code === "STORYBOOSTER_REASONING_ONLY_OUTPUT"
);
assert.doesNotThrow(() =>
    generationTextHelpers.assertPresent(
        { choices: [{ message: { content: '{"ok":true}' } }] },
        '{"ok":true}'
    )
);
const schemaNormalizerStart = source.indexOf(
    "function normalizeSillyTavernJsonSchema("
);
const schemaNormalizerEnd = source.indexOf(
    "function getConnectionProfileService(",
    schemaNormalizerStart
);
assert.ok(
    schemaNormalizerStart >= 0 && schemaNormalizerEnd > schemaNormalizerStart
);
const schemaHelpers = {};
eval(`
    ${source.slice(schemaNormalizerStart, schemaNormalizerEnd)}
    schemaHelpers.normalize = normalizeSillyTavernJsonSchema;
`);
const compatibleSchema = schemaHelpers.normalize({
    name: "test",
    strict: true,
    schema: { type: "object" },
});
assert.deepEqual(compatibleSchema, {
    name: "test",
    strict: true,
    value: { type: "object" },
});
assert.equal(Object.hasOwn(compatibleSchema, "schema"), false);

// Character data is persisted independently from optional prompt/panel refresh.
assert.match(source, /function safelyUpdateGenrePrompt/);
assert.match(source, /function toggleCharacterFieldEditing\(fieldId, sourceButton = null\)/);
assert.match(source, /finally \{[\s\S]{0,700}textarea\.readOnly = true/);
assert.match(source, /includeBoostAnchor = true/);
assert.match(source, /required: requestedField[\s\S]{0,120}\? \["fields"\]/);
assert.match(source, /nextBaseline\.boostAnchorNeedsRefresh = Boolean\(nextBaseline\.boostAnchor\)/);
assert.match(source, /캐릭터 기준이 변경됐어요\. 앵커를 갱신해 주세요/);
assert.match(source, /anchorRegenerate\.textContent =/);
assert.match(css, /#rp-character-boost-anchor-status\.is-warning/);
assert.match(css, /#rp-character-boost-anchor-regenerate\.is-attention/);
assert.match(
    css,
    /\.rp-character-tool-button\s*\{[\s\S]{0,180}width:\s*27px\s*!important[\s\S]{0,160}height:\s*27px\s*!important/
);

// Injection waits for the exact active popup to finish closing before starting
// the normal SillyTavern reply generation.
assert.match(source, /async function waitForBoosterPopupToClose/);
assert.match(source, /await waitForBoosterPopupToClose\(popupRoot\)/);
assert.match(source, /context\.generate\("normal"\)/);

// Automatic audits select only the enabled scope, and one-response
// corrections are consumed only when they were armed before generation.
const automaticScopeStart = source.indexOf("function getAutomaticAuditScope(");
const automaticScopeEnd = source.indexOf(
    "function getScopedAuditSelection(",
    automaticScopeStart
);
const automaticScopeHelpers = {};
eval(`
    ${source.slice(automaticScopeStart, automaticScopeEnd)}
    automaticScopeHelpers.get = getAutomaticAuditScope;
`);
assert.equal(automaticScopeHelpers.get(null), null);
assert.equal(
    automaticScopeHelpers.get({ primaryGenre: {}, characterEnabled: false }),
    "genre"
);
assert.equal(
    automaticScopeHelpers.get({ primaryGenre: null, characterEnabled: true }),
    "character"
);
assert.equal(
    automaticScopeHelpers.get({ primaryGenre: {}, characterEnabled: true }),
    "combined"
);

const correctionTimingStart = source.indexOf(
    "function isPendingGenreCorrectionArmed("
);
const correctionTimingEnd = source.indexOf(
    "function handleGenreResponseReceived(",
    correctionTimingStart
);
assert.ok(
    correctionTimingStart >= 0 && correctionTimingEnd > correctionTimingStart
);
const correctionTimingHelpers = {};
let correctionSaveCount = 0;
const correctionStatusUpdates = [];
eval(`
    const saveSettingsDebounced = () => { correctionSaveCount += 1; };
    const ensureChatState = () => ({ genreAnchor: null });
    const ensureGenreAnchorState = (state) => state.genreAnchor;
    const bumpCorrectionRevision = (anchor) => ++anchor.correctionRevision;
    const updateStoredAuditStatus = (anchor, status, messageId) => {
        correctionStatusUpdates.push({ status, messageId });
    };
    ${source.slice(correctionTimingStart, correctionTimingEnd)}
    correctionTimingHelpers.arm = armPendingGenreCorrectionForNextResponse;
    correctionTimingHelpers.mark = markArmedGenreCorrectionApplied;
`);
const pendingCorrection = {
    correctionRemaining: 1,
    correctionAppliedMessageId: null,
    correctionArmedRevision: 0,
    correctionRevision: 7,
    correctionCodes: ["primary_genre"],
};
assert.equal(correctionTimingHelpers.mark(pendingCorrection, 41), false);
assert.equal(
    correctionTimingHelpers.arm({ genreAnchor: pendingCorrection }),
    true
);
assert.equal(pendingCorrection.correctionArmedRevision, 7);
assert.equal(correctionTimingHelpers.mark(pendingCorrection, 42), true);
assert.equal(pendingCorrection.correctionAppliedMessageId, 42);
assert.equal(pendingCorrection.correctionArmedRevision, 0);
assert.equal(pendingCorrection.correctionRevision, 8);
assert.deepEqual(correctionStatusUpdates, [
    { status: "applied", messageId: 42 },
]);
assert.equal(correctionSaveCount, 1);
assert.match(source, /const correctionPendingForNextResponse = Boolean/);
assert.match(
    source,
    /correctionAppliedMessageId === null[\s\S]{0,220}\? \(state\.genreAnchor\.correctionCodes/
);
assert.match(source, /if \(correctionApplied\) updateGenrePrompt\(\)/);
assert.match(
    source,
    /event_types\.MESSAGE_SENT[\s\S]{0,180}handleGenreUserMessageSent/
);

// Always-on booster state is explicit: blue means the prompt is active. A
// stored baseline enables diagnosis, but only a current compact anchor enables
// persistent character boosting.
assert.match(source, /id="rp-genre-live-status"/);
assert.match(source, /id="rp-character-live-status"/);
assert.match(source, /부스팅 중/);
assert.doesNotMatch(source, /상시 부스팅 중/);
const storyAnchorStart = source.indexOf("function buildGenrePromptText(");
const storyAnchorEnd = source.indexOf(
    "function getScopedAuditSelection(",
    storyAnchorStart
);
const storyAnchorSource = source.slice(storyAnchorStart, storyAnchorEnd);
assert.match(storyAnchorSource, /PRIMARY DIRECTION:/);
assert.match(storyAnchorSource, /PRIMARY EXPRESSION:/);
assert.match(storyAnchorSource, /PRIMARY CONSEQUENCE:/);
assert.match(storyAnchorSource, /PRIMARY BOUNDARY:/);
assert.match(storyAnchorSource, /SUPPORTING LENS:/);
assert.match(storyAnchorSource, /SUPPORTING TEXTURE:/);
assert.match(storyAnchorSource, /SUPPORTING BOUNDARY:/);
assert.match(storyAnchorSource, /GENRE ROLES:/);
assert.match(storyAnchorSource, /GENRE PRINCIPLE:/);
assert.match(storyAnchorSource, /CHARACTER — \{\{char\}\}:/);
assert.match(storyAnchorSource, /ANCHOR ROLE:/);
assert.match(storyAnchorSource, /CHARACTER PRINCIPLES:/);
assert.match(storyAnchorSource, /- IDENTITY:/);
assert.match(storyAnchorSource, /- AGENCY:/);
assert.match(storyAnchorSource, /- RELATIONSHIP:/);
assert.match(storyAnchorSource, /- CONTINUITY & VARIETY:/);
assert.match(storyAnchorSource, /do not defer \{\{char\}\}'s own decisions back to \{\{user\}\}/);
assert.doesNotMatch(storyAnchorSource, /PRIMARY CORE:/);
assert.doesNotMatch(storyAnchorSource, /GENRE GUIDANCE:/);
assert.doesNotMatch(storyAnchorSource, /GENRE EVENT PRINCIPLE:/);
assert.doesNotMatch(storyAnchorSource, /SCENE DENSITY:/);

// Every built-in genre exposes the same five positive/boundary dimensions.
// Large genre profiles are kept compact enough for an always-on anchor.
const genreProfilesStart = source.indexOf("const GENRE_PROFILES = Object.freeze({");
const genreProfilesEnd = source.indexOf(
    "const EVENT_CATEGORIES = [",
    genreProfilesStart
);
assert.ok(genreProfilesStart >= 0 && genreProfilesEnd > genreProfilesStart);
const genreProfileHelpers = {};
eval(`
    ${source.slice(genreProfilesStart, genreProfilesEnd)}
    genreProfileHelpers.profiles = GENRE_PROFILES;
`);
const builtInGenreProfiles = Object.values(genreProfileHelpers.profiles);
assert.equal(builtInGenreProfiles.length, 36);
for (const profile of builtInGenreProfiles) {
    for (const field of ["identity", "ui", "signals", "effects", "texture", "guard"]) {
        assert.equal(typeof profile[field], "string");
        assert.ok(profile[field].trim().length > 0);
    }
    const injectedGenreChars = [
        profile.identity,
        profile.signals,
        profile.effects,
        profile.texture,
        profile.guard,
    ].join(" ").length;
    assert.ok(injectedGenreChars <= 760);
}
assert.match(source, /False-positive boundary:/);
assert.match(source, /if the same responses could still be described accurately without the selected genre/);
assert.match(source, /matches the supporting genre's false-positive boundary/);
assert.match(source, /function getCharacterBoosterReadiness/);
assert.match(source, /characterBoostActive: characterReadiness\.boostActive/);
assert.match(source, /if \(!primaryGenre && !characterBoostActive && !correctionCodes\.length\)/);
const storyPromptStart = source.indexOf("function buildGenrePromptText(");
const storyPromptEnd = source.indexOf("function updateGenrePrompt(", storyPromptStart);
assert.ok(storyPromptStart >= 0 && storyPromptEnd > storyPromptStart);
const storyPromptHelpers = {};
eval(`
    const CHARACTER_BOOST_CORRECTION_CODES = new Set([
        "character_consistency", "character_interpretation", "char_agency",
        "relationship", "continuity", "repetition"
    ]);
    const GENRE_CORRECTION_MODULES = { char_agency: "GENERIC AGENCY FALLBACK" };
    const getGenreProfile = () => ({ identity: "", signals: "", effects: "", texture: "", guard: "" });
    const getGenrePromptLabel = () => "";
    ${source.slice(storyPromptStart, storyPromptEnd)}
    storyPromptHelpers.build = buildGenrePromptText;
`);
const targetedPrompt = storyPromptHelpers.build({
    primaryGenre: null,
    supportGenre: null,
    characterBoostActive: true,
    characterBoostAnchor: "Compact English anchor.",
    correctionCodes: ["char_agency"],
    correctionText: "AGENCY: Make a concrete character-specific decision in the current scene.",
    correctionCharacterBaseline: "[성격·특성] 한국어 기준",
});
assert.match(targetedPrompt, /TARGETED CHARACTER CORRECTION FOR THIS RESPONSE/);
assert.match(targetedPrompt, /AGENCY: Make a concrete/);
assert.doesNotMatch(targetedPrompt, /GENERIC AGENCY FALLBACK/);
assert.doesNotMatch(targetedPrompt, /character_baseline_reference/);
const fallbackPrompt = storyPromptHelpers.build({
    primaryGenre: null,
    supportGenre: null,
    characterBoostActive: true,
    characterBoostAnchor: "Compact English anchor.",
    correctionCodes: ["char_agency"],
    correctionText: "",
    correctionCharacterBaseline: "[성격·특성] 한국어 기준",
});
assert.match(fallbackPrompt, /GENERIC AGENCY FALLBACK/);
assert.match(fallbackPrompt, /character_baseline_reference/);
const characterSourceStart = source.indexOf("function buildCharacterCardSource(");
const characterSourceEnd = source.indexOf(
    "function hashStableText(",
    characterSourceStart
);
const characterSourceBuilder = source.slice(characterSourceStart, characterSourceEnd);
assert.match(characterSourceBuilder, /\["Description", getCharacterField\(character, "description"\)\]/);
assert.match(characterSourceBuilder, /\["Personality", getCharacterField\(character, "personality"\)\]/);
assert.match(characterSourceBuilder, /\["Example dialogue", getCharacterField\(character, "mes_example"\)\]/);
assert.doesNotMatch(characterSourceBuilder, /"name"/);
assert.doesNotMatch(characterSourceBuilder, /"scenario"/);
assert.doesNotMatch(characterSourceBuilder, /"first_mes"/);
const characterPromptStart = source.indexOf("function buildCharacterBaselinePrompt(");
const characterPromptEnd = source.indexOf(
    "async function generateCharacterBaseline",
    characterPromptStart
);
const characterPromptBuilder = source.slice(characterPromptStart, characterPromptEnd);
assert.doesNotMatch(characterPromptBuilder, /characterName/);
assert.match(characterPromptBuilder, /for the supplied character/);
assert.match(characterPromptBuilder, /evidence-bound roleplay baseline/);
assert.match(characterPromptBuilder, /distinguish stable character logic from a one-scene mood or circumstance/);
assert.match(characterPromptBuilder, /getCharacterBoostAnchorRequirements\(outputLanguage\)/);
const anchorRequirementsStart = source.indexOf(
    "function getCharacterBoostAnchorRequirements("
);
const anchorRequirementsEnd = source.indexOf(
    "function buildCharacterBaselinePrompt(",
    anchorRequirementsStart
);
assert.ok(
    anchorRequirementsStart >= 0 &&
        anchorRequirementsEnd > anchorRequirementsStart
);
const anchorRequirementHelpers = {};
eval(`
    const CHARACTER_BOOST_ANCHOR_MAX_CHARS = 700;
    const ensureModuleSettings = () => ({ outputLanguage: "ko" });
    ${source.slice(anchorRequirementsStart, anchorRequirementsEnd)}
    anchorRequirementHelpers.build = getCharacterBoostAnchorRequirements;
`);
const koreanAnchorRequirements = anchorRequirementHelpers.build("ko");
assert.match(koreanAnchorRequirements, /70 to 110 words/);
assert.match(koreanAnchorRequirements, /never more than 700 characters/);
assert.match(koreanAnchorRequirements, /decision logic and action triggers/);
assert.match(koreanAnchorRequirements, /Do not list the baseline fields/);
assert.match(koreanAnchorRequirements, /faithful natural Korean display version/);
assert.ok(
    (source.match(/getCharacterBoostAnchorRequirements\(outputLanguage\)/g) || [])
        .length >= 2
);
assert.match(
    source,
    /Keep the six dimensions independent: character_consistency detects contradiction/
);
assert.match(source, /character_interpretation detects repeated flattening/);
assert.match(source, /Do not let strength or weakness in one dimension determine another/);
assert.match(source, /Correct the diagnosed contradiction through one plausible choice/);
assert.match(source, /Restore only the context-relevant established facets/);
assert.match(source, /do not defer \{\{char\}\}'s own decisions back to \{\{user\}\}/);
assert.match(source, /Preserve genuine signature voice and behavior/);
assert.match(source, /status: baseline \? "current" : "missing"/);
assert.doesNotMatch(source, /\bbaselineStale\b/);
assert.doesNotMatch(source, /baselineState\.status === "stale"/);
assert.match(source, /캐릭터 기준은 진단에 사용됩니다\. 최신 캐릭터 전용 앵커가 준비되면 캐릭터 부스팅을 시작해요/);
assert.match(source, /앵커 갱신 후 부스팅/);
assert.match(source, /characterCardChangeDetection: true/);
assert.match(source, /function getCharacterCardChangeStatus/);
assert.match(source, /function acknowledgeCharacterCardChange/);
assert.match(source, /event_types\.CHARACTER_EDITED/);
assert.match(source, /캐릭터 카드 저장/);
assert.match(
    source,
    /character\?\.data\?\.\[field\] \?\? character\?\.\[field\]/
);
assert.match(source, /기존 기준과 앵커로 계속 부스팅하고 있어요/);
assert.match(source, /id="rp-character-card-reanalyze"/);
assert.match(source, /id="rp-character-card-keep"/);
assert.match(source, /설명·성격·대화 예시가 변경되면 기준 재확인을 안내합니다/);
assert.match(source, /boostAnchorDisplayLanguage/);
assert.match(source, /boostAnchorUpdatedAt/);
assert.match(source, /function convertCharacterAnchorDisplayToEnglish/);
assert.match(source, /id="rp-character-boost-anchor-save"/);
assert.match(source, /id="rp-character-boost-anchor-cancel"/);
assert.match(source, /마지막 저장:/);
assert.match(source, /실제 부스팅에는 영문 앵커를 사용합니다/);
assert.match(css, /\.rp-character-card-change-notice/);
assert.match(css, /\.rp-character-anchor-saved-at/);

// A Korean anchor save may await a translation request. Its character target
// must be captured before that await so changing chats cannot redirect the
// result into another character's baseline.
const anchorSaveStart = source.indexOf(
    "async function saveEditedCharacterBoostAnchor()"
);
const anchorSaveEnd = source.indexOf(
    "function closeCharacterEditorsForChatChange()",
    anchorSaveStart
);
const anchorSaveSource = source.slice(anchorSaveStart, anchorSaveEnd);
assert.ok(anchorSaveStart >= 0 && anchorSaveEnd > anchorSaveStart);
assert.ok(
    anchorSaveSource.indexOf("const target = getCharacterEditTarget(textarea)") <
        anchorSaveSource.indexOf("await convertCharacterAnchorDisplayToEnglish")
);
assert.match(anchorSaveSource, /saveCharacterBoostAnchor\([\s\S]*?target\s*\)/);

// Chat changes reset anchor editing separately from autosaved baseline fields.
// The generic field selector must not swallow the anchor and leave its save /
// cancel controls visible in a read-only state.
const closeEditorsStart = source.indexOf(
    "function closeCharacterEditorsForChatChange()"
);
const closeEditorsEnd = source.indexOf(
    "async function regenerateCharacterBoostAnchor()",
    closeEditorsStart
);
const closeEditorsSource = source.slice(closeEditorsStart, closeEditorsEnd);
assert.match(
    closeEditorsSource,
    /\.rp-character-field-text\[data-field-id\]:not\(\[readonly\]\)/
);

const cardChangeStart = source.indexOf("function getCharacterCardChangeStatus(");
const cardChangeEnd = source.indexOf(
    "function getCharacterBoosterReadiness(",
    cardChangeStart
);
assert.ok(cardChangeStart >= 0 && cardChangeEnd > cardChangeStart);
const characterUiHelpers = {};
const helperSettings = {
    characterCardChangeDetection: true,
    outputLanguage: "ko",
    characterBaselines: {},
};
const ensureModuleSettings = () => helperSettings;
const getCurrentCharacterBaseline = () => ({
    identity: { key: "character:test", sourceHash: "new" },
    baseline: {
        sourceHash: "old",
        notifiedSourceHash: "",
        boostAnchor: "English canonical anchor",
        boostAnchorDisplay: "한국어 표시 앵커",
        boostAnchorDisplayLanguage: "ko",
        fields: {},
    },
});
const CHARACTER_BASELINE_FIELDS = [];
const saveSettingsDebounced = () => {};
const safelyUpdateCharacterBoosterPanel = () => {};
const toastr = {};
const resolveRoleMacrosForDisplay = (value) => String(value || "")
    .replace(/\{\{char\}\}/gi, "테스트 캐릭터")
    .replace(/\{\{user\}\}/gi, "테스트 유저");
eval(`
    ${source.slice(cardChangeStart, cardChangeEnd)}
    characterUiHelpers.getCharacterCardChangeStatus = getCharacterCardChangeStatus;
    characterUiHelpers.getCharacterAnchorDisplayValue = getCharacterAnchorDisplayValue;
`);
assert.equal(characterUiHelpers.getCharacterCardChangeStatus().changed, true);
assert.equal(
    characterUiHelpers.getCharacterAnchorDisplayValue(
        getCurrentCharacterBaseline().baseline
    ),
    "한국어 표시 앵커"
);
assert.equal(
    characterUiHelpers.getCharacterAnchorDisplayValue(
        {
            boostAnchor: "",
            boostAnchorDisplay:
                "{{user}}와 {{char}}의 관계를 현재 이름으로 표시합니다.",
            boostAnchorDisplayLanguage: "ko",
        }
    ),
    "테스트 유저와 테스트 캐릭터의 관계를 현재 이름으로 표시합니다."
);
helperSettings.characterCardChangeDetection = false;
assert.equal(characterUiHelpers.getCharacterCardChangeStatus().changed, false);
assert.match(readme, /짧은 캐릭터 전용 앵커와 공통 보강 규칙만 사용/);
assert.match(readme, /기존 기준과 앵커의 부스팅은 중단하지 않습니다/);
assert.doesNotMatch(readme, /초록색 `부스팅 중`/);
assert.match(css, /\.rp-booster-live-status\.is-active/);
assert.match(
    css,
    /\.rp-booster-live-status\.is-active\s*\{[\s\S]{0,220}background:\s*var\(--sb-blue-selected\)/
);

// Plot generation is scoped per chat and remains visible after reopening the
// popup instead of silently returning behind one global pending flag.
assert.match(source, /const eventGenerationPendingTasks = new Map\(\)/);
assert.match(source, /이 채팅의 플롯을 이미 생성하고 있어요/);
assert.doesNotMatch(source, /id="rp-plot-generation-notice"/);
assert.match(source, /플롯 생성을 시작했어요/);
assert.match(source, /플롯 생성이 완료됐어요/);
assert.match(source, /플롯 생성 시간 초과: 3분 안에 완료되지 않았어요/);
assert.doesNotMatch(source, /let eventGenerationPending = false/);
assert.match(source, /button\.textContent = pending \? "⏳ 분석 중…" : "현재 롤플 분석"/);
assert.match(source, /button\.setAttribute\("aria-busy", pending \? "true" : "false"\)/);

// The no-selection branch must obtain its feature state locally, and public
// installation instructions must point at the current repository.
assert.match(
    source,
    /function updateGenreAnchorPanel\(\)[\s\S]{0,1200}const genreFeatureEnabled = isBoosterFeatureEnabled\("genre"\)/
);
assert.match(readme, /https:\/\/github\.com\/ze-ro-soda\/storybooster/);
assert.equal(manifest.homePage, "https://github.com/ze-ro-soda/storybooster");

// Plot brainstorming is intentionally independent from the genre booster.
// The chosen category and transcript control the candidate; genre returns only
// when SillyTavern generates the actual roleplay response.
const plotPromptStart = source.indexOf("function buildEventGenerationPrompt(");
const plotPromptEnd = source.indexOf(
    "async function generateEventCandidate",
    plotPromptStart
);
const plotPromptSource = source.slice(plotPromptStart, plotPromptEnd);
assert.ok(plotPromptStart >= 0 && plotPromptEnd > plotPromptStart);
assert.doesNotMatch(plotPromptSource, /getGenreAnchorSelection/);
assert.doesNotMatch(plotPromptSource, /Active genre direction/);
assert.match(plotPromptSource, /Do not consult or infer StoryBooster genre selections/);
assert.match(plotPromptSource, /CHARACTER CONTINUITY FOR PLOT PLANNING/);
assert.match(plotPromptSource, /character_boost_anchor/);
assert.match(plotPromptSource, /stock trope or contradict established characterization/);
assert.match(source, /EVERYDAY DIRECTION/);
assert.match(source, /CHARACTER-GROUNDED EMOTION/);
assert.match(plotPromptSource, /const categoryGuidance = !isCrazyRandom && category\?\.id/);
assert.match(plotPromptSource, /belongs more clearly to the selected category than to any other built-in category/);
assert.match(plotPromptSource, /never as an OOC request/);
assert.doesNotMatch(plotPromptSource, /categoryDevelopmentRequirement/);
assert.doesNotMatch(plotPromptSource, /briefDevelopmentRequirement/);
assert.match(plotPromptSource, /Create one direct plot development/);
assert.match(plotPromptSource, /Write the plot itself/);
assert.match(plotPromptSource, /DECISION PRIORITY — APPLY IN THIS ORDER/);
assert.match(plotPromptSource, /Preserve established transcript facts, world rules/);
assert.match(plotPromptSource, /Make the selected category contract the unmistakable central narrative function/);
assert.match(plotPromptSource, /Seek novelty only inside the first three constraints/);
assert.match(plotPromptSource, /PLOT CONTRACT/);
assert.match(plotPromptSource, /planning text, not a performed roleplay response/);
assert.match(plotPromptSource, /Leave \{\{user\}\}'s response open/);
assert.match(plotPromptSource, /A new element is valid only when the selected category calls for it/);
assert.match(plotPromptSource, /CUSTOM CATEGORY: Treat the category name and supplied direction as a hard semantic contract/);
assert.match(plotPromptSource, /USER-IDEA CONTRACT/);
assert.match(plotPromptSource, /Use decisive prospective or planning language/);
assert.match(plotPromptSource, /overprotectiveness/);
assert.match(plotPromptSource, /controlling behavior/);
assert.match(plotPromptSource, /immediate situation specifically activates it/);
assert.doesNotMatch(plotPromptSource, /editorial plot brief/);
assert.match(source, /meta_framing/);
assert.match(source, /이 에피소드는/);

// Execute the prompt builder with small fixtures so mode-specific contracts
// cannot silently leak into one another during later refactors.
const buildPlotPromptForTest = new Function(
    "EVENT_CATEGORY_GUIDANCE",
    "CHARACTER_BOOST_ANCHOR_MAX_CHARS",
    "ensureModuleSettings",
    "getPlotOutputInstruction",
    `${plotPromptSource}\nreturn buildEventGenerationPrompt;`
)(
    {
        everyday: {
            required: "TEST EVERYDAY REQUIRED",
            avoid: "TEST EVERYDAY AVOID",
            completion: "TEST EVERYDAY COMPLETION",
            novelty: "activity, need, setting",
        },
    },
    1200,
    () => ({ outputLanguage: "ko" }),
    (language) => `TEST OUTPUT LANGUAGE: ${language}`
);
const normalPlotPrompt = buildPlotPromptForTest(
    {
        id: "everyday",
        label: "일상·계기",
        promptLabel: "Everyday Occasion",
        direction: "Use an ordinary occasion.",
    },
    {
        outputLanguage: "ko",
        characterBoostAnchor: "Distinctive character anchor",
    }
);
assert.match(normalPlotPrompt, /PLOT CONTRACT/);
assert.match(normalPlotPrompt, /TEST EVERYDAY REQUIRED/);
assert.match(normalPlotPrompt, /Distinctive character anchor/);
assert.match(normalPlotPrompt, /Do not consult or infer StoryBooster genre selections/);
assert.doesNotMatch(normalPlotPrompt, /CHAOS MODE/);

const crazyPlotPrompt = buildPlotPromptForTest(null, {
    outputLanguage: "ko",
    surpriseType: "crazy",
    characterBoostAnchor: "MUST NOT LEAK",
});
assert.match(crazyPlotPrompt, /CHAOS GENERATION TASK/);
assert.match(crazyPlotPrompt, /Nothing else constrains the creative choice/);
assert.doesNotMatch(crazyPlotPrompt, /PLOT CONTRACT/);
assert.doesNotMatch(crazyPlotPrompt, /MUST NOT LEAK/);
assert.doesNotMatch(crazyPlotPrompt, /generic relationship tension/);
assert.doesNotMatch(crazyPlotPrompt, /current roleplay context/);

const guidedPlotPrompt = buildPlotPromptForTest(null, {
    outputLanguage: "en",
    userIdea: "Keep this exact small premise.",
});
assert.match(guidedPlotPrompt, /USER-IDEA CONTRACT/);
assert.match(guidedPlotPrompt, /Keep this exact small premise/);
assert.match(guidedPlotPrompt, /NO CATEGORY CONTRACT/);
assert.doesNotMatch(guidedPlotPrompt, /SELECTED CATEGORY CONTRACT/);

// v1.2 secret play is opt-in per chat. Normal mode remains the default, while
// secret/random/crazy plots are validated, recorded, then handed to the normal
// chat connection. The character question skips the background plot call.
assert.match(source, /plotSecretMode:\s*false/);
assert.match(source, /previousSchemaVersion < 19/);
assert.match(source, /state\.plotSecretMode = false/);
assert.match(source, /function setPlotSecretMode\(enabled\)/);
assert.match(source, /id="rp-plot-secret-toggle"/);
assert.match(source, /selectSecretPlotAction\("random"\)/);
assert.match(source, /selectSecretPlotAction\("crazy"\)/);
assert.match(source, /selectSecretPlotAction\("character_question"\)/);
assert.match(source, /function runSelectedPlotGenerationAction\(\)/);
assert.match(source, /addEventListener\("click", runSelectedPlotGenerationAction\)/);
assert.match(source, /return "🎲 사건 생성"/);
assert.doesNotMatch(source, /자유 사건 생성/);
assert.doesNotMatch(source, /선택한 카테고리로 비밀 생성/);
assert.match(source, /선택한 카테고리에 맞는 사건을 플롯 공개 없이 바로 전개합니다/);
assert.match(source, /카테고리와 결과를 숨긴 채 무작위 사건을 전개합니다/);
assert.match(source, /현재 흐름과 개연성을 벗어난 예상 밖의 전개까지 허용합니다/);
assert.match(source, /에게 무작위 질문을 던집니다/);
assert.match(source, /function getRandomPlotCategory\(\)/);
assert.match(source, /surpriseType === "crazy"/);
assert.match(plotPromptSource, /CHAOS MODE: Ignore the current roleplay/);
assert.match(plotPromptSource, /CHAOS GENERATION TASK: Invent one independent, concrete, in-world occurrence/);
assert.match(plotPromptSource, /Create one direct, unexplained in-world occurrence/);
assert.match(plotPromptSource, /Generate three maximally different possibilities silently/);
assert.match(plotPromptSource, /Do not optimize it for coherence, plausibility, genre fit/);
assert.match(plotPromptSource, /Reject safe default twists/);
assert.match(plotPromptSource, /No roleplay transcript or character anchor governs the creative choice/);
assert.match(plotPromptSource, /Nothing else constrains the creative choice/);
assert.match(plotPromptSource, /whether it feels coherent, useful, tasteful, foreshadowed/);
assert.match(plotPromptSource, /const characterContinuityLines = isCrazyRandom\s*\? \[\]/);
assert.match(plotPromptSource, /isCrazyRandom\s*\? ""\s*:\s*"Do not create jealousy/);
assert.match(source, /CHAOS MODE INPUT: No roleplay transcript is supplied/);
assert.match(source, /surpriseType === "crazy"\s*\? ""\s*:\s*getRoleplayTranscript/);
assert.match(source, /One concrete, maximally unpredictable in-world occurrence/);
assert.match(source, /requested-direction-appropriate behavior/);
assert.match(source, /요청한 방향에 맞는 행동·조건·정보·상호작용·변화/);
assert.match(source, /Do not make it more coherent, plausible, useful, contextual, or character-driven/);
assert.match(source, /await injectEventAndGenerateReply\(eventText/);
assert.match(source, /function buildCharacterQuestionInstruction\(\)/);
assert.match(source, /Do not repeat, paraphrase, or slightly vary a question/);
assert.match(source, /This list is illustrative, not restrictive/);
assert.match(source, /The subject has no topical boundary/);
assert.match(source, /No topic domain is preferred or forbidden/);
assert.match(source, /shape only how the question is asked/);
assert.match(source, /may freely ask about something they do not know/);
assert.match(source, /Keep the current time, location, physical positions/);
assert.match(source, /Do not metagame/);
assert.match(source, /one to two sentences as a lead-in/);
assert.match(source, /final spoken line and the response's final meaningful beat/);
assert.match(source, /End immediately after the question/);
assert.match(source, /Never write, infer, or decide \{\{user\}\}'s answer/);
assert.match(source, /NEXT-RESPONSE MANDATE: Make the following central plot development visibly begin/);
assert.match(source, /Leave \{\{user\}\}'s dialogue, thoughts, emotions, consent/);
assert.match(source, /keep its central change intact/);
assert.match(source, /SPECIAL-MODE PRIORITY: For this response only/);
assert.match(source, /overrides persistent StoryBooster genre directions/);
assert.match(source, /overrides persistent StoryBooster genre, plausibility, and continuity directions/);
assert.match(source, /triggerPlotEvent\(eventText, options\.source\)/);
assert.match(source, /instructionText: buildCharacterQuestionInstruction\(\)/);
assert.match(source, /context\.generate\("normal"\)/);
assert.match(source, /\$\{characterName\}의 새로운 질문을 준비해요\./);
assert.doesNotMatch(source, /대상: \$\{userName\}/);
assert.match(source, /const chatId = String\(getCurrentChatId\(\)\)/);
assert.match(source, /!isOperationContextCurrentMessages\(injectionContext\)/);
assert.match(source, /function resolveRoleMacrosForDisplay\(value\)/);
assert.match(source, /resolveRoleMacrosForDisplay\(snapshot\.storyPrompt\)/);
assert.match(source, /const resolvedNote = automatic \? "" : resolveRoleMacrosForDisplay\(note\)/);
assert.match(source, /userDirection: resolvedNote/);
assert.match(
    source,
    /placeholder="예: 여전히 무뚝뚝하지만 \$\{escapeHtml\(\s*userName\s*\)\}에게는/
);
assert.doesNotMatch(
    source,
    /id="rp-character-revision-note"[^>]*placeholder="[^"]*\{\{user\}\}/
);
assert.match(css, /\.rp-plot-secret-switch/);
assert.match(css, /\.rp-plot-secret-action-grid/);
assert.doesNotMatch(css, /\.rp-secret-action\.is-crazy/);
assert.doesNotMatch(source, /rp-secret-action is-crazy/);
assert.match(css, /\.rp-secret-action\.is-selected/);
assert.match(readme, /비밀모드/);
assert.match(readme, /미친 랜덤박스/);
assert.match(readme, /캐릭터의 질문박스/);
assert.match(source, /\$\{escapeHtml\(characterName\)\}의 질문박스/);

const oneShotInstructionStart = source.indexOf("function triggerPlotEvent(");
const oneShotInstructionEnd = source.indexOf(
    "function clearPlotPromptIfPending(",
    oneShotInstructionStart
);
assert.ok(
    oneShotInstructionStart >= 0 &&
        oneShotInstructionEnd > oneShotInstructionStart
);
const oneShotInstructionHelpers = {};
let capturedOneShotPrompt = "";
eval(`
    const PLOT_PROMPT_KEY = "test-plot";
    const extension_prompt_types = { IN_CHAT: "in-chat" };
    const extension_prompt_roles = { SYSTEM: "system" };
    const toastr = {};
    const isBoosterFeatureEnabled = () => true;
    const setExtensionPrompt = (_key, text) => {
        capturedOneShotPrompt = text;
    };
    let currentPlotInjectionText = "";
    let plotPending = false;
    ${source.slice(oneShotInstructionStart, oneShotInstructionEnd)}
    oneShotInstructionHelpers.trigger = triggerPlotEvent;
    oneShotInstructionHelpers.question = buildCharacterQuestionInstruction;
`);
oneShotInstructionHelpers.trigger("A normal event begins.", "random");
assert.doesNotMatch(capturedOneShotPrompt, /SPECIAL-MODE PRIORITY/);
oneShotInstructionHelpers.trigger("An impossible event begins.", "crazy");
assert.match(capturedOneShotPrompt, /chaos event below overrides/);
assert.match(capturedOneShotPrompt, /Keep \{\{char\}\}'s established identity and voice/);
const questionInstruction = oneShotInstructionHelpers.question();
assert.match(questionInstruction, /question instruction overrides persistent StoryBooster genre directions/);
assert.match(questionInstruction, /Keep \{\{char\}\}'s established identity and voice/);
assert.match(questionInstruction, /immediate physical continuity/);

const categoryGuidanceStart = source.indexOf("const EVENT_CATEGORY_GUIDANCE");
const categoryGuidanceEnd = source.indexOf(
    "// ----------------------------------------------------------------------\n// 2. STATE",
    categoryGuidanceStart
);
const categoryGuidanceSource = source.slice(
    categoryGuidanceStart,
    categoryGuidanceEnd
);
for (const categoryId of [
    "discovery",
    "clue",
    "npc",
    "opportunity",
    "obstacle",
    "relationship",
    "emotion",
    "environment",
    "consequence",
    "everyday",
    "world",
    "wildcard",
]) {
    assert.match(categoryGuidanceSource, new RegExp(`\\n    ${categoryId}: \\{`));
    assert.match(
        categoryGuidanceSource,
        new RegExp(
            `\\n    ${categoryId}: \\{[\\s\\S]*?required:[\\s\\S]*?avoid:[\\s\\S]*?completion:[\\s\\S]*?novelty:`
        )
    );
}
assert.match(categoryGuidanceSource, /Do not create a new accident, threat, secret, third party/);
assert.match(categoryGuidanceSource, /a small change in comfort, habit, understanding, cooperation, or relationship texture is sufficient/);
assert.match(categoryGuidanceSource, /Unlike Secrets and Clues/);
assert.match(categoryGuidanceSource, /Unlike Information and Discovery/);
assert.match(categoryGuidanceSource, /Unlike Emotion in Action/);
assert.match(categoryGuidanceSource, /Unlike Relationship Shift/);
assert.match(categoryGuidanceSource, /Unlike Unexpected Variable/);
assert.match(categoryGuidanceSource, /Unlike Situation Shift/);
assert.match(categoryGuidanceSource, /Unlike Third-Party Intervention/);

// Ten-turn audits require broad positive coverage and also reject repeated
// counter-evidence instead of trusting the model's status label by itself.
assert.match(source, /const CHARACTER_INTERPRETATION_POSITIVE_EVIDENCE_MINIMUM = 3/);
assert.match(source, /const CHARACTER_CONSISTENCY_POSITIVE_EVIDENCE_MINIMUM = 4/);
assert.match(source, /const GENRE_EXPRESSION_EVIDENCE_MINIMUM = 4/);
assert.match(source, /const SCENE_DENSITY_EVIDENCE_MINIMUM = 4/);
assert.match(source, /const CHARACTER_AGENCY_EVIDENCE_MINIMUM = 4/);
assert.match(source, /const CHARACTER_RELATIONSHIP_EVIDENCE_MINIMUM = 3/);
assert.match(source, /const CHARACTER_CONTINUITY_EVIDENCE_MINIMUM = 4/);
assert.match(source, /const CHARACTER_FAILURE_EVIDENCE_MINIMUM = 2/);
assert.match(source, /const REPETITION_GENERAL_EVIDENCE_MINIMUM = 3/);
assert.match(source, /const REPETITION_EXACT_EVIDENCE_MINIMUM = 2/);
for (const evidenceKey of [
    "scene_density_evidence",
    "scene_density_failure_evidence",
    "primary_genre_failure_evidence",
    "character_consistency_positive_evidence",
    "character_interpretation_positive_evidence",
    "char_agency_evidence",
    "char_agency_failure_evidence",
    "relationship_evidence",
    "relationship_failure_evidence",
    "continuity_evidence",
    "continuity_failure_evidence",
    "repetition_evidence",
]) {
    assert.match(source, new RegExp(`${evidenceKey}: \\{`));
}
for (const reasonKey of [
    "primary_genre_reason",
    "genre_expression_reason",
    "support_texture_reason",
    "scene_density_reason",
    "character_consistency_reason",
    "character_interpretation_reason",
    "char_agency_reason",
    "relationship_reason",
    "continuity_reason",
    "repetition_reason",
]) {
    assert.match(
        source,
        new RegExp(
            `${reasonKey}: \\{ type: "string", maxLength: reasonMaxChars \\}`
        )
    );
}
assert.match(source, /exactly one concise user-facing sentence/);
assert.match(source, /Do not mention or quote response numbers/);
assert.match(source, /FINAL OUTPUT CONTRACT: After completing any hidden reasoning/);
assert.match(source, /per-dimension corrections map below replaces combined character instructions/);

assert.match(source, /TARGETED CHARACTER CORRECTION FOR THIS RESPONSE/);
assert.match(source, /CHARACTER_CORRECTION_MAX_WORDS = 220/);
assert.doesNotMatch(source, /character_correction must be at most two short sentences/);
assert.match(source, /Use weak when at least three responses/);
assert.match(source, /Use weak when at least two responses/);
assert.match(source, /deferring a choice that belongs to \{\{char\}\} back to \{\{user\}\}/);
assert.match(source, /do not penalize leaving \{\{user\}\}'s own actions, consent, dialogue, or decisions open/i);
assert.match(source, /Use attention for one concrete missed relationship-specific reaction/);
assert.match(source, /Use attention for one clear minor lapse/);
assert.match(source, /structural placeholders, not suggested ratings/);
assert.match(
    source,
    /evidence\.characterAgency\.length >=[\s\S]{0,100}characterAgencyEvidenceMinimum/
);
assert.match(
    source,
    /evidence\.relationship\.length >=[\s\S]{0,100}characterRelationshipEvidenceMinimum/
);
assert.match(
    source,
    /evidence\.continuity\.length >=[\s\S]{0,100}characterContinuityEvidenceMinimum/
);
assert.match(
    source,
    /evidence\.repetition\.length >= repetitionEvidenceMinimum/
);
assert.match(readme, /현재 버전: \*\*1\.7\.1\*\*/);
assert.doesNotMatch(readme, /배포 파일에는 검토용 회귀 테스트가 포함/);

const auditParserStart = source.indexOf("function parseGenreAuditResult");
const auditParserEnd = source.indexOf(
    "function createGenreAuditRecord",
    auditParserStart
);
assert.ok(auditParserStart >= 0 && auditParserEnd > auditParserStart);
const auditHelpers = {};
const extractJsonObject = (raw) => JSON.parse(String(raw));
const reasonNormalizerStart = source.indexOf("function getAuditReasonMaxChars(");
const reasonNormalizerEnd = source.indexOf(
    "function getRoleplayTranscript(",
    reasonNormalizerStart
);
assert.ok(
    reasonNormalizerStart >= 0 && reasonNormalizerEnd > reasonNormalizerStart
);
eval(`
    const GENRE_AUDIT_RESPONSE_LIMIT = 10;
    const AUDIT_EVIDENCE_MAX_ITEMS = 4;
    const PRIMARY_GENRE_EVIDENCE_RATIO = 0.375;
    const GENRE_EXPRESSION_EVIDENCE_MINIMUM = 4;
    const SCENE_DENSITY_EVIDENCE_MINIMUM = 4;
    const SUPPORT_GENRE_EVIDENCE_MINIMUM = 2;
    const CHARACTER_CONSISTENCY_POSITIVE_EVIDENCE_MINIMUM = 4;
    const CHARACTER_INTERPRETATION_POSITIVE_EVIDENCE_MINIMUM = 3;
    const CHARACTER_INTERPRETATION_FAILURE_EVIDENCE_MINIMUM = 2;
    const CHARACTER_AGENCY_EVIDENCE_MINIMUM = 4;
    const CHARACTER_RELATIONSHIP_EVIDENCE_MINIMUM = 3;
    const CHARACTER_CONTINUITY_EVIDENCE_MINIMUM = 4;
    const GENRE_FAILURE_EVIDENCE_MINIMUM = 3;
    const CHARACTER_FAILURE_EVIDENCE_MINIMUM = 2;
    const RELATIONSHIP_FAILURE_EVIDENCE_MINIMUM = 2;
    const CONTINUITY_FAILURE_EVIDENCE_MINIMUM = 2;
    const REPETITION_GENERAL_EVIDENCE_MINIMUM = 3;
    const REPETITION_EXACT_EVIDENCE_MINIMUM = 2;
    const AUDIT_REASON_MAX_CHARS_KO = 80;
    const AUDIT_REASON_MAX_CHARS_EN = 140;
    const AUDIT_REASON_MAX_SENTENCES = 1;
    const AUDIT_REASON_SCHEMA_MAX_CHARS_KO = 240;
    const AUDIT_REASON_SCHEMA_MAX_CHARS_EN = 320;
    const AUDIT_REASON_DISPLAY_HARD_LIMIT = 600;
    const CHARACTER_CORRECTION_MAX_CHARS = 1800;
    const CHARACTER_CORRECTION_MAX_WORDS = 220;
    const CHARACTER_BASELINE_FIELD_IDS = Object.freeze([
        "core_identity", "personality_traits", "values_boundaries",
        "goals_motives", "behavior_decisions", "speech_emotion",
        "relationship_response"
    ]);
    const CHARACTER_BASELINE_FIELD_ID_SET = new Set(CHARACTER_BASELINE_FIELD_IDS);
    const CHARACTER_BOOST_CORRECTION_CODES = new Set([
        "character_consistency", "character_interpretation", "char_agency",
        "relationship", "continuity", "repetition"
    ]);
    const CHARACTER_BASELINE_CORRECTION_CODES = new Set([
        "character_consistency", "character_interpretation",
        "char_agency", "relationship"
    ]);
    const GENRE_AUDIT_CODES = Object.freeze([
        "primary_genre", "genre_expression", "character_consistency", "char_agency",
        "relationship", "support_texture", "scene_density",
        "continuity", "character_interpretation", "repetition"
    ]);
    ${source.slice(reasonNormalizerStart, reasonNormalizerEnd)}
    ${source.slice(auditParserStart, auditParserEnd)}
    auditHelpers.parseGenreAuditResult = parseGenreAuditResult;
    auditHelpers.normalizeAuditReason = normalizeAuditReason;
    auditHelpers.normalizeCharacterCorrectionText = normalizeCharacterCorrectionText;
`);

const conciseReason = auditHelpers.normalizeAuditReason(
    "CHAR_RESPONSE_3에서 결정을 미뤘습니다. 응답 7번에서도 같은 흐름이 반복됐습니다. 세 번째 문장은 표시되면 안 됩니다."
);
assert.doesNotMatch(conciseReason, /CHAR_RESPONSE|응답 7번|같은 흐름|세 번째/);
assert.match(conciseReason, /최근 응답/);
assert.ok(conciseReason.length <= 80);
const reasonBeyondPromptTarget = auditHelpers.normalizeAuditReason(
    "한 문장으로 작성됐지만 프롬프트 목표 길이보다 조금 긴 진단 사유를 화면에서 억지로 자르지 않고 완결된 상태로 보여주기 위한 테스트 문구입니다 그리고 여기까지 같은 문장입니다"
);
assert.ok(reasonBeyondPromptTarget.length > 80);
assert.doesNotMatch(reasonBeyondPromptTarget, /…$/);
assert.doesNotMatch(
    auditHelpers.normalizeAuditReason("6·7번 응답에서 같은 문형이 반복됩니다."),
    /6·7번/
);
assert.ok(
    auditHelpers.normalizeAuditReason("English reason ".repeat(80), "en").length <=
        600
);
assert.match(
    auditHelpers.normalizeAuditReason("English reason ".repeat(80), "en"),
    /…$/
);
assert.equal(
    auditHelpers.normalizeCharacterCorrectionText("word ".repeat(250)).split(/\s+/).length,
    220
);

assert.match(
    source,
    /function buildGenreAuditJsonSchema[\s\S]{0,180}getAuditReasonSchemaMaxChars/
);
assert.doesNotMatch(source, /enum:\s*\["",\s*\.\.\.availableGenreIds\]/);
assert.match(source, /GENRE_RECOMMENDATION_NO_SUPPORT_ID\s*=\s*"none"/);

const genreParserStart = source.indexOf(
    "function parseGenreRecommendationResult("
);
const genreParserEnd = source.indexOf(
    "async function generateGenreRecommendation()",
    genreParserStart
);
assert.ok(genreParserStart >= 0 && genreParserEnd > genreParserStart);
const genreRecommendationHelpers = {};
eval(`
    const GENRE_RECOMMENDATION_NO_SUPPORT_ID = "none";
    const getAvailableGenres = () => [];
    const ensureModuleSettings = () => ({ outputLanguage: "ko" });
    ${source.slice(genreParserStart, genreParserEnd)}
    genreRecommendationHelpers.parse = parseGenreRecommendationResult;
`);
const recommendationGenres = [{ id: "romance" }, { id: "crime" }];
assert.equal(
    genreRecommendationHelpers.parse(
        JSON.stringify({ primaryId: "romance", supportId: "none", reason: "ok" }),
        recommendationGenres,
        "ko"
    ).supportId,
    ""
);
assert.equal(
    genreRecommendationHelpers.parse(
        JSON.stringify({ primaryId: "romance", supportId: "", reason: "ok" }),
        recommendationGenres,
        "ko"
    ).supportId,
    ""
);
assert.equal(
    genreRecommendationHelpers.parse(
        JSON.stringify({ primaryId: "romance", supportId: "crime", reason: "ok" }),
        recommendationGenres,
        "ko"
    ).supportId,
    "crime"
);

function audit(overrides = {}) {
    return auditHelpers.parseGenreAuditResult(
        JSON.stringify({
            primary_genre: "present",
            primary_genre_evidence: [1, 3, 6, 9],
            primary_genre_failure_evidence: [],
            primary_genre_reason: "주 장르의 핵심 논리가 선택과 관계에 반영됩니다.",
            genre_expression: "present",
            genre_expression_evidence: [1, 2, 7, 9],
            genre_expression_failure_evidence: [],
            genre_expression_reason: "장르 고유 표현이 묘사와 진행에 드러납니다.",
            support_texture: "present",
            support_texture_evidence: [3, 8],
            support_texture_opportunity: [],
            support_texture_identifiable: true,
            support_texture_reason: "보조 장르의 압력과 질감이 구체적으로 보입니다.",
            scene_density: "present",
            scene_density_evidence: [1, 4, 5, 8],
            scene_density_failure_evidence: [],
            scene_density_reason: "공간과 행동의 세부가 장면 의미에 작용합니다.",
            character_consistency: "stable",
            character_consistency_positive_evidence: [1, 4, 7, 9],
            character_consistency_evidence: [],
            character_consistency_severe: false,
            character_consistency_reason: "캐릭터 기준과 일관된 선택을 유지합니다.",
            character_interpretation: "stable",
            character_interpretation_positive_evidence: [2, 7, 10],
            character_interpretation_evidence: [],
            character_interpretation_reason: "한쪽 특성으로 치우치지 않습니다.",
            character_correction: "",
            character_focus_fields: [],
            char_agency: "present",
            char_agency_evidence: [2, 5, 7, 9],
            char_agency_failure_evidence: [],
            char_agency_reason: "자신의 동기에 따라 선택하고 행동합니다.",
            relationship: "present",
            relationship_evidence: [3, 6, 10],
            relationship_failure_evidence: [],
            relationship_reason: "기존 관계의 기억과 긴장에 반응합니다.",
            continuity: "present",
            continuity_evidence: [4, 6, 7, 8],
            continuity_failure_evidence: [],
            continuity_severe: false,
            continuity_reason: "직전 행동과 감정을 자연스럽게 이어갑니다.",
            repetition: "stable",
            repetition_evidence: [],
            repetition_exact: false,
            repetition_reason: "표현과 관계 반응이 기계적으로 반복되지 않습니다.",
            ...overrides,
        }),
        true,
        10
    );
}

const evidenceBackedStableAudit = audit();
assert.deepEqual(evidenceBackedStableAudit.correctionCodes, []);
assert.equal(evidenceBackedStableAudit.ratings.char_agency, "present");

const unsupportedAgency = audit({ char_agency_evidence: [2] });
assert.equal(unsupportedAgency.ratings.char_agency, "attention");
assert.deepEqual(unsupportedAgency.correctionCodes, []);
assert.ok(unsupportedAgency.uncertain.includes("char_agency"));
assert.match(unsupportedAgency.reasons.char_agency, /판단을 보류/);

const unsupportedDensity = audit({ scene_density_evidence: [1] });
assert.equal(unsupportedDensity.ratings.scene_density, "attention");
assert.deepEqual(unsupportedDensity.correctionCodes, []);
assert.ok(unsupportedDensity.uncertain.includes("scene_density"));
assert.match(unsupportedDensity.reasons.scene_density, /판단을 보류/);

const repeatedAgencyFailure = audit({
    char_agency_failure_evidence: [1, 4, 8],
    character_correction:
        "AGENCY: Restore the character's established impulse to choose and act from personal motives. Make the correction visible through a concrete decision that changes the current exchange, without deciding the user's response or inventing an unrelated incident.",
});
assert.equal(repeatedAgencyFailure.ratings.char_agency, "weak");
assert.match(repeatedAgencyFailure.correctionByCode.char_agency, /meaningful.*agency/);
assert.equal(repeatedAgencyFailure.correctionText, "");

const relationshipFlattening = audit({
    relationship_failure_evidence: [2, 7],
});
assert.equal(relationshipFlattening.ratings.relationship, "weak");

const severeContinuityBreak = audit({
    continuity_failure_evidence: [6],
    continuity_severe: true,
});
assert.equal(severeContinuityBreak.ratings.continuity, "weak");

const twoReplyInterpretationBias = audit({
    character_interpretation: "biased",
    character_interpretation_evidence: [2, 8],
});
assert.equal(
    twoReplyInterpretationBias.ratings.character_interpretation,
    "biased"
);

const oneReplyRepetition = audit({
    repetition: "weak",
    repetition_evidence: [4],
});
assert.equal(oneReplyRepetition.ratings.repetition, "attention");

const repeatedPattern = audit({
    repetition: "weak",
    repetition_evidence: [2, 4, 9],
});
assert.equal(repeatedPattern.ratings.repetition, "weak");
assert.deepEqual(repeatedPattern.correctionCodes, ["repetition"]);
const exactRepeatedPattern = audit({
    repetition: "weak",
    repetition_evidence: [4, 9],
    repetition_exact: true,
});
assert.equal(exactRepeatedPattern.ratings.repetition, "weak");
assert.match(evidenceBackedStableAudit.reasons.char_agency, /동기/);

assert.match(source, /id="rp-genre-audit-detail"/);
assert.match(source, /id="rp-character-audit-detail"/);
assert.match(source, /function toggleManualAuditBoost/);
assert.match(source, /다음 응답 1회 보강/);
assert.match(readme, /별도 AI 호출/);
assert.match(css, /\.rp-audit-detail/);
assert.match(css, /\.rp-audit-status-chip\.is-attention/);
assert.match(source, /case "attention":\s*return "주의 항목 있음/);

// Stored 1.3.x audit records used a boolean repetition value. Loading them in
// The current release must preserve the meaning while accepting the attention status.
const storedAuditStart = source.indexOf("function normalizeStoredAuditEvidenceArray(");
const storedAuditEnd = source.indexOf("function storeLastAuditRecord(", storedAuditStart);
assert.ok(storedAuditStart >= 0 && storedAuditEnd > storedAuditStart);
const storedAuditHelpers = {};
eval(`
    const GENRE_AUDIT_RESPONSE_LIMIT = 10;
    const GENRE_AUDIT_CODES = Object.freeze([
        "primary_genre", "genre_expression", "support_texture", "scene_density",
        "character_consistency", "character_interpretation", "char_agency",
        "relationship", "continuity", "repetition"
    ]);
    const CHARACTER_BASELINE_FIELD_ID_SET = new Set();
    const normalizeAuditCorrections = () => ({}); // Old records have no custom per-code corrections.
    const normalizeCharacterCorrectionText = (value) => String(value || "");
    ${source.slice(storedAuditStart, storedAuditEnd)}
    storedAuditHelpers.normalize = normalizeGenreAuditRecord;
`);
const legacyAuditRecord = storedAuditHelpers.normalize({
    ratings: {
        primary_genre: "present",
        genre_expression: "present",
        support_texture: "dormant",
        scene_density: "present",
        character_consistency: "stable",
        character_interpretation: "stable",
        char_agency: "present",
        relationship: "present",
        continuity: "present",
        repetition: true,
    },
    evidence: {},
    status: "stable",
});
assert.equal(legacyAuditRecord.ratings.repetition, "weak");
const attentionAuditRecord = storedAuditHelpers.normalize({
    ratings: { ...legacyAuditRecord.ratings, repetition: "attention" },
    evidence: {},
    status: "attention",
});
assert.equal(attentionAuditRecord.ratings.repetition, "attention");
assert.equal(attentionAuditRecord.status, "attention");

// A diagnosis that finishes after the user changes the one-shot correction
// must not overwrite the user's newer manual selection.
assert.match(source, /correctionRevisionAtStart/);
assert.match(source, /chatState\.genreAnchor\.correctionRevision !==/);
assert.match(source, /기존 1회 보강 선택을 유지했어요/);
assert.match(source, /function reconcilePendingAuditRecords/);
assert.match(source, /function removeLiveCorrectionCodes/);

// Genre and character cancellation/feature toggles are scoped independently.
assert.match(source, /function cancelPendingGenreCorrection\(scope = "combined"\)/);
assert.match(source, /cancelPendingGenreCorrection\("genre"\)/);
assert.match(source, /cancelPendingGenreCorrection\("character"\)/);
const featureToggleStart = source.indexOf("function changeBoosterFeature(");
const featureToggleEnd = source.indexOf(
    "function changeAuditInterval(",
    featureToggleStart
);
const featureToggleSource = source.slice(featureToggleStart, featureToggleEnd);
assert.match(featureToggleSource, /GENRE_BOOST_CORRECTION_CODES/);
assert.match(featureToggleSource, /CHARACTER_BOOST_CORRECTION_CODES/);
assert.match(featureToggleSource, /removeLiveCorrectionCodes/);
assert.doesNotMatch(featureToggleSource, /anchor\.responseCount = 0/);

// Deleting a custom genre only changes chats that actually selected or were
// recommended that genre; unrelated chat state is left intact.
const deleteGenreStart = source.indexOf("function deleteCustomGenre(");
const deleteGenreEnd = source.indexOf(
    "const genreRecommendationPendingChats",
    deleteGenreStart
);
const deleteGenreSource = source.slice(deleteGenreStart, deleteGenreEnd);
assert.match(deleteGenreSource, /const affectedChats = \[\]/);
assert.match(deleteGenreSource, /usedAsPrimary/);
assert.match(deleteGenreSource, /usedAsSupport/);
assert.match(deleteGenreSource, /for \(const affected of affectedChats\)/);
assert.doesNotMatch(
    deleteGenreSource,
    /for \(const state of Object\.values\(settings\.chats\)\)/
);

// Exercise the scoped queue helper directly so later refactors cannot silently
// cancel another module's pending correction.
const correctionHelperStart = source.indexOf("function bumpCorrectionRevision(");
const correctionHelperEnd = source.indexOf(
    "function handleGenreResponseReceived",
    correctionHelperStart
);
const correctionHelpers = {};
eval(`
    const GENRE_AUDIT_CODES = Object.freeze([
        "primary_genre", "genre_expression", "support_texture", "scene_density",
        "character_consistency", "character_interpretation", "char_agency",
        "relationship", "continuity", "repetition"
    ]);
    const CHARACTER_BOOST_CORRECTION_CODES = new Set([
        "character_consistency", "character_interpretation", "char_agency",
        "relationship", "continuity", "repetition"
    ]);
    const getGlobalAuditInterval = () => 10;
    ${source.slice(correctionHelperStart, correctionHelperEnd)}
    correctionHelpers.removeLiveCorrectionCodes = removeLiveCorrectionCodes;
`);
const correctionAnchor = {
    correctionRevision: 0,
    correctionCodes: ["primary_genre", "char_agency"],
    correctionStatus: "pending",
    correctionText: "pending",
    correctionCharacterBaselineHash: "hash",
    correctionArmedAtAssistantCount: 3,
    lastGenreAudit: { status: "pending", correctionCodes: ["primary_genre"] },
    lastCharacterAudit: { status: "pending", correctionCodes: ["char_agency"] },
};
correctionHelpers.removeLiveCorrectionCodes(
    correctionAnchor,
    new Set(["primary_genre", "genre_expression", "support_texture", "scene_density"])
);
assert.deepEqual(correctionAnchor.correctionCodes, ["char_agency"]);
assert.equal(correctionAnchor.lastGenreAudit.status, "cancelled");
assert.equal(correctionAnchor.lastCharacterAudit.status, "pending");
assert.equal(correctionAnchor.correctionRevision, 1);

// Character baseline generation accepts common provider shape variations and
// requests one format repair only when genuinely required content is missing.
const baselineNormalizerStart = source.indexOf(
    "function normalizeCharacterBaselineGenerationPayload("
);
const baselineNormalizerEnd = source.indexOf(
    "async function generateCharacterBaseline(",
    baselineNormalizerStart
);
assert.ok(
    baselineNormalizerStart >= 0 && baselineNormalizerEnd > baselineNormalizerStart
);
const baselineGenerationHelpers = {};
eval(`
    ${source.slice(baselineNormalizerStart, baselineNormalizerEnd)}
    baselineGenerationHelpers.normalize = normalizeCharacterBaselineGenerationPayload;
    baselineGenerationHelpers.getIssues = getCharacterBaselineGenerationIssues;
`);
const baselineFields = [
    { id: "core_identity", label: "핵심 정체성" },
    { id: "personality_traits", label: "성격·특성" },
];
const flattenedBaseline = baselineGenerationHelpers.normalize(
    {
        core_identity: "충분히 구체적인 핵심 정체성 설명입니다.",
        personality_traits: "충분히 구체적인 성격과 특성 설명입니다.",
        boost_anchor: "A sufficiently detailed English character anchor for testing.",
        boost_anchor_display: "검증에 충분한 한국어 표시용 캐릭터 앵커입니다.",
    },
    baselineFields
);
assert.match(flattenedBaseline.fields.core_identity, /핵심 정체성/);
assert.deepEqual(
    baselineGenerationHelpers.getIssues(flattenedBaseline, baselineFields, {
        includeBoostAnchor: true,
        outputLanguage: "ko",
    }),
    []
);
const nestedBaseline = baselineGenerationHelpers.normalize(
    {
        character_baseline: {
            fields: {
                core_identity: { text: "중첩된 핵심 정체성 설명도 정상적으로 복구합니다." },
                personality_traits: { value: "중첩된 성격 특성 설명도 정상적으로 복구합니다." },
            },
            boostAnchor: "A nested English character anchor long enough for validation.",
            boostAnchorDisplay: "중첩된 한국어 표시용 캐릭터 앵커도 복구합니다.",
        },
    },
    baselineFields
);
assert.deepEqual(
    baselineGenerationHelpers.getIssues(nestedBaseline, baselineFields, {
        includeBoostAnchor: true,
        outputLanguage: "ko",
    }),
    []
);
assert.deepEqual(
    baselineGenerationHelpers.getIssues(
        { ...flattenedBaseline, fields: { ...flattenedBaseline.fields, personality_traits: "" } },
        baselineFields,
        { includeBoostAnchor: true, outputLanguage: "ko" }
    ),
    ["성격·특성"]
);
assert.match(source, /캐릭터 기준 응답 형식을 보정해 다시 요청/);
assert.match(source, /STORYBOOSTER_CHARACTER_BASELINE_INCOMPLETE/);
assert.match(source, /const baselineResponseLength = requestedField \? 1200 : 3600/);


// Global diagnostic tools expose the exact current injection separately from
// a compact error report. Error entries are session-only, capped at three,
// and repeated signatures increment a counter instead of storing duplicates.
assert.match(source, /const MAX_ERROR_LOG_ENTRIES = 3/);
assert.match(source, /const ERROR_LOG_STORAGE_KEY = `\$\{MODULE_NAME\}:error-diagnostic-log`/);
assert.match(source, /id="rp-view-injection-prompt"/);
assert.match(source, /id="rp-view-error-log"/);
assert.match(source, /openCurrentInjectionPromptViewer/);
assert.match(source, /openStoryBoosterErrorLog/);
assert.match(source, /function wireStoryBoosterToolPopup\(/);
assert.match(source, /wireStoryBoosterToolPopup\(popupId, callback, attempt \+ 1\)/);
assert.match(source, /const releasePopupReference = \(\) =>/);
assert.match(source, /Promise\.resolve\(popupLifecycle\)\.then/);
assert.match(source, /let currentStoryInjectionText = ""/);
assert.match(source, /const storyPrompt = currentStoryInjectionText/);
assert.match(source, /currentStoryInjectionText = text/);
assert.match(source, /currentPlotInjectionText = instruction/);
assert.match(source, /currentPlotInjectionText = ""/);
assert.match(source, /getTokenCountAsync \|\| context\?\.getTokenCount/);
assert.match(source, /\[STORYBOOSTER ERROR DIAGNOSTIC REPORT\]/);
assert.doesNotMatch(source, /entry\.(?:prompt|transcript|rawResponse|characterCard)\s*=/);

const diagnosticStart = source.indexOf("function getDiagnosticSessionStorage(");
const diagnosticEnd = source.indexOf(
    "function withRequestTimeout(",
    diagnosticStart
);
assert.ok(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart);
const diagnosticHelpers = {};
const diagnosticStorage = new Map();
eval(`
    const MODULE_NAME = "rp-genre-plot-booster";
    const STORYBOOSTER_VERSION = "1.5.6";
    const ERROR_LOG_STORAGE_KEY = MODULE_NAME + ":error-diagnostic-log";
    const MAX_ERROR_LOG_ENTRIES = 3;
    const BACKGROUND_REQUEST_TIMEOUT_MS = 180000;
    const recordedErrorObjects = new WeakSet();
    let lastErrorLogHintAt = 0;
    const getContext = () => ({ version: "test-st" });
    const toastr = { info() {} };
    const document = { getElementById() { return null; } };
    globalThis.sessionStorage = {
        getItem(key) { return diagnosticStorage.has(key) ? diagnosticStorage.get(key) : null; },
        setItem(key, value) { diagnosticStorage.set(key, value); },
    };
    ${source.slice(diagnosticStart, diagnosticEnd)}
    diagnosticHelpers.sanitize = sanitizeDiagnosticText;
    diagnosticHelpers.stage = getErrorDiagnosticStage;
    diagnosticHelpers.read = readStoryBoosterErrorLog;
    diagnosticHelpers.clear = clearStoryBoosterErrorLog;
    diagnosticHelpers.record = recordStoryBoosterError;
    diagnosticHelpers.report = buildStoryBoosterErrorReport;
`);
assert.doesNotMatch(
    diagnosticHelpers.sanitize("apiKey=SECRET_VALUE sk-testsecret12345678 https://private.example/path"),
    /SECRET_VALUE|sk-testsecret|private\.example/
);
assert.doesNotMatch(
    diagnosticHelpers.sanitize(
        "AIzaSyDUMMYSECRET1234567890ABCDE content: 'private roleplay line' C:\\Users\\Alice\\models\\private-model.gguf"
    ),
    /AIzaSy|private roleplay line|Alice|private-model/
);
diagnosticHelpers.clear();
for (let index = 1; index <= 4; index += 1) {
    const error = new Error(`distinct error ${index}`);
    error.code = `E_${index}`;
    diagnosticHelpers.record(error, {
        task: `task_${index}`,
        notify: false,
        returnedFields: ["fields:object", "fields.core_identity:string(44)"],
    });
}
assert.equal(diagnosticHelpers.read().length, 3);
assert.equal(diagnosticHelpers.read()[0].task, "task_4");
diagnosticHelpers.clear();
for (let index = 0; index < 2; index += 1) {
    const error = new Error("apiKey=SECRET_VALUE repeated failure");
    error.code = "REPEATED";
    diagnosticHelpers.record(error, {
        task: "character_baseline_all",
        notify: false,
        missingFields: ["goals_motives"],
    });
}
const repeatedEntries = diagnosticHelpers.read();
assert.equal(repeatedEntries.length, 1);
assert.equal(repeatedEntries[0].count, 2);
assert.deepEqual(repeatedEntries[0].missingFields, ["goals_motives"]);
diagnosticHelpers.clear();
const sameOperation = {
    operationId: "SB-SAME-OPERATION",
    task: "character_baseline_all",
};
diagnosticHelpers.record(new Error("same operation failure"), {
    diagnostic: sameOperation,
    notify: false,
});
diagnosticHelpers.record(new Error("same operation failure"), {
    diagnostic: sameOperation,
    notify: false,
});
const sameOperationEntries = diagnosticHelpers.read();
assert.equal(sameOperationEntries.length, 1);
assert.equal(sameOperationEntries[0].count, 1);
diagnosticHelpers.clear();
diagnosticHelpers.record(new Error("request failed after analysis"), {
    diagnostic: {
        operationId: "SB-METRICS",
        task: "combined_audit",
        promptChars: 321,
        transcriptChars: 654,
        inputChars: 975,
        contextItems: 10,
        responseLength: 5200,
        startedAt: Date.now() - 1500,
    },
    notify: false,
});
const metricEntry = diagnosticHelpers.read()[0];
assert.equal(metricEntry.promptChars, 321);
assert.equal(metricEntry.transcriptChars, 654);
assert.equal(metricEntry.inputChars, 975);
assert.equal(metricEntry.contextItems, 10);
assert.equal(metricEntry.responseLength, 5200);
assert.ok(metricEntry.elapsedMs >= 1000);
assert.match(diagnosticHelpers.report([metricEntry]), /입력 규모: 975자 · 맥락 10개/);
diagnosticHelpers.clear();
diagnosticHelpers.record(new Error("apiKey=SECRET_VALUE repeated failure"), {
    task: "character_baseline_all",
    notify: false,
    missingFields: ["goals_motives"],
});
const reportEntries = diagnosticHelpers.read();
const errorReport = diagnosticHelpers.report(reportEntries);
assert.doesNotMatch(errorReport, /SECRET_VALUE/);
assert.doesNotMatch(errorReport, /character_card|roleplay_transcript|raw response/i);
assert.match(errorReport, /누락 필드: goals_motives/);
assert.equal(
    diagnosticHelpers.stage(new Error("API request failed")),
    "request_transport"
);
const missingAnchorError = new Error("missing anchor");
missingAnchorError.code = "STORYBOOSTER_REQUIRED_FIELDS_MISSING";
assert.equal(
    diagnosticHelpers.stage(missingAnchorError),
    "required_field_validation"
);
diagnosticHelpers.clear();
diagnosticHelpers.record(new Error("final fallback failure"), {
    task: "character_baseline_revision_anchor",
    notify: false,
    diagnostic: {
        compatibilityFallback: true,
        retryReason: "필수 앵커 필드 누락",
        retryCount: 1,
        requestCount: 2,
    },
});
const fallbackReport = diagnosticHelpers.report(diagnosticHelpers.read());
assert.match(fallbackReport, /호환 재시도: 사용 · 필수 앵커 필드 누락/);
assert.match(fallbackReport, /요청\/재시도: 2회 \/ 1회/);

// Character growth is stored as complete selectable revisions. The legacy
// baseline remains the original, while each chat stores only its active ID.
assert.match(source, /characterBaselineVersions:\s*\{\}/);
assert.match(source, /baselineVersionId = ""/);
assert.match(source, /function createCharacterBaselineVersion\(/);
assert.match(source, /function selectCharacterBaselineVersion\(/);
assert.match(source, /function deleteCurrentCharacterBaselineVersion\(/);
assert.match(source, /id="rp-character-baseline-version"/);
assert.match(source, /id="rp-character-version-rename"/);
assert.match(source, /id="rp-character-version-delete"/);
assert.match(source, /id="rp-character-revision-generate"/);
assert.match(source, /id="rp-character-revision-auto-generate"/);
assert.match(source, /id="rp-character-version-duplicate"/);
assert.match(source, /id="rp-character-revision-apply"/);
assert.match(source, /id="rp-character-revision-cancel"/);
assert.match(source, /원본은 삭제할 수 없음/);
assert.match(source, /MAX_CHARACTER_BASELINE_VERSIONS = 10/);
assert.match(readme, /각 채팅에서는 선택한 한 버전만 진단과 부스팅에 사용합니다/);
assert.match(readme, /현재 기준 복사본 만들기/);

const duplicateVersionStart = source.indexOf(
    "function duplicateCurrentCharacterBaselineVersion("
);
const duplicateVersionEnd = source.indexOf(
    "function renameCurrentCharacterBaselineVersion(",
    duplicateVersionStart
);
assert.ok(duplicateVersionStart >= 0 && duplicateVersionEnd > duplicateVersionStart);
const duplicateVersionSource = source.slice(
    duplicateVersionStart,
    duplicateVersionEnd
);
assert.match(duplicateVersionSource, /normalizeCharacterBaseline\(baselineState\.baseline\)/);
assert.match(duplicateVersionSource, /createCharacterBaselineVersion\(/);
assert.match(duplicateVersionSource, /parentVersionId: String\(baselineState\.versionId \|\| ""\)/);
assert.doesNotMatch(duplicateVersionSource, /generateStructuredAnalysis|requestCharacterBoostAnchor/);
assert.match(
    source,
    /querySelector\("#rp-character-version-duplicate"\)[\s\S]{0,180}duplicateCurrentCharacterBaselineVersion/
);

const createVersionStart = source.indexOf(
    "function createCharacterBaselineVersion("
);
const createVersionEnd = source.indexOf(
    "function getCharacterBaselineVersionOptions(",
    createVersionStart
);
const createVersionSource = source.slice(createVersionStart, createVersionEnd);
assert.doesNotMatch(createVersionSource, /characterBaselines\[/);
assert.match(createVersionSource, /characterBaselineVersions\[identity\.key\]/);
assert.match(createVersionSource, /boostState\.baselineVersionId = id/);
const versionHelpersStart = source.indexOf("function normalizeCharacterBaseline(");
const versionHelpersEnd = source.indexOf(
    "function createEmptyCharacterBaseline(",
    versionHelpersStart
);
const versionHelpers = {};
const versionSettings = {
    characterBaselines: {},
    characterBaselineVersions: {},
};
const versionChats = { chat_a: { characterBoost: { baselineVersionId: "" } } };
eval(`
    const CHARACTER_BASELINE_FIELD_MAX_CHARS = 1000;
    const CHARACTER_BOOST_ANCHOR_MAX_CHARS = 700;
    const CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS = 40;
    const MAX_CHARACTER_BASELINE_VERSIONS = 10;
    const CHARACTER_BASELINE_FIELDS = [
        { id: "core_identity", label: "핵심 정체성" },
        { id: "personality_traits", label: "성격·특성" },
    ];
    const ensureModuleSettings = () => versionSettings;
    const ensureCharacterBoostState = (state) => state.characterBoost;
    const ensureChatState = (chatId) => versionChats[chatId];
    const getCurrentChatId = () => "chat_a";
    ${source.slice(versionHelpersStart, versionHelpersEnd)}
    versionHelpers.create = createCharacterBaselineVersion;
    versionHelpers.get = getCharacterBaselineVersion;
    versionHelpers.write = writeCharacterBaselineVersion;
`);
const originalVersionBaseline = {
    characterName: "테스트 캐릭터",
    fields: {
        core_identity: { text: "원본의 핵심 정체성은 변하지 않아야 합니다." },
        personality_traits: { text: "원본의 성격 특성도 별도로 보존되어야 합니다." },
    },
    boostAnchor: "A sufficiently long original character anchor for regression testing.",
};
versionSettings.characterBaselines["character:test"] = originalVersionBaseline;
const createdVersion = versionHelpers.create(
    { key: "character:test", name: "테스트 캐릭터" },
    {
        ...originalVersionBaseline,
        fields: {
            ...originalVersionBaseline.fields,
            personality_traits: {
                text: "갱신본에서는 반복된 경험에 따라 감정을 더 분명히 표현합니다.",
            },
        },
    },
    {
        chatId: "chat_a",
        parentVersionId: "revision_parent",
        revisionMode: "directed",
        evidenceLevel: "partial",
    }
);
assert.equal(createdVersion.label, "1번 갱신");
assert.equal(createdVersion.parentVersionId, "revision_parent");
assert.equal(createdVersion.revisionMode, "directed");
assert.equal(createdVersion.evidenceLevel, "partial");
assert.equal(versionChats.chat_a.characterBoost.baselineVersionId, createdVersion.id);
assert.match(
    versionHelpers.get("character:test", createdVersion.id).fields
        .personality_traits.text,
    /갱신본에서는/
);
assert.match(
    versionHelpers.get("character:test", "").fields.personality_traits.text,
    /원본의 성격 특성/
);

// Requested revisions treat the user's direction as the editing goal while
// preserving pinned text and using exactly twenty recent assistant replies.
assert.match(source, /temporary mood, one scene/);
assert.match(source, /relationship-specific development scoped to the relevant relationship/);
assert.match(source, /primary editing instruction, not a hypothesis/);
assert.match(source, /If recent evidence is sparse, still create the requested revision/);
assert.match(source, /These pinned fields must be copied exactly without any change/);
assert.match(source, /CHARACTER_REVISION_ASSISTANT_REPLIES = 20/);
assert.match(source, /<user_requested_direction>/);
assert.match(source, /<recent_roleplay>/);
assert.match(source, /evidence_level/);
assert.match(source, /evidence_summary/);
const revisionGenerateStart = source.indexOf(
    "async function generateCharacterBaselineRevisionProposal("
);
const revisionGenerateEnd = source.indexOf(
    "function cancelCharacterBaselineRevisionProposal(",
    revisionGenerateStart
);
const revisionGenerateSource = source.slice(
    revisionGenerateStart,
    revisionGenerateEnd
);
assert.doesNotMatch(revisionGenerateSource, /<character_card>/);
assert.match(
    revisionGenerateSource,
    /const resolvedNote = automatic \? "" : resolveRoleMacrosForDisplay\(note\)/
);
assert.match(source, /최근 AI 답변 20개와 각 답변 직전의 유저 입력/);
assert.doesNotMatch(source, /getCharacterRevisionProposalKey\(identity\.key\)/);
assert.doesNotMatch(source, /getCharacterRevisionProposalKey\(identityKey\)/);
const revisionNormalizeStart = source.indexOf(
    "function normalizeCharacterBaselineRevisionPayload("
);
const revisionNormalizeEnd = source.indexOf(
    "async function requestCharacterBoostAnchor(",
    revisionNormalizeStart
);
assert.ok(
    revisionNormalizeStart >= 0 &&
        revisionNormalizeEnd > revisionNormalizeStart
);
const revisionHelpers = {};
eval(`
    const CHARACTER_BASELINE_FIELD_MAX_CHARS = 1000;
    const CHARACTER_BASELINE_FIELDS = [
        { id: "core_identity", label: "핵심 정체성" },
        { id: "personality_traits", label: "성격·특성" },
    ];
    ${source.slice(revisionNormalizeStart, revisionNormalizeEnd)}
    revisionHelpers.normalize = normalizeCharacterBaselineRevisionPayload;
`);
const revisionBase = {
    fields: {
        core_identity: {
            text: "고정된 핵심 정체성은 그대로 유지되어야 합니다.",
            pinned: true,
        },
        personality_traits: {
            text: "기존 성격 특성은 감정을 거의 표현하지 않습니다.",
            pinned: false,
        },
    },
};
const normalizedRevision = revisionHelpers.normalize(
    {
        fields: {
            core_identity: "AI가 바꾸려고 한 충분히 긴 핵심 정체성 문장입니다.",
            personality_traits:
                "신뢰가 쌓인 관계에서는 감정을 조심스럽게 말로 표현합니다.",
        },
        change_reasons: {
            core_identity: "변경 시도",
            personality_traits: "반복된 표현 변화",
        },
        evidence_level: "partial",
        evidence_summary: "최근 대화 일부와 사용자가 지정한 변화 방향을 함께 반영했습니다.",
    },
    revisionBase
);
assert.equal(
    normalizedRevision.fields.core_identity.text,
    revisionBase.fields.core_identity.text
);
assert.deepEqual(normalizedRevision.changedFields, ["personality_traits"]);
assert.match(
    normalizedRevision.fields.personality_traits.reason,
    /반복된 표현 변화/
);
assert.equal(normalizedRevision.evidenceLevel, "partial");
assert.match(normalizedRevision.evidenceSummary, /변화 방향/);

// Saving an approved proposal generates its anchor before creating and
// selecting the persistent version, avoiding half-saved active revisions.
const revisionApplyStart = source.indexOf(
    "async function applyCharacterBaselineRevisionProposal()"
);
const revisionApplyEnd = source.indexOf(
    "async function generateCharacterBaseline(",
    revisionApplyStart
);
const revisionApplySource = source.slice(revisionApplyStart, revisionApplyEnd);
assert.ok(
    revisionApplySource.indexOf("await requestCharacterBoostAnchor") <
        revisionApplySource.indexOf("createCharacterBaselineVersion")
);
assert.match(revisionApplySource, /parentVersionId: proposal\.baseVersionId/);
assert.match(revisionApplySource, /revisionMode: proposal\.mode/);
assert.match(revisionApplySource, /evidenceLevel: proposal\.evidenceLevel/);
assert.match(revisionApplySource, /STORYBOOSTER_CONTEXT_CHANGED/);

// A connection profile or the current chat connection that rejects or ignores
// JSON schema falls back to tagged text, with one final tagged repair attempt
// when needed. Missing and short fields remain explicit validation errors so
// diagnostics can distinguish them from transport errors.
assert.match(source, /function extractTaggedCharacterAnchorResult\(/);
assert.match(source, /function parseCharacterBoostAnchorResult\(/);
assert.match(source, /STORYBOOSTER_REQUIRED_FIELDS_MISSING/);
assert.match(source, /STORYBOOSTER_INVALID_FIELDS/);
assert.match(source, /STORYBOOSTER_INCOMPLETE_TAGGED_OUTPUT/);
assert.match(source, /function shouldRetryCharacterAnchorWithoutSchema\(/);
assert.match(source, /jsonSchema: tagged \? null : jsonSchema/);
assert.match(source, /validateJson: !tagged/);
assert.match(source, /recordErrors: false/);
assert.match(source, /diagnostic\.compatibilityFallback = true/);
assert.match(source, /COMPATIBILITY FALLBACK: Do not return JSON/);

const backgroundProfileStart = source.indexOf(
    "async function generateWithBackgroundProfile("
);
const backgroundProfileEnd = source.indexOf(
    "async function generateStructuredAnalysis(",
    backgroundProfileStart
);
assert.ok(backgroundProfileStart >= 0 && backgroundProfileEnd > backgroundProfileStart);
const backgroundProfileSource = source.slice(
    backgroundProfileStart,
    backgroundProfileEnd
);
assert.match(
    backgroundProfileSource,
    /captureOperationResponseDiagnostic\(\s*diagnostic,\s*result,\s*text,\s*"connection_profile"\s*\)/
);
assert.ok(
    backgroundProfileSource.indexOf("captureOperationResponseDiagnostic(") <
        backgroundProfileSource.indexOf("assertStructuredOutputPresent(")
);
assert.match(backgroundProfileSource, /if \(validateJson\) \{/);

const compatibilityHelperStart = source.indexOf(
    "function shouldRetryStructuredJsonCompatibility("
);
const compatibilityHelperEnd = source.indexOf(
    "const GENRE_CORRECTION_LABELS",
    compatibilityHelperStart
);
assert.ok(
    compatibilityHelperStart >= 0 &&
        compatibilityHelperEnd > compatibilityHelperStart
);
const compatibilityHarness = {};
const compatibilityResponses = [];
const compatibilityOptions = [];
eval(`
    const generateStructuredAnalysis = async (options) => {
        compatibilityOptions.push(options);
        const response = compatibilityResponses.shift();
        if (response instanceof Error) throw response;
        return response;
    };
    ${source.slice(compatibilityHelperStart, compatibilityHelperEnd)}
    compatibilityHarness.request = requestStructuredJsonWithCompatibility;
`);
const emptyStructuredError = new Error("empty structured response");
emptyStructuredError.code = "STORYBOOSTER_EMPTY_STRUCTURED_OUTPUT";
compatibilityResponses.push(emptyStructuredError, '{"ok":true}');
const compatibilityDiagnostic = {
    retryCount: 0,
    compatibilityFallback: false,
    retryReason: "",
};
const compatibilityResult = await compatibilityHarness.request({
    prompt: "test prompt",
    transcript: "test transcript",
    jsonSchema: { name: "test", schema: { type: "object" } },
    responseLength: 1200,
    connectionSnapshot: { source: "main" },
    task: "genre_audit",
    diagnostic: compatibilityDiagnostic,
    parseResult: (value) => JSON.parse(value),
});
assert.equal(compatibilityResult.ok, true);
assert.equal(compatibilityOptions.length, 2);
assert.ok(compatibilityOptions[0].jsonSchema);
assert.equal(compatibilityOptions[1].jsonSchema, null);
assert.equal(compatibilityOptions[1].recordErrors, false);
assert.equal(compatibilityDiagnostic.retryCount, 1);
assert.equal(compatibilityDiagnostic.compatibilityFallback, true);

compatibilityOptions.length = 0;
const firstEmptyError = new Error("empty structured response");
firstEmptyError.code = "STORYBOOSTER_EMPTY_STRUCTURED_OUTPUT";
const incompleteJsonError = new Error("incomplete JSON response");
incompleteJsonError.code = "STORYBOOSTER_INCOMPLETE_JSON";
compatibilityResponses.push(
    firstEmptyError,
    incompleteJsonError,
    '{"ok":"repaired"}'
);
const repairDiagnostic = {
    retryCount: 0,
    compatibilityFallback: false,
    retryReason: "",
};
const repairedStructuredResult = await compatibilityHarness.request({
    prompt: "test prompt",
    transcript: "test transcript",
    jsonSchema: { name: "test", schema: { type: "object" } },
    responseLength: 1200,
    connectionSnapshot: { source: "profile" },
    task: "character_baseline_all",
    diagnostic: repairDiagnostic,
    parseResult: (value) => JSON.parse(value),
});
assert.equal(repairedStructuredResult.ok, "repaired");
assert.equal(compatibilityOptions.length, 3);
assert.equal(compatibilityOptions[2].jsonSchema, null);
assert.equal(compatibilityOptions[2].responseLength, 4800);
assert.equal(repairDiagnostic.retryCount, 2);
assert.match(repairDiagnostic.retryReason, /일반 JSON 복구/);

const plotHelperStart = source.indexOf(
    "function extractTaggedPlotEventResult("
);
const plotHelperEnd = source.indexOf(
    "async function generateEventCandidate(",
    plotHelperStart
);
assert.ok(plotHelperStart >= 0 && plotHelperEnd > plotHelperStart);
const plotCompatibilityHarness = {};
eval(`
    const extractTextFromGenerationData = (value) => String(value || "").trim();
    const extractJsonObject = (value, emptyMessage) => {
        const text = extractTextFromGenerationData(value);
        if (!text) throw new Error(emptyMessage);
        return JSON.parse(text);
    };
    ${structuredPayloadHelpers}
    ${source.slice(plotHelperStart, plotHelperEnd)}
    plotCompatibilityHarness.parse = parsePlotEventResult;
`);
assert.throws(
    () => plotCompatibilityHarness.parse("{}"),
    (error) =>
        error.code === "STORYBOOSTER_REQUIRED_FIELDS_MISSING" &&
        error.missingFields.join(",") === "event"
);
assert.equal(
    plotCompatibilityHarness.parse(
        "<plot_event>태그 호환 재시도에서 반환한 직접적인 사건입니다.</plot_event>",
        { allowTagged: true }
    ),
    "태그 호환 재시도에서 반환한 직접적인 사건입니다."
);
assert.throws(
    () =>
        plotCompatibilityHarness.parse(
            "<plot_event>끝나지 않은 사건",
            { allowTagged: true }
        ),
    (error) => error.code === "STORYBOOSTER_INCOMPLETE_TAGGED_OUTPUT"
);
const plotGenerationStart = source.indexOf(
    "async function generateEventCandidate("
);
const plotGenerationEnd = source.indexOf(
    "function clearGeneratedEventResult(",
    plotGenerationStart
);
const plotGenerationSource = source.slice(
    plotGenerationStart,
    plotGenerationEnd
);
assert.match(plotGenerationSource, /jsonSchema: tagged \? null : plotJsonSchema/);
assert.match(plotGenerationSource, /validateJson: !tagged/);
assert.match(plotGenerationSource, /plotDiagnostic\.compatibilityFallback = true/);
assert.match(plotGenerationSource, /Return exactly <plot_event>event text<\/plot_event>/);
assert.match(plotGenerationSource, /FINAL REPAIR: The previous tagged response was empty/);

const anchorHelperStart = source.indexOf(
    "function extractTaggedCharacterAnchorResult("
);
const anchorHelperEnd = source.indexOf(
    "async function generateCharacterBaselineRevisionProposal(",
    anchorHelperStart
);
assert.ok(anchorHelperStart >= 0 && anchorHelperEnd > anchorHelperStart);
const anchorHarness = {};
const anchorResponses = [];
const anchorOptions = [];
eval(`
    const CHARACTER_BOOST_ANCHOR_MAX_CHARS = 700;
    const getCharacterBoostAnchorRequirements = () => "anchor requirements";
    const serializeCharacterBaseline = () => "serialized baseline";
    const extractTextFromGenerationData = (value) => String(value || "").trim();
    const extractJsonObject = (value, emptyMessage) => {
        const text = extractTextFromGenerationData(value);
        if (!text) throw new Error(emptyMessage);
        return JSON.parse(text);
    };
    const generateStructuredAnalysis = async (options) => {
        anchorOptions.push(options);
        const response = anchorResponses.shift();
        if (response instanceof Error) throw response;
        return response;
    };
    ${structuredPayloadHelpers}
    ${source.slice(anchorHelperStart, anchorHelperEnd)}
    anchorHarness.parse = parseCharacterBoostAnchorResult;
    anchorHarness.shouldRetry = shouldRetryCharacterAnchorWithoutSchema;
    anchorHarness.request = requestCharacterBoostAnchor;
`);
assert.throws(
    () => anchorHarness.parse("{}", "ko"),
    (error) =>
        error.code === "STORYBOOSTER_REQUIRED_FIELDS_MISSING" &&
        error.missingFields.join(",") === "boost_anchor,boost_anchor_display"
);
anchorResponses.push(
    "{}",
    "<boost_anchor>A sufficiently long English anchor returned by the tagged compatibility fallback.</boost_anchor>" +
        "<boost_anchor_display>태그 호환 재시도에서 반환한 충분히 긴 한국어 표시용 캐릭터 앵커입니다.</boost_anchor_display>"
);
const anchorDiagnostic = {
    task: "character_baseline_revision_anchor",
    retryCount: 0,
    compatibilityFallback: false,
    retryReason: "",
};
const retriedAnchor = await anchorHarness.request({
    identity: { name: "테스트 캐릭터" },
    baseline: { fields: {} },
    outputLanguage: "ko",
    connectionSnapshot: { source: "profile", apiType: "openai" },
    diagnostic: anchorDiagnostic,
});
assert.match(retriedAnchor.boostAnchor, /tagged compatibility fallback/);
assert.equal(anchorOptions.length, 2);
assert.ok(anchorOptions[0].jsonSchema);
assert.equal(anchorOptions[1].jsonSchema, null);
assert.equal(anchorOptions[1].validateJson, false);
assert.equal(anchorOptions[1].recordErrors, false);
assert.equal(anchorDiagnostic.retryCount, 1);
assert.equal(anchorDiagnostic.compatibilityFallback, true);
assert.equal(anchorDiagnostic.retryReason, "필수 앵커 필드 누락");
anchorOptions.length = 0;
anchorResponses.push(
    "{}",
    "<boost_anchor>A sufficiently long English anchor returned for the current chat connection.</boost_anchor>" +
        "<boost_anchor_display>현재 채팅 연결의 태그 호환 재시도에서 반환한 충분히 긴 한국어 앵커입니다.</boost_anchor_display>"
);
const mainConnectionDiagnostic = {
    task: "character_anchor_regeneration",
    retryCount: 0,
    compatibilityFallback: false,
    retryReason: "",
};
const mainConnectionAnchor = await anchorHarness.request({
    identity: { name: "테스트 캐릭터" },
    baseline: { fields: {} },
    outputLanguage: "ko",
    connectionSnapshot: { source: "main", apiType: "openai" },
    diagnostic: mainConnectionDiagnostic,
});
assert.match(mainConnectionAnchor.boostAnchor, /current chat connection/);
assert.equal(anchorOptions.length, 2);
assert.ok(anchorOptions[0].jsonSchema);
assert.equal(anchorOptions[1].jsonSchema, null);
assert.equal(mainConnectionDiagnostic.retryCount, 1);
assert.equal(mainConnectionDiagnostic.compatibilityFallback, true);
assert.equal(mainConnectionDiagnostic.retryReason, "필수 앵커 필드 누락");

anchorOptions.length = 0;
anchorResponses.push(
    "{}",
    "<boost_anchor>an interrupted tagged anchor",
    "<boost_anchor>A sufficiently long English anchor returned by the final tagged repair.</boost_anchor>" +
        "<boost_anchor_display>최종 태그 복구 요청에서 반환한 충분히 긴 한국어 표시용 앵커입니다.</boost_anchor_display>"
);
const repairedDiagnostic = {
    task: "character_anchor_regeneration",
    retryCount: 0,
    compatibilityFallback: false,
    retryReason: "",
};
const repairedAnchor = await anchorHarness.request({
    identity: { name: "테스트 캐릭터" },
    baseline: { fields: {} },
    outputLanguage: "ko",
    connectionSnapshot: { source: "profile", apiType: "openai" },
    diagnostic: repairedDiagnostic,
});
assert.match(repairedAnchor.boostAnchor, /final tagged repair/);
assert.equal(anchorOptions.length, 3);
assert.equal(anchorOptions[2].validateJson, false);
assert.equal(anchorOptions[2].responseLength, 1800);
assert.equal(repairedDiagnostic.retryCount, 2);
assert.equal(repairedDiagnostic.compatibilityFallback, true);
assert.match(repairedDiagnostic.retryReason, /태그 응답 복구/);

const anchorRegenerationStart = source.indexOf(
    "async function regenerateCharacterBoostAnchor()"
);
const anchorRegenerationEnd = source.indexOf(
    "function deleteCharacterBaseline(",
    anchorRegenerationStart
);
const anchorRegenerationSource = source.slice(
    anchorRegenerationStart,
    anchorRegenerationEnd
);
assert.match(anchorRegenerationSource, /await requestCharacterBoostAnchor\(/);
assert.doesNotMatch(anchorRegenerationSource, /await generateStructuredAnalysis\(/);

await import("./structural.test.mjs");
console.log("StoryBooster 1.7.0 regression tests passed.");
