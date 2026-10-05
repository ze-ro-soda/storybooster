import { responseValidationDetails } from '../core/response-validation.js';
import { formatAuditCorrectionInstruction } from '../core/audit-policy.js';
import { isDeveloperModeUnlocked } from '../core/debug-mode.js';
import { addLegacyAuditPolicySchema, finalizeLegacyAudit, legacyAuditPolicyPrompt } from './legacy-diagnosis.js';
import { auditCancellationMessage, auditTraceErrorKind, beginAuditRun, finishAuditRun, readAuditRuns, traceAuditStage } from '../core/audit-run-trace.js';
import { buildAuditTranscript } from './audit-context.js';
import { plotDecisionReason, plotAuditHoldReason } from './plot-status.js';
import { createAuditAnalysis, compareAuditHistory, rememberAudit } from '../core/audit-history.js';
// StoryBooster: features/audit.js
import { AUDIT_EVIDENCE_MAX_ITEMS, AUDIT_MESSAGE_MAX_CHARS, AUDIT_RESPONSE_LENGTHS, BACKGROUND_REQUEST_TIMEOUT_MS, CHARACTER_AGENCY_EVIDENCE_MINIMUM, CHARACTER_BASELINE_CORRECTION_CODES, CHARACTER_BASELINE_FIELD_IDS, CHARACTER_BASELINE_FIELD_ID_SET, CHARACTER_BOOST_CORRECTION_CODES, CHARACTER_CONSISTENCY_POSITIVE_EVIDENCE_MINIMUM, CHARACTER_CONTINUITY_EVIDENCE_MINIMUM, CHARACTER_CORRECTION_MAX_CHARS, CHARACTER_FAILURE_EVIDENCE_MINIMUM, CHARACTER_INTERPRETATION_FAILURE_EVIDENCE_MINIMUM, CHARACTER_INTERPRETATION_POSITIVE_EVIDENCE_MINIMUM, CHARACTER_RELATIONSHIP_EVIDENCE_MINIMUM, CONTINUITY_FAILURE_EVIDENCE_MINIMUM, GENRE_AUDIT_CODES, GENRE_AUDIT_RESPONSE_LIMIT, GENRE_BOOST_CORRECTION_CODES, GENRE_CORRECTION_LABELS, GENRE_CORRECTION_MODULES, GENRE_EXPRESSION_EVIDENCE_MINIMUM, GENRE_FAILURE_EVIDENCE_MINIMUM, GENRE_PROMPT_KEY, MODULE_NAME, PRIMARY_GENRE_EVIDENCE_RATIO, RELATIONSHIP_FAILURE_EVIDENCE_MINIMUM, REPETITION_EXACT_EVIDENCE_MINIMUM, REPETITION_GENERAL_EVIDENCE_MINIMUM, SCENE_DENSITY_EVIDENCE_MINIMUM, SUPPORT_GENRE_EVIDENCE_MINIMUM } from "../core/constants.js";
import { createOperationContextSnapshot, getCurrentCharacterIdentity, getCurrentChatId, getLatestAssistantMessageId, getRoleplayTranscript, isOperationContextCurrentChat, snapshotCurrentChatMessages } from "../core/context.js";
import { createOperationDiagnostic, recordStoryBoosterError, updateOperationDiagnosticConnection } from "../core/diagnostics.js";
import { createBackgroundConnectionSnapshot, requestStructuredJsonWithCompatibility, resolveBackgroundConnectionSnapshot } from "../core/requests.js";
import { extractJsonObject } from "../core/responses.js";
import { genreAuditPendingChats, runtime } from "../core/runtime.js";
import { extension_prompt_roles, extension_prompt_types, getContext, saveSettingsDebounced, setExtensionPrompt } from "../core/sillytavern.js";
import { armPendingGenreCorrectionForNextResponse, bumpCorrectionRevision, ensureChatState, ensureGenreAnchorState, ensureModuleSettings, getAvailableGenres, getCharacterBoosterReadiness, getCurrentCharacterBaseline, getGenrePromptLabel, getGlobalAuditInterval, isBoosterFeatureEnabled, markArmedGenreCorrectionApplied, normalizeGenreSelection, normalizeAuditCorrections, reconcilePendingAuditRecords, removeLiveCorrectionCodes, resolveCharacterCorrectionFieldIds, serializeCharacterBaseline, storeLastAuditRecord } from "../core/storage.js";
import { getAuditReasonMaxChars, getAuditReasonSchemaMaxChars, hashStableText, normalizeAuditReason, normalizeCharacterCorrectionText } from "../core/text.js";
import { updateGenreAnchorPanel } from "../core/ui-hooks.js";
import { getGenreProfile, getGenreProfileAuditStandard, getGenreSelectionSignature } from "./genre-model.js";
import { automaticPlotRuntime, cancelAutomaticPlot } from '../core/automatic-plot-state.js';
import { ensureJevKeyReady, getJevKeyRevision, hasJevSessionKey, isJevUsageAllowed } from '../core/jev-client.js';
import { runJevDiagnosis, writeJevFeedback } from './jev-diagnosis.js';
import { addPlotAuditSchema, automaticPlotEnabled, parsePlotDecision, plotAuditPrompt, prepareAutomaticPlot, roleplayFingerprint, diagnoseAutomaticPlot, healthyAuditForAutomaticPlot, ensureAutomaticPlotSettings, updateAutomaticPlotStatus } from './automatic-plot.js';
import { requireStructuredTextFields } from '../core/responses.js';

// @source-order 196
function showGenreAuditToast(kind, message) {
    const options = {
        timeOut: 2600,
        extendedTimeOut: 800,
        preventDuplicates: true,
    };
    toastr?.[kind]?.(message, "스토리부스터", options);
}

// @source-order 197
function getGenreAnchorSelection(state = ensureChatState()) {
    if (!isBoosterFeatureEnabled("genre")) return null;
    const genresById = new Map(getAvailableGenres().map((genre) => [genre.id, genre]));
    const genreSelection = normalizeGenreSelection(state);
    const primaryGenre = genresById.get(genreSelection.primaryId);
    if (!primaryGenre) return null;
    const supportGenre = genresById.get(genreSelection.supportIds[0]) || null;

    return {
        primaryGenre,
        supportGenre,
        correctionCodes: state.genreAnchor.correctionCodes,
        auditStatus: state.genreAnchor.auditStatus,
        responseCount: state.genreAnchor.responseCount,
    };
}

// @source-order 198
function getBoosterSelection(state = ensureChatState()) {
    const genreSelection = getGenreAnchorSelection(state);
    const baselineState = getCurrentCharacterBaseline();
    const characterReadiness = getCharacterBoosterReadiness(baselineState);
    const characterEnabled =
        characterReadiness.featureEnabled && characterReadiness.baselineAvailable;
    const autoPlotEnabled = automaticPlotEnabled(state);
    if (!genreSelection && !characterEnabled && !autoPlotEnabled) return null;
    const serializedCharacterBaseline =
        characterEnabled && baselineState.baseline
            ? serializeCharacterBaseline(baselineState.baseline)
            : "";
    const currentCharacterBaselineHash = serializedCharacterBaseline
        ? hashStableText(serializedCharacterBaseline)
        : "";
    const storedCorrectionBaselineHash = String(
        state.genreAnchor.correctionCharacterBaselineHash || ""
    );
    if (
        state === ensureModuleSettings().chats[getCurrentChatId()] &&
        storedCorrectionBaselineHash &&
        storedCorrectionBaselineHash !== currentCharacterBaselineHash &&
        state.genreAnchor.correctionCodes.some((code) =>
            CHARACTER_BOOST_CORRECTION_CODES.has(code)
        )
    ) {
        state.genreAnchor.correctionCodes = state.genreAnchor.correctionCodes.filter(
            (code) => GENRE_BOOST_CORRECTION_CODES.has(code)
        );
        state.genreAnchor.correctionText = "";
        state.genreAnchor.correctionByCode = normalizeAuditCorrections(state.genreAnchor.correctionByCode, state.genreAnchor.correctionCodes);
        state.genreAnchor.correctionFieldIds = [];
        state.genreAnchor.correctionCharacterBaselineHash = "";
        state.genreAnchor.correctionArmedRevision = 0;
        if (!state.genreAnchor.correctionCodes.length) {
            state.genreAnchor.correctionRemaining = 0;
            state.genreAnchor.correctionAppliedMessageId = null;
            state.genreAnchor.auditStatus = "waiting";
        }
        saveSettingsDebounced();
    }
    const correctionPendingForNextResponse = Boolean(
        state.genreAnchor.correctionRemaining > 0 &&
            state.genreAnchor.correctionAppliedMessageId === null
    );
    const correctionCodes = correctionPendingForNextResponse
        ? (state.genreAnchor.correctionCodes || []).filter(
              (code) =>
                  (genreSelection && GENRE_BOOST_CORRECTION_CODES.has(code)) ||
                  (characterEnabled && CHARACTER_BOOST_CORRECTION_CODES.has(code))
          )
        : [];
    const correctionFieldIds =
        characterEnabled && baselineState.baseline
            ? resolveCharacterCorrectionFieldIds(
                  baselineState.baseline,
                  state.genreAnchor.correctionFieldIds,
                  correctionCodes
              )
            : [];
    return {
        autoPlotEnabled,
        primaryGenre: genreSelection?.primaryGenre || null,
        supportGenre: genreSelection?.supportGenre || null,
        characterEnabled,
        characterBoostActive: characterReadiness.boostActive,
        characterBaseline:
            serializedCharacterBaseline,
        correctionCharacterBaseline:
            characterEnabled &&
            baselineState.baseline &&
            correctionFieldIds.length
                ? serializeCharacterBaseline(
                      baselineState.baseline,
                      correctionFieldIds
                  )
                : "",
        characterBaselineStatus: baselineState.status,
        characterBoostAnchor: characterReadiness.boostActive
            ? characterReadiness.boostAnchor
            : "",
        correctionCodes,
        correctionByCode: normalizeAuditCorrections(state.genreAnchor.correctionByCode, correctionCodes),
        correctionText: correctionCodes.some((code) =>
            CHARACTER_BOOST_CORRECTION_CODES.has(code)
        )
            ? normalizeCharacterCorrectionText(
                  state.genreAnchor.correctionText
              )
            : "",
        auditStatus: state.genreAnchor.auditStatus,
        responseCount: state.genreAnchor.responseCount,
    };
}

// @source-order 199
function buildGenrePromptText(selection) {
    const {
        primaryGenre,
        supportGenre,
        characterBoostActive,
        characterBoostAnchor,
        correctionCodes,
        correctionText,
        correctionByCode = {},
        correctionCharacterBaseline,
    } = selection;
    const primaryProfile = primaryGenre ? getGenreProfile(primaryGenre) : null;
    const supportProfile = supportGenre
        ? getGenreProfile(supportGenre)
        : null;
    const hasTargetedCharacterCorrection = Boolean(
        correctionText &&
            !correctionCodes.filter(code => CHARACTER_BOOST_CORRECTION_CODES.has(code)).every(code => correctionByCode[code]) &&
            correctionCodes.some((code) =>
                CHARACTER_BOOST_CORRECTION_CODES.has(code)
            )
    );
    const correctionLines = correctionCodes
        .filter(
            (code) =>
                correctionByCode[code] || !hasTargetedCharacterCorrection ||
                !CHARACTER_BOOST_CORRECTION_CODES.has(code)
        )
        .map((code) => `- ${correctionByCode[code] || GENRE_CORRECTION_MODULES[code]}`);

    if (!primaryGenre && !characterBoostActive && !correctionCodes.length) {
        return "";
    }

    return [
        "[STORYBOOSTER — STORY ANCHOR]",
        primaryGenre ? "GENRE:" : "",
        primaryGenre
            ? `PRIMARY GENRE: ${getGenrePromptLabel(primaryGenre)}`
            : "",
        primaryGenre
            ? `PRIMARY DIRECTION: ${primaryProfile.identity}`
            : "",
        primaryGenre
            ? `PRIMARY EXPRESSION: ${primaryProfile.signals}`
            : "",
        primaryGenre
            ? `PRIMARY CONSEQUENCE: ${primaryProfile.effects}`
            : "",
        primaryGenre
            ? `PRIMARY BOUNDARY: ${primaryProfile.guard}`
            : "",
        primaryGenre && supportGenre
            ? `SUPPORTING GENRE: ${getGenrePromptLabel(supportGenre)}`
            : "",
        primaryGenre && supportGenre
            ? `SUPPORTING LENS: ${supportProfile.identity}`
            : "",
        primaryGenre && supportGenre
            ? `SUPPORTING TEXTURE: ${supportProfile.texture}`
            : "",
        primaryGenre && supportGenre
            ? `SUPPORTING BOUNDARY: ${supportProfile.guard}`
            : "",
        primaryGenre && supportGenre
            ? "GENRE ROLES: Primary governs scene meaning. Support adds only secondary pressure or texture through a natural opening and may remain dormant."
            : "",
        primaryGenre
            ? "GENRE PRINCIPLE: Let genre shape choices, relationships, pacing, atmosphere, and detail. Allow events to emerge naturally; never force one to prove a label."
            : "",
        characterBoostActive ? "CHARACTER — {{char}}:" : "",
        characterBoostActive && characterBoostAnchor
            ? `<character_boost_anchor>\n${characterBoostAnchor}\n</character_boost_anchor>`
            : "",
        characterBoostActive && characterBoostAnchor
            ? "ANCHOR ROLE: Character-specific priority reminder subordinate to the full card and established roleplay; never quote or explain it."
            : "",
        characterBoostActive ? "CHARACTER PRINCIPLES:" : "",
        characterBoostActive
            ? "- IDENTITY: Preserve established personality, values, voice, boundaries, capabilities, and decision logic; allow justified change or restraint."
            : "",
        characterBoostActive
            ? "- AGENCY: Act from established motives and make character-specific choices; do not defer {{char}}'s own decisions back to {{user}}."
            : "",
        characterBoostActive
            ? "- RELATIONSHIP: Respond through shared history, trust, tension, boundaries, power, and changing distance—not a generic trope."
            : "",
        characterBoostActive
            ? "- CONTINUITY & VARIETY: Carry forward immediate actions, emotions, facts, and consequences; do not echo {{user}} or mechanically reuse recent expression."
            : "",
        correctionCodes.length
            ? "DRIFT GUARD: Apply every diagnosis-based correction listed below, up to the selected maximum of two. Do not skip one because another seems larger, and do not introduce unrelated corrections. Do not output the check."
            : "DRIFT GUARD: Before finalizing, silently correct only the single largest drift from the enabled guidance or scene continuity. Do not output the check.",
        correctionCodes.length
            ? "DIAGNOSIS-BASED DRIFT CORRECTION FOR THIS RESPONSE:"
            : "",
        correctionCodes.length
            ? "Treat the following corrections as priority requirements for this response, not optional suggestions. Make each correction clearly perceptible while continuing the current scene organically."
            : "",
        ...correctionLines,
        correctionCodes.length && hasTargetedCharacterCorrection
            ? "TARGETED CHARACTER CORRECTION FOR THIS RESPONSE:"
            : "",
        correctionCodes.length && hasTargetedCharacterCorrection
            ? correctionText
            : "",
        correctionCodes.length && correctionCharacterBaseline && !hasTargetedCharacterCorrection
            ? "RELEVANT CHARACTER BASELINE FOR THIS RESPONSE:"
            : "",
        correctionCodes.length && correctionCharacterBaseline && !hasTargetedCharacterCorrection
            ? `<character_baseline_reference>\n${correctionCharacterBaseline}\n</character_baseline_reference>`
            : "",
        correctionCodes.length && correctionCharacterBaseline && !hasTargetedCharacterCorrection
            ? "Use this reference only to restore the diagnosed drift in the current scene. Do not quote, explain, or mechanically reproduce it."
            : "",
    ]
        .filter(Boolean)
        .join("\n");
}

// @source-order 200
function updateGenrePrompt() {
    const s = ensureChatState();
    const selection = getBoosterSelection(s);

    if (!selection) {
        setExtensionPrompt(GENRE_PROMPT_KEY, "", extension_prompt_types.IN_CHAT, 1);
        runtime.currentStoryInjectionText = "";
        console.log(`[${MODULE_NAME}] story prompt cleared (no active booster)`);
        return;
    }

    const text = buildGenrePromptText(selection);
    if (!text) {
        setExtensionPrompt(GENRE_PROMPT_KEY, "", extension_prompt_types.IN_CHAT, 1);
        runtime.currentStoryInjectionText = "";
        console.log(`[${MODULE_NAME}] story prompt cleared (no active prompt content)`);
        return;
    }
    setExtensionPrompt(
        GENRE_PROMPT_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        1, // persistent genre anchor sits just behind one-shot depth-0 plot injections
        false, // scan
        extension_prompt_roles.SYSTEM
    );
    runtime.currentStoryInjectionText = text;
    console.debug(`[${MODULE_NAME}] story prompt set (${text.length} chars)`);
}

// @source-order 201
function safelyUpdateGenrePrompt(contextLabel = "UI 갱신") {
    try {
        updateGenrePrompt();
        return true;
    } catch (error) {
        console.error(
            `[${MODULE_NAME}] story prompt refresh failed (${contextLabel}):`,
            error
        );
        recordStoryBoosterError(error, {
            task: "injection_prompt_refresh",
            stage: "prompt_injection",
        });
        return false;
    }
}

// @source-order 204
function getAutomaticAuditScope(selection) {
    if (!selection) return null;
    if (selection.autoPlotEnabled) return 'combined';
    const genreEnabled = Boolean(selection.primaryGenre);
    const characterEnabled = Boolean(selection.characterEnabled);
    if (genreEnabled && characterEnabled) return "combined";
    if (genreEnabled) return "genre";
    if (characterEnabled) return "character";
    return null;
}

// @source-order 205
function getScopedAuditSelection(selection, scope = "combined") {
    if (!selection) return null;
    if (scope === "genre") {
        if (!selection.primaryGenre) return null;
        return {
            ...selection,
            autoPlotEnabled: false,
            characterEnabled: false,
            characterBoostActive: false,
            characterBaseline: "",
            characterBoostAnchor: "",
        };
    }
    if (scope === "character") {
        if (!selection.characterEnabled) return null;
        return {
            ...selection,
            autoPlotEnabled: false,
            primaryGenre: null,
            supportGenre: null,
        };
    }
    return selection;
}

// @source-order 206
function getAuditOutputInstructions(selection) {
    const genreEnabled = Boolean(selection.primaryGenre);
    const characterEnabled = Boolean(selection.characterEnabled);
    const genreShape =
        '{"primary_genre":"weak","primary_genre_evidence":[],"primary_genre_failure_evidence":[],"primary_genre_reason":"","genre_expression":"weak","genre_expression_evidence":[],"genre_expression_failure_evidence":[],"genre_expression_reason":"","support_texture":"dormant","support_texture_evidence":[],"support_texture_opportunity":[],"support_texture_identifiable":false,"support_texture_reason":"","scene_density":"weak","scene_density_evidence":[],"scene_density_failure_evidence":[],"scene_density_reason":""}';
    const characterShape =
        '{"character_consistency":"unavailable","character_consistency_positive_evidence":[],"character_consistency_evidence":[],"character_consistency_severe":false,"character_consistency_reason":"","character_interpretation":"unavailable","character_interpretation_positive_evidence":[],"character_interpretation_evidence":[],"character_interpretation_reason":"","character_correction":"","character_focus_fields":[],"char_agency":"weak","char_agency_evidence":[],"char_agency_failure_evidence":[],"char_agency_reason":"","relationship":"weak","relationship_evidence":[],"relationship_failure_evidence":[],"relationship_reason":"","continuity":"weak","continuity_evidence":[],"continuity_failure_evidence":[],"continuity_severe":false,"continuity_reason":"","repetition":"stable","repetition_evidence":[],"repetition_exact":false,"repetition_reason":""}';
    if (genreEnabled && !characterEnabled) {
        return [
            `Return JSON only with these exact keys: ${genreShape}.`,
            "Allowed values: primary_genre, genre_expression, and scene_density = present, attention, weak, or na; support_texture = present, attention, dormant, weak, or na; support_texture_identifiable must be true or false.",
            "Do not omit any key. Use support_texture=na and empty support arrays when there is no supporting genre.",
        ];
    }
    if (!genreEnabled && characterEnabled) {
        return [
            `Return JSON only with these exact keys: ${characterShape}.`,
            "Allowed values: character_consistency = stable, attention, drifted, or unavailable; character_interpretation = stable, attention, biased, or unavailable; char_agency, relationship, and continuity = present, attention, weak, or na; repetition = stable, attention, weak, or na; boolean fields must be true or false.",
            "Do not omit any key.",
        ];
    }
    return [
        `Return JSON only with every exact key in the following two shapes merged into one flat object. Do not include GENRE or CHARACTER as keys. GENRE KEYS: ${genreShape} CHARACTER KEYS: ${characterShape}.`,
        "Allowed values: primary_genre, genre_expression, and scene_density = present, attention, weak, or na; support_texture = present, attention, dormant, weak, or na; character_consistency = stable, attention, drifted, unavailable, or na; character_interpretation = stable, attention, biased, unavailable, or na; char_agency, relationship, and continuity = present, attention, weak, or na; repetition = stable, attention, weak, or na; boolean fields must be true or false.",
        "Do not omit any key. Return na for a disabled module. Use support_texture=na and empty support arrays when there is no supporting genre.",
    ];
}

// @source-order 207
function buildGenreAuditPrompt(
    selection,
    scope = "combined",
    outputLanguage = ensureModuleSettings().outputLanguage
) {
    const primaryEvidenceMinimum = Math.ceil(
        GENRE_AUDIT_RESPONSE_LIMIT * PRIMARY_GENRE_EVIDENCE_RATIO
    );
    const primaryFoundation = selection.primaryGenre
        ? getGenreProfileAuditStandard(getGenreProfile(selection.primaryGenre))
        : "";
    const supportFoundation = selection.primaryGenre && selection.supportGenre
        ? getGenreProfileAuditStandard(
              getGenreProfile(selection.supportGenre)
          )
        : "";
    const characterBaseline = String(selection.characterBaseline || "").trim();
    const reasonMaxChars = getAuditReasonMaxChars(outputLanguage);
    const reasonLanguage = outputLanguage === "en"
        ? "Write every *_reason value in natural English."
        : "Write every *_reason value in natural Korean. Keep established proper nouns in their original form, but do not write the explanation in English.";
    return [
        `Analyze up to the ${GENRE_AUDIT_RESPONSE_LIMIT} most recent numbered {{char}} roleplay responses. Each USER_CONTEXT block clarifies its following CHAR_RESPONSE; use those paired user inputs to interpret the replies, but evaluate and cite only blocks labelled CHAR_RESPONSE_1 through CHAR_RESPONSE_${GENRE_AUDIT_RESPONSE_LIMIT}. Do not continue the roleplay and do not propose a plot event.`,
        selection.primaryGenre
            ? "GENRE AUDIT IS ENABLED."
            : scope === "character"
              ? "GENRE AUDIT IS NOT PART OF THIS REQUEST. Do not return genre fields."
              : "GENRE AUDIT IS DISABLED. Return na for all genre-only fields.",
        selection.primaryGenre
            ? `Primary genre: ${getGenrePromptLabel(selection.primaryGenre)}.`
            : "",
        selection.primaryGenre
            ? `Primary genre evidence standard: ${primaryFoundation}`
            : "",
        selection.primaryGenre && selection.supportGenre
            ? `Supporting genre used as a secondary lens for contextual pressure, relationship or world logic, atmosphere, and texture: ${getGenrePromptLabel(selection.supportGenre)}.`
            : selection.primaryGenre
              ? "There is no supporting genre."
              : "",
        selection.primaryGenre && selection.supportGenre
            ? `Supporting genre evidence standard: ${supportFoundation}`
            : "",
        selection.primaryGenre
            ? "This is a strict drift audit, not a genre-compatibility or recommendation task. A genre may suit the roleplay and still be weak when its distinctive traits are not actually visible in the supplied {{char}} responses."
            : "",
        selection.primaryGenre
            ? "Read each genre standard consistently: narrative identity defines what gives the scene meaning; recognizable expression names positive techniques; character and relationship consequence shows what the genre changes; atmosphere and material texture supports embodiment; the false-positive boundary names neighboring or generic evidence that must not be counted."
            : "",
        "Rate every requested dimension with one of its allowed states. Judge only what is actually visible in the supplied responses, even if settings changed after those responses were written. Stable or present is never the default: it requires distinct positive evidence across the reviewed window. Use attention only for a directly observed mild defect; list insufficient or unresolved evidence in deferred_dimensions instead. Use weak, drifted, or biased only for a repeated or severe visible failure. Score the observed window first; do not soften a rating because the problem could be corrected later.",
        selection.primaryGenre
            ? `primary_genre evaluates narrative identity: whether the selected primary genre governs motives, relationship stakes, choices, causal development, scene emphasis, or emotional logic. Use present only when at least ${primaryEvidenceMinimum} distinct numbered {{char}} responses contain clear genre-specific evidence. Use attention for a concrete localized mismatch with the selected genre; insufficient positive evidence alone belongs in deferred_dimensions. Use weak when at least three responses remain governed by generic or contradictory logic despite a clear genre-relevant opening. Generic emotion, conflict, danger, action, atmosphere, or competent prose is not enough.`
            : "",
        selection.primaryGenre
            ? "Before rating primary_genre as present, apply both boundary checks: if the same responses could still be described accurately without the selected genre, or if the evidence matches its false-positive boundary more closely than its positive standard, it cannot be present. Use attention only if a concrete mild mismatch is visible; otherwise defer, unless clear independent evidence decides the dimension."
            : "",
        selection.primaryGenre
            ? "The supporting genre is a conditional secondary lens, not a second primary genre. It may shape existing pressure, relationship context, social or world logic, atmosphere, prose rhythm, or sensory texture when the current scene offers a natural opening. It must not seize the scene direction or require a new event merely to prove itself."
            : "",
        selection.primaryGenre
            ? "Use support_texture=present only when at least two distinct numbered {{char}} responses contain genre-specific influence that would let a reader identify the supporting genre without seeing its label. Use support_texture=dormant when the supporting lens has no clear evidence and the current scene offers no natural, already-established opening for it. Use support_texture=weak only when an established or naturally relevant supporting-genre element had a clear opening in one or more numbered {{char}} responses but {{char}} flattened, ignored, or contradicted it."
            : "",
        selection.primaryGenre
            ? "Before rating support_texture as present, apply both boundary checks: if the cited influence could belong equally to many unrelated genres, or if it matches the supporting genre's false-positive boundary, it is not identifiable and cannot be present. A generic mood, an isolated word or object, ordinary contemporary technology, broad danger, secrecy, conflict, compatibility, or future potential is not sufficient evidence."
            : "",
        selection.primaryGenre
            ? "For world or setting lenses such as fantasy, supernatural, urban fantasy, science fiction, cyberpunk, or historical fiction, require explicit setting-specific phenomena, rules, entities, institutions, material conditions, or consequences. Metaphor, coincidence, unease, an ordinary city, or commonplace technology does not count."
            : "",
        selection.primaryGenre
            ? "Do not infer genre evidence from the selected labels themselves. Do not reward an intentionally changed or unrelated genre unless the supplied responses independently demonstrate it."
            : "",
        selection.primaryGenre
            ? `Return at most ${AUDIT_EVIDENCE_MAX_ITEMS} strongest primary_genre_evidence, genre_expression_evidence, support_texture_evidence, and scene_density_evidence items as numbered CHAR_RESPONSE values that contain distinctive positive evidence. Return primary_genre_failure_evidence, genre_expression_failure_evidence, and scene_density_failure_evidence as the strongest numbered responses that visibly contradict, miss, or flatten that dimension despite a relevant opening. Use the integer only: for CHAR_RESPONSE_3 return 3. Do not include a response merely because it is compatible with the genre or competently written. Repeated uses of the same cue count as separate responses but do not demonstrate expressive breadth by themselves.`
            : "",
        selection.primaryGenre
            ? `Return at most ${AUDIT_EVIDENCE_MAX_ITEMS} support_texture_opportunity items as the numbered CHAR_RESPONSE values where an already-established or naturally relevant supporting-genre element had a clear opening but was ignored, flattened, or contradicted. Return support_texture_identifiable=true only when the evidence would identify the supporting genre without its label.`
            : "",
        selection.primaryGenre
            ? "genre_expression evaluates execution, not narrative identity: whether scene causality, description, dialogue and action emphasis, relationship pressure, stakes, event progression, pacing, atmosphere, and consequences visibly use the selected genre's recognizable expression. Use present only when at least four distinct numbered responses use recognizable genre-specific techniques across at least two expressive channels such as action or dialogue emphasis, description or atmosphere, pacing, relationship pressure, or consequence. Use attention for a concrete mild execution failure; partial observation without a visible failure is deferred. Use weak when generic or boundary-violating execution is repeated across at least three relevant responses. Labels, keywords, generic mood, isolated tropes, or mere plot compatibility do not count."
            : "",
        selection.primaryGenre
            ? "scene_density evaluates whether the scene is concretely dramatized rather than flat, static, decorative, or summary-like. Purposeful action, dialogue, spatial awareness, sensory or material detail, behavioral cues, subtext, and immediate consequences must shape attention, pressure, choice, or emotional meaning. Use present only when at least four distinct numbered responses each connect at least two functional layers, such as action plus space, sensation plus emotional meaning, or dialogue plus immediate consequence. Use attention for a concrete localized loss of functional scene detail; missing observations alone are deferred. Use weak when summary, static exchange, or decorative detail dominates at least three relevant responses. Length, adjectives, or sensory lists alone are not density."
            : "",
        selection.characterEnabled
            ? "CHARACTER AUDIT IS ENABLED."
            : scope === "genre"
              ? "CHARACTER AUDIT IS NOT PART OF THIS REQUEST. Do not return character fields."
              : "CHARACTER AUDIT IS DISABLED. Return na for character-only fields and na for repetition.",
        selection.characterEnabled && characterBaseline
            ? `COMPACT CHARACTER BASELINE (user-reviewable cached extraction):\n${characterBaseline}`
            : selection.characterEnabled
              ? "No compact character baseline is available. Return unavailable for character_consistency and character_interpretation; still evaluate agency, relationship, continuity, and repetition from the transcript."
              : "",
        selection.characterEnabled && characterBaseline
            ? "Use the compact baseline as the character-specific reference across the entire character audit, not only for consistency. Judge how the visible roleplay realizes this particular character's traits, motives, decision style, speech, emotional expression, values, boundaries, and relationship responses. The baseline describes possible patterns, not a checklist that must appear in every response."
            : "",
        selection.characterEnabled
            ? "Keep the six dimensions independent: character_consistency detects contradiction with stored character logic; character_interpretation detects repeated flattening without requiring contradiction; char_agency detects self-directed choice; relationship detects relationship-specific response; continuity detects carried scene state; repetition detects mechanical reuse. Do not let strength or weakness in one dimension determine another."
            : "",
        selection.characterEnabled
            ? "character_consistency compares {{char}}'s visible speech, choices, values, boundaries, competence, decision logic, and relationship-specific attitude with the compact baseline. Return stable only when at least four distinct responses positively realize two different applicable baseline facets, or the sole applicable facet when all other facets have no opportunity; cite them in character_consistency_positive_evidence. Quiet traits need not appear in every response. Return attention for one clearly observed mild contradiction; insufficient or ambiguous positive realization alone is deferred. Return drifted only for two distinct contradictions, or one unmistakably severe contradiction, cited in character_consistency_evidence. Plausible development, regression, deception, disguise, or context-dependent conduct counts only when the transcript itself supports it."
            : "",
        selection.characterEnabled
            ? "character_interpretation detects whether the baseline is being realized as a specific, context-responsive person rather than flattened into a repeated one-sided or generic reading. Return stable only when at least three distinct responses positively show two applicable facets, tension, or context-dependent variation; if only one facet has any opportunity, sufficiently repeated scene-specific positive realization of that one facet is enough; cite them in character_interpretation_positive_evidence. Return attention for one concrete instance of flattening; an untested facet or an ambiguous reading alone is deferred. Return biased when the same flattening appears in at least two responses: overusing one trait, forcing an unjustified positive or negative direction, replacing character-specific behavior with a stock trope, or responding nearly identically across contexts. Do not invent complexity unsupported by the baseline."
            : "",
        selection.characterEnabled
            ? "char_agency evaluates whether {{char}} acts from character-specific motives through their established decision style and meaningfully affects the exchange by choosing, initiating, refusing, withholding, redirecting, negotiating, or acting. Use present only when at least four distinct numbered responses show visible intent plus a consequential choice or initiative. Use attention for one observable missed character-owned choice; two or three qualifying positives alone do not prove a defect and may warrant deferral. Use weak when at least two responses show {{char}} repeatedly waiting for {{user}}, merely mirroring input, deferring a choice that belongs to {{char}} back to {{user}}, avoiding an available character-relevant choice, or moving only because narration pushes them. Do not confuse activity, aggression, verbosity, or a newly invented event with agency, and do not penalize leaving {{user}}'s own actions, consent, dialogue, or decisions open."
            : "",
        selection.characterEnabled
            ? "relationship evaluates whether {{char}} responds through the specific established relationship: shared history, trust, tension, boundaries, power, attachment, distance, unresolved feelings, and prior relational consequences. Use present only when at least three distinct numbered responses contain concrete relationship-specific reactions rather than generic attention, affection, hostility, jealousy, possession, or protection. Use attention for one concrete missed relationship-specific reaction; a quiet interaction or too few positives alone does not prove a defect. Use weak when at least two available relationship contexts are ignored, reset, contradicted, or flattened into a generic trope. Constant progression is not required. Use relationship=na only when the reviewed window genuinely contains no meaningful relationship interaction or opening."
            : "",
        selection.characterEnabled
            ? "continuity primarily evaluates the transcript itself: whether unresolved actions, dialogue, emotional beats, location, timing, knowledge, physical state, and immediate consequences are preserved and carried forward. Use present only when at least four distinct numbered responses visibly continue relevant prior state without contradiction or unexplained reset. Use attention for one clear minor lapse; too few applicable carryovers alone are deferred. Use weak when at least two responses abandon or contradict linkable state, or when continuity_severe=true marks one unmistakable reset that materially breaks the scene. Use continuity=na only when the window genuinely contains no linkable prior state."
            : "",
        selection.characterEnabled
            ? "Rate repetition=weak when at least three numbered responses mechanically reuse the same dominant gesture, image, sentence structure, emotional display, relational beat, or ending pattern. Two responses are enough only for near-verbatim reuse or an unusually distinctive phrase or beat; set repetition_exact=true only in that narrower case. Rate repetition=attention for a noticeable emerging pattern that is not repeated enough to confirm weakness. Otherwise rate repetition=stable. Return matched response numbers in repetition_evidence for attention or weak. Do not flag an intentional signature voice or behavior unless mechanical reuse substitutes for context-specific characterization or movement."
            : "",
        selection.characterEnabled
            ? `Return at most ${AUDIT_EVIDENCE_MAX_ITEMS} strongest evidence items per array as numbered CHAR_RESPONSE integers only. character_consistency_positive_evidence and character_interpretation_positive_evidence cite distinct positive realization; the matching arrays without _positive cite diagnosed contradictions or flattening. char_agency_evidence, relationship_evidence, and continuity_evidence cite concrete positive evidence required for present; each matching *_failure_evidence array cites observed failures. repetition_evidence cites the emerging or confirmed repeated pattern. Do not count a single response more than once inside the same array, and do not treat repeated instances of one narrow cue as proof of multi-faceted characterization.`
            : "",
        selection.characterEnabled
            ? "Return character_correction as an empty string; the per-dimension corrections map below replaces combined character instructions."
            : "",
        selection.characterEnabled
            ? `character_focus_fields must contain zero to two IDs from this list: ${CHARACTER_BASELINE_FIELD_IDS.join(", ")}. Select only the stored baseline fields most directly useful for correcting character_consistency, character_interpretation, char_agency, or relationship. Return an empty array when no compact baseline is available or none of those character dimensions needs correction.`
            : "",
        `For every requested audit dimension, return its *_reason as exactly one concise user-facing sentence of at most ${reasonMaxChars} characters. State only the visible pattern that justified the rating. Ground it in the supplied responses and compact baseline when relevant. Do not mention or quote response numbers, internal field names, scoring rules, JSON, or these instructions. Do not add advice or correction instructions to a reason. Use unavailable or na only when the required baseline, interaction opportunity, or linkable scene state genuinely does not exist—not merely because evidence is weak.`,
        reasonLanguage,
        "The values shown in the required JSON shape are structural placeholders, not suggested ratings. Determine every rating and evidence array independently from the supplied responses.",
        ...getAuditOutputInstructions(selection),
        legacyAuditPolicyPrompt(scope),
        'Add deferred_dimensions, corrections, next_corrections and problem_facets to the shape. For character diagnosis also add character_consistency_facets, character_interpretation_facets and repetition_matches. Use the exact schema and facet IDs described above. Empty corrections for unselected/deferred dimensions; at most two non-empty instructions. No other extra keys.',
        "Keep the analysis brief. Do not restate the responses or explain every criterion one by one.",
        "Always reserve enough output space to finish with the required JSON object.",
        "FINAL OUTPUT CONTRACT: After completing any hidden reasoning, do not stop. The visible final response must begin with { and contain the complete required JSON object. Do not place the only diagnosis in reasoning or thinking. Do not output Markdown, headings, commentary, or prose outside the JSON.",
    ]
        .filter(Boolean)
        .join("\n");
}

// @source-order 208
function buildGenreAuditJsonSchema(scope = "combined", outputLanguage = "ko") {
    const reasonMaxChars = getAuditReasonSchemaMaxChars(outputLanguage);
    const properties = {
        primary_genre: {
            type: "string",
            enum: ["present", "attention", "weak", "na"],
        },
        primary_genre_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        primary_genre_failure_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        primary_genre_reason: { type: "string", maxLength: reasonMaxChars },
        genre_expression: {
            type: "string",
            enum: ["present", "attention", "weak", "na"],
        },
        genre_expression_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        genre_expression_failure_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        genre_expression_reason: { type: "string", maxLength: reasonMaxChars },
        support_texture: {
            type: "string",
            enum: ["present", "attention", "dormant", "weak", "na"],
        },
        support_texture_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        support_texture_opportunity: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        support_texture_identifiable: { type: "boolean" },
        support_texture_reason: { type: "string", maxLength: reasonMaxChars },
        scene_density: {
            type: "string",
            enum: ["present", "attention", "weak", "na"],
        },
        scene_density_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        scene_density_failure_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        scene_density_reason: { type: "string", maxLength: reasonMaxChars },
        character_consistency: {
            type: "string",
            enum: ["stable", "attention", "drifted", "unavailable", "na"],
        },
        character_consistency_positive_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        character_consistency_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        character_consistency_severe: { type: "boolean" },
        character_consistency_reason: { type: "string", maxLength: reasonMaxChars },
        character_interpretation: {
            type: "string",
            enum: ["stable", "attention", "biased", "unavailable", "na"],
        },
        character_interpretation_positive_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        character_interpretation_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        character_interpretation_reason: { type: "string", maxLength: reasonMaxChars },
        character_correction: {
            type: "string",
            maxLength: CHARACTER_CORRECTION_MAX_CHARS,
        },
        character_focus_fields: {
            type: "array",
            maxItems: 2,
            items: { type: "string", enum: CHARACTER_BASELINE_FIELD_IDS },
        },
        char_agency: {
            type: "string",
            enum: ["present", "attention", "weak", "na"],
        },
        char_agency_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        char_agency_failure_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        char_agency_reason: { type: "string", maxLength: reasonMaxChars },
        relationship: {
            type: "string",
            enum: ["present", "attention", "weak", "na"],
        },
        relationship_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        relationship_failure_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        relationship_reason: { type: "string", maxLength: reasonMaxChars },
        continuity: {
            type: "string",
            enum: ["present", "attention", "weak", "na"],
        },
        continuity_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        continuity_failure_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        continuity_severe: { type: "boolean" },
        continuity_reason: { type: "string", maxLength: reasonMaxChars },
        repetition: {
            type: "string",
            enum: ["stable", "attention", "weak", "na"],
        },
        repetition_evidence: {
            type: "array",
            maxItems: AUDIT_EVIDENCE_MAX_ITEMS,
            items: { type: "integer" },
        },
        repetition_exact: { type: "boolean" },
        repetition_reason: { type: "string", maxLength: reasonMaxChars },
    };
    const genreKeys = [
        "primary_genre",
        "primary_genre_evidence",
        "primary_genre_failure_evidence",
        "primary_genre_reason",
        "genre_expression",
        "genre_expression_evidence",
        "genre_expression_failure_evidence",
        "genre_expression_reason",
        "support_texture",
        "support_texture_evidence",
        "support_texture_opportunity",
        "support_texture_identifiable",
        "support_texture_reason",
        "scene_density",
        "scene_density_evidence",
        "scene_density_failure_evidence",
        "scene_density_reason",
    ];
    const characterKeys = [
        "character_consistency",
        "character_consistency_positive_evidence",
        "character_consistency_evidence",
        "character_consistency_severe",
        "character_consistency_reason",
        "character_interpretation",
        "character_interpretation_positive_evidence",
        "character_interpretation_evidence",
        "character_interpretation_reason",
        "character_correction",
        "character_focus_fields",
        "char_agency",
        "char_agency_evidence",
        "char_agency_failure_evidence",
        "char_agency_reason",
        "relationship",
        "relationship_evidence",
        "relationship_failure_evidence",
        "relationship_reason",
        "continuity",
        "continuity_evidence",
        "continuity_failure_evidence",
        "continuity_severe",
        "continuity_reason",
        "repetition",
        "repetition_evidence",
        "repetition_exact",
        "repetition_reason",
    ];
    const required =
        scope === "genre"
            ? genreKeys
            : scope === "character"
              ? characterKeys
              : [...genreKeys, ...characterKeys];
    return addLegacyAuditPolicySchema({
        name: `storybooster_${scope}_audit`,
        strict: true,
        schema: {
            type: "object",
            properties: Object.fromEntries(
                required.map((key) => [key, properties[key]])
            ),
            required,
            additionalProperties: false,
        },
    });
}

// @source-order 209
function parseGenreAuditResult(
    rawResult,
    hasSupportGenre,
    assistantResponseCount = GENRE_AUDIT_RESPONSE_LIMIT,
    scope = "combined",
    outputLanguage = "ko",
    applyLegacyPolicy = true,
    allowCorrectionFallback = false
) {
    const extracted = extractJsonObject(
        rawResult,
        "Genre audit returned no JSON object."
    );
    const genreDefaults = {
        primary_genre: "na",
        primary_genre_evidence: [],
        primary_genre_failure_evidence: [],
        primary_genre_reason: "",
        genre_expression: "na",
        genre_expression_evidence: [],
        genre_expression_failure_evidence: [],
        genre_expression_reason: "",
        support_texture: "na",
        support_texture_evidence: [],
        support_texture_opportunity: [],
        support_texture_identifiable: false,
        support_texture_reason: "",
        scene_density: "na",
        scene_density_evidence: [],
        scene_density_failure_evidence: [],
        scene_density_reason: "",
    };
    const characterDefaults = {
        character_consistency: "na",
        character_consistency_positive_evidence: [],
        character_consistency_evidence: [],
        character_consistency_severe: false,
        character_consistency_reason: "",
        character_interpretation: "na",
        character_interpretation_positive_evidence: [],
        character_interpretation_evidence: [],
        character_interpretation_reason: "",
        character_correction: "",
        character_focus_fields: [],
        char_agency: "na",
        char_agency_evidence: [],
        char_agency_failure_evidence: [],
        char_agency_reason: "",
        relationship: "na",
        relationship_evidence: [],
        relationship_failure_evidence: [],
        relationship_reason: "",
        continuity: "na",
        continuity_evidence: [],
        continuity_failure_evidence: [],
        continuity_severe: false,
        continuity_reason: "",
        repetition: "na",
        repetition_evidence: [],
        repetition_exact: false,
        repetition_reason: "",
    };
    const parsed =
        scope === "genre"
            ? { ...characterDefaults, ...extracted }
            : scope === "character"
              ? { ...genreDefaults, ...extracted }
              : extracted;
    const correctionPriority =
        scope === "genre"
            ? [
                  "primary_genre",
                  "genre_expression",
                  "support_texture",
                  "scene_density",
              ]
            : scope === "character"
              ? [
                    "character_consistency",
                    "char_agency",
                    "relationship",
                    "continuity",
                    "character_interpretation",
                    "repetition",
                ]
              : [
                    "character_consistency",
                    "primary_genre",
                    "genre_expression",
                    "char_agency",
                    "relationship",
                    "continuity",
                    "support_texture",
                    "scene_density",
                    "character_interpretation",
                    "repetition",
                ];
    const valid =
        ["present", "attention", "weak", "na"].includes(parsed.primary_genre) &&
        ["present", "attention", "weak", "na"].includes(parsed.genre_expression) &&
        ["present", "attention", "dormant", "weak", "na"].includes(parsed.support_texture) &&
        ["present", "attention", "weak", "na"].includes(parsed.scene_density) &&
        ["stable", "attention", "drifted", "unavailable", "na"].includes(parsed.character_consistency) &&
        ["stable", "attention", "biased", "unavailable", "na"].includes(parsed.character_interpretation) &&
        ["present", "attention", "weak", "na"].includes(parsed.char_agency) &&
        ["present", "attention", "weak", "na"].includes(parsed.relationship) &&
        ["present", "attention", "weak", "na"].includes(parsed.continuity) &&
        ["stable", "attention", "weak", "na"].includes(parsed.repetition) &&
        typeof parsed.support_texture_identifiable === "boolean" &&
        typeof parsed.character_consistency_severe === "boolean" &&
        typeof parsed.continuity_severe === "boolean" &&
        typeof parsed.repetition_exact === "boolean" &&
        typeof parsed.character_correction === "string" &&
        Array.isArray(parsed.character_focus_fields) &&
        [
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
        ].every((key) => typeof parsed[key] === "string") &&
        [
            "primary_genre_evidence",
            "primary_genre_failure_evidence",
            "genre_expression_evidence",
            "genre_expression_failure_evidence",
            "support_texture_evidence",
            "support_texture_opportunity",
            "scene_density_evidence",
            "scene_density_failure_evidence",
            "character_consistency_evidence",
            "character_consistency_positive_evidence",
            "character_interpretation_evidence",
            "character_interpretation_positive_evidence",
            "char_agency_evidence",
            "char_agency_failure_evidence",
            "relationship_evidence",
            "relationship_failure_evidence",
            "continuity_evidence",
            "continuity_failure_evidence",
            "repetition_evidence",
        ].every((key) => Array.isArray(parsed[key]));
    if (!valid) {
        const expectedKeys =
            scope === "genre"
                ? Object.keys(genreDefaults)
                : scope === "character"
                  ? Object.keys(characterDefaults)
                  : [
                        ...Object.keys(genreDefaults),
                        ...Object.keys(characterDefaults),
                    ];
        const missingFields = expectedKeys.filter(
            (key) => !Object.hasOwn(extracted, key)
        );
        const error = new Error(
            missingFields.length
                ? `진단 결과에서 필수 항목이 누락되었습니다: ${missingFields.join(", ")}`
                : "진단 결과의 상태값 또는 자료 형식이 올바르지 않습니다."
        );
        error.code = "STORYBOOSTER_INCOMPLETE_RATINGS";
        error.missingFields = missingFields;
        throw error;
    }

    const reviewedResponses = Math.max(
        0,
        Math.min(
            GENRE_AUDIT_RESPONSE_LIMIT,
            Number.isSafeInteger(assistantResponseCount)
                ? assistantResponseCount
                : GENRE_AUDIT_RESPONSE_LIMIT
        )
    );
    const normalizeEvidence = (values) =>
        [
            ...new Set(
                (Array.isArray(values) ? values : [])
                    .map((value) => Number(value))
                    .filter(
                        (value) =>
                            Number.isSafeInteger(value) &&
                            value >= 1 &&
                            value <= reviewedResponses
                    )
            ),
        ]
            .sort((a, b) => a - b)
            .slice(0, AUDIT_EVIDENCE_MAX_ITEMS);
    const evidence = {
        primary: normalizeEvidence(parsed.primary_genre_evidence),
        primaryFailure: normalizeEvidence(
            parsed.primary_genre_failure_evidence
        ),
        genreExpression: normalizeEvidence(parsed.genre_expression_evidence),
        genreExpressionFailure: normalizeEvidence(
            parsed.genre_expression_failure_evidence
        ),
        support: hasSupportGenre
            ? normalizeEvidence(parsed.support_texture_evidence)
            : [],
        supportOpportunity: hasSupportGenre
            ? normalizeEvidence(parsed.support_texture_opportunity)
            : [],
        supportIdentifiable:
            hasSupportGenre && parsed.support_texture_identifiable === true,
        sceneDensity: normalizeEvidence(parsed.scene_density_evidence),
        sceneDensityFailure: normalizeEvidence(
            parsed.scene_density_failure_evidence
        ),
        characterConsistencyPositive: normalizeEvidence(
            parsed.character_consistency_positive_evidence
        ),
        characterConsistency: normalizeEvidence(
            parsed.character_consistency_evidence
        ),
        characterInterpretationPositive: normalizeEvidence(
            parsed.character_interpretation_positive_evidence
        ),
        characterInterpretation: normalizeEvidence(
            parsed.character_interpretation_evidence
        ),
        characterAgency: normalizeEvidence(parsed.char_agency_evidence),
        characterAgencyFailure: normalizeEvidence(
            parsed.char_agency_failure_evidence
        ),
        relationship: normalizeEvidence(parsed.relationship_evidence),
        relationshipFailure: normalizeEvidence(
            parsed.relationship_failure_evidence
        ),
        continuity: normalizeEvidence(parsed.continuity_evidence),
        continuityFailure: normalizeEvidence(
            parsed.continuity_failure_evidence
        ),
        repetition: normalizeEvidence(parsed.repetition_evidence),
        reviewedResponses,
    };
    const primaryEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(
                  reviewedResponses,
                  Math.max(
                      1,
                      Math.ceil(
                          reviewedResponses * PRIMARY_GENRE_EVIDENCE_RATIO
                      )
                  )
              )
            : 1;
    const supportEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, SUPPORT_GENRE_EVIDENCE_MINIMUM)
            : 1;
    const genreExpressionEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, GENRE_EXPRESSION_EVIDENCE_MINIMUM)
            : 1;
    const sceneDensityEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, SCENE_DENSITY_EVIDENCE_MINIMUM)
            : 1;
    const characterConsistencyPositiveEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(
                  reviewedResponses,
                  CHARACTER_CONSISTENCY_POSITIVE_EVIDENCE_MINIMUM
              )
            : 1;
    const characterInterpretationPositiveEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(
                  reviewedResponses,
                  CHARACTER_INTERPRETATION_POSITIVE_EVIDENCE_MINIMUM
              )
            : 1;
    const characterAgencyEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, CHARACTER_AGENCY_EVIDENCE_MINIMUM)
            : 1;
    const characterRelationshipEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, CHARACTER_RELATIONSHIP_EVIDENCE_MINIMUM)
            : 1;
    const characterContinuityEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, CHARACTER_CONTINUITY_EVIDENCE_MINIMUM)
            : 1;
    const genreFailureEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, GENRE_FAILURE_EVIDENCE_MINIMUM)
            : 1;
    const characterFailureEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, CHARACTER_FAILURE_EVIDENCE_MINIMUM)
            : 1;
    const relationshipFailureEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, RELATIONSHIP_FAILURE_EVIDENCE_MINIMUM)
            : 1;
    const continuityFailureEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(reviewedResponses, CONTINUITY_FAILURE_EVIDENCE_MINIMUM)
            : 1;
    const repetitionEvidenceMinimum =
        reviewedResponses > 0
            ? Math.min(
                  reviewedResponses,
                  parsed.repetition_exact
                      ? REPETITION_EXACT_EVIDENCE_MINIMUM
                      : REPETITION_GENERAL_EVIDENCE_MINIMUM
              )
            : 1;
    const interpretationFailureEvidenceMinimum = Math.min(
        Math.max(1, reviewedResponses),
        CHARACTER_INTERPRETATION_FAILURE_EVIDENCE_MINIMUM
    );
    const consistencyDrifted =
        parsed.character_consistency === "drifted" &&
        (evidence.characterConsistency.length >= 2 ||
            (parsed.character_consistency_severe &&
                evidence.characterConsistency.length >= 1));
    const interpretationBiased =
        parsed.character_interpretation === "biased" &&
        evidence.characterInterpretation.length >=
            interpretationFailureEvidenceMinimum;
    const ratings = {
        primary_genre:
            parsed.primary_genre === "na"
                ? "na"
                : evidence.primaryFailure.length >= genreFailureEvidenceMinimum
                  ? "weak"
                  : parsed.primary_genre === "present" &&
                      evidence.primary.length >= primaryEvidenceMinimum &&
                      evidence.primaryFailure.length < 2
                    ? "present"
                    : "attention",
        genre_expression:
            parsed.genre_expression === "na"
                ? "na"
                : evidence.genreExpressionFailure.length >=
                    genreFailureEvidenceMinimum
                  ? "weak"
                  : parsed.genre_expression === "present" &&
                      evidence.genreExpression.length >=
                          genreExpressionEvidenceMinimum &&
                      evidence.genreExpressionFailure.length < 2
                    ? "present"
                    : "attention",
        support_texture: hasSupportGenre
            ? parsed.support_texture === "present" &&
                evidence.supportIdentifiable &&
                evidence.support.length >= supportEvidenceMinimum
              ? "present"
              : parsed.support_texture === "weak" &&
                  evidence.supportOpportunity.length > 0
                ? "weak"
                : "dormant"
            : "na",
        scene_density:
            parsed.scene_density === "na"
                ? "na"
                : evidence.sceneDensityFailure.length >=
                    genreFailureEvidenceMinimum
                  ? "weak"
                  : parsed.scene_density === "present" &&
                      evidence.sceneDensity.length >= sceneDensityEvidenceMinimum &&
                      evidence.sceneDensityFailure.length < 2
                    ? "present"
                    : "attention",
        character_consistency:
            parsed.character_consistency === "unavailable" ||
            parsed.character_consistency === "na"
                ? parsed.character_consistency
                : consistencyDrifted
                  ? "drifted"
                  : parsed.character_consistency === "stable" &&
                      evidence.characterConsistencyPositive.length >=
                          characterConsistencyPositiveEvidenceMinimum &&
                      evidence.characterConsistency.length < 2
                    ? "stable"
                    : "attention",
        character_interpretation:
            parsed.character_interpretation === "unavailable" ||
            parsed.character_interpretation === "na"
                ? parsed.character_interpretation
                : interpretationBiased
                  ? "biased"
                  : parsed.character_interpretation === "stable" &&
                      evidence.characterInterpretationPositive.length >=
                          characterInterpretationPositiveEvidenceMinimum &&
                      evidence.characterInterpretation.length <
                          interpretationFailureEvidenceMinimum
                    ? "stable"
                    : "attention",
        char_agency:
            parsed.char_agency === "na"
                ? "na"
                : evidence.characterAgencyFailure.length >=
                    characterFailureEvidenceMinimum
                  ? "weak"
                  : parsed.char_agency === "present" &&
                      evidence.characterAgency.length >=
                          characterAgencyEvidenceMinimum &&
                      evidence.characterAgencyFailure.length <
                          characterFailureEvidenceMinimum
                    ? "present"
                    : "attention",
        relationship:
            parsed.relationship === "na"
                ? "na"
                : evidence.relationshipFailure.length >=
                    relationshipFailureEvidenceMinimum
                  ? "weak"
                  : parsed.relationship === "present" &&
                      evidence.relationship.length >=
                          characterRelationshipEvidenceMinimum &&
                      evidence.relationshipFailure.length <
                          relationshipFailureEvidenceMinimum
                    ? "present"
                    : "attention",
        continuity:
            parsed.continuity === "na"
                ? "na"
                : evidence.continuityFailure.length >=
                        continuityFailureEvidenceMinimum ||
                    (parsed.continuity_severe &&
                        evidence.continuityFailure.length >= 1)
                  ? "weak"
                  : parsed.continuity === "present" &&
                      evidence.continuity.length >=
                          characterContinuityEvidenceMinimum &&
                      evidence.continuityFailure.length <
                          continuityFailureEvidenceMinimum
                    ? "present"
                    : "attention",
        repetition:
            parsed.repetition === "na"
                ? "na"
                : parsed.repetition === "weak" &&
                    evidence.repetition.length >= repetitionEvidenceMinimum
                  ? "weak"
                  : parsed.repetition === "attention" ||
                      (parsed.repetition === "weak" &&
                          evidence.repetition.length > 0) ||
                      (parsed.repetition === "stable" &&
                          evidence.repetition.length > 0)
                    ? "attention"
                    : "stable",
    };
    const fallbackReasons = outputLanguage === "en"
        ? {
              primary_genre: "The primary genre's distinctive narrative logic was not consistently visible across the recent responses.",
              genre_expression: "Distinctive genre techniques were not used consistently enough in description, action, pacing, or consequences.",
              support_texture: "The supporting lens was not distinctly visible, or the current scene did not offer a natural opening for it.",
              scene_density: "Concrete spatial, sensory, material, or behavioral detail did not consistently shape the scene.",
              character_consistency: "The baseline was not clearly contradicted, but too few distinct responses realized enough of it to confirm stability.",
              character_interpretation: "No repeated flattening was confirmed, but the portrayal was too narrow or mixed to confirm a stable interpretation.",
              char_agency: "Character-specific intent and consequential choice were not consistently visible across the recent responses.",
              relationship: "Relationship-specific memory, boundaries, tension, or emotional movement were not consistently reflected.",
              continuity: "Prior actions, emotions, scene facts, or immediate consequences were not carried forward consistently.",
              repetition: "No repeated mechanical reuse of the same dominant expression or relational beat was confirmed.",
          }
        : {
              primary_genre: "최근 응답에서 주 장르 고유의 중심 논리가 반복적으로 선명하게 확인되지 않았어요.",
              genre_expression: "묘사·행동·속도·결과에서 장르 고유 표현이 충분히 반복되어 드러나지 않았어요.",
              support_texture: "보조 장르 렌즈가 뚜렷하게 확인되지 않았거나 현재 장면에 자연스러운 기회가 부족했어요.",
              scene_density: "공간·감각·물질·행동의 구체적인 요소가 장면에 지속적으로 작용하지 않았어요.",
              character_consistency: "분명한 캐릭터 붕괴는 없지만 여러 기준이 충분한 응답에서 구현되지 않아 안정을 확정하기 어려워요.",
              character_interpretation: "반복적인 단순화는 확정되지 않았지만 캐릭터 해석이 좁거나 혼재되어 안정을 확정하기 어려워요.",
              char_agency: "캐릭터 고유의 의도와 장면에 영향을 주는 선택이 최근 응답에서 충분히 이어지지 않았어요.",
              relationship: "관계의 기억·경계·긴장·감정 변화가 최근 응답에 지속적으로 반영되지 않았어요.",
              continuity: "앞선 행동·감정·장면 정보·즉각적인 결과가 최근 응답에서 충분히 이어지지 않았어요.",
              repetition: "같은 표현이나 관계 반응을 기계적으로 반복한 흐름은 확인되지 않았어요.",
          };
    const rawReasons = {
        primary_genre: normalizeAuditReason(parsed.primary_genre_reason, outputLanguage),
        genre_expression: normalizeAuditReason(parsed.genre_expression_reason, outputLanguage),
        support_texture: normalizeAuditReason(parsed.support_texture_reason, outputLanguage),
        scene_density: normalizeAuditReason(parsed.scene_density_reason, outputLanguage),
        character_consistency: normalizeAuditReason(parsed.character_consistency_reason, outputLanguage),
        character_interpretation: normalizeAuditReason(parsed.character_interpretation_reason, outputLanguage),
        char_agency: normalizeAuditReason(parsed.char_agency_reason, outputLanguage),
        relationship: normalizeAuditReason(parsed.relationship_reason, outputLanguage),
        continuity: normalizeAuditReason(parsed.continuity_reason, outputLanguage),
        repetition: normalizeAuditReason(parsed.repetition_reason, outputLanguage),
    };
    const rawRatings = {
        primary_genre: parsed.primary_genre,
        genre_expression: parsed.genre_expression,
        support_texture: hasSupportGenre ? parsed.support_texture : "na",
        scene_density: parsed.scene_density,
        character_consistency: parsed.character_consistency,
        character_interpretation: parsed.character_interpretation,
        char_agency: parsed.char_agency,
        relationship: parsed.relationship,
        continuity: parsed.continuity,
        repetition: parsed.repetition,
    };
    const reasons = Object.fromEntries(
        GENRE_AUDIT_CODES.map((code) => {
            const ratingUnchanged = ratings[code] === rawRatings[code];
            return [
                code,
                ratingUnchanged
                    ? rawReasons[code] ||
                      (outputLanguage === "en"
                          ? "No detailed reason was returned for this rating."
                          : "이 항목의 상세 사유가 생성되지 않았어요.")
                    : fallbackReasons[code],
            ];
        })
    );

    const codes = correctionPriority.filter(
        (code) =>
            (["weak", "drifted", "biased"].includes(ratings[code])) &&
            (hasSupportGenre || code !== "support_texture")
    );
    if (ratings.repetition === "weak") codes.push("repetition");

    const correctionCodes = [...new Set(codes)].slice(0, 2);
    const hasCharacterCorrection = correctionCodes.some((code) =>
        CHARACTER_BASELINE_CORRECTION_CODES.has(code)
    );
    const characterFocusFields = hasCharacterCorrection
        ? [
              ...new Set(
                  parsed.character_focus_fields
                      .map((value) => String(value || "").trim())
                      .filter((value) =>
                          CHARACTER_BASELINE_FIELD_ID_SET.has(value)
                      )
              ),
          ].slice(0, 2)
        : [];
    const correctionText = correctionCodes.some((code) =>
        CHARACTER_BOOST_CORRECTION_CODES.has(code)
    )
        ? normalizeCharacterCorrectionText(parsed.character_correction)
        : "";
    const result = {
        ratings,
        correctionCodes,
        correctionText,
        characterFocusFields,
        evidence,
        reasons,
    };
    return applyLegacyPolicy ? finalizeLegacyAudit(result, parsed, outputLanguage, allowCorrectionFallback) : result;
}

// @source-order 210
function createGenreAuditRecord({
    selection,
    manual,
    scope = "combined",
    ratings = null,
    correctionCodes = [],
    correctionText = "",
    correctionByCode = {},
    characterFocusFields = [],
    evidence = null,
    reasons = null,
    status,
    connectionSnapshot = null,
    errorMessage = "",
}) {
    return {
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        mode: manual ? "manual" : "auto",
        scope: ["genre", "character"].includes(scope) ? scope : "combined",
        primaryId: String(selection?.primaryGenre?.id || ""),
        primaryLabel: String(selection?.primaryGenre?.label || ""),
        supportId: String(selection?.supportGenre?.id || ""),
        supportLabel: String(selection?.supportGenre?.label || ""),
        characterIncluded: Boolean(selection?.characterEnabled),
        ratings,
        evidence: evidence
            ? {
                  primary: Array.isArray(evidence.primary)
                      ? evidence.primary.slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                      : [],
                  primaryFailure: Array.isArray(evidence.primaryFailure)
                      ? evidence.primaryFailure.slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                      : [],
                  genreExpression: Array.isArray(evidence.genreExpression)
                      ? evidence.genreExpression.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  genreExpressionFailure: Array.isArray(
                      evidence.genreExpressionFailure
                  )
                      ? evidence.genreExpressionFailure.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  support: Array.isArray(evidence.support)
                      ? evidence.support.slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                      : [],
                  supportOpportunity: Array.isArray(evidence.supportOpportunity)
                      ? evidence.supportOpportunity.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  supportIdentifiable:
                      evidence.supportIdentifiable === true,
                  sceneDensity: Array.isArray(evidence.sceneDensity)
                      ? evidence.sceneDensity.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  sceneDensityFailure: Array.isArray(evidence.sceneDensityFailure)
                      ? evidence.sceneDensityFailure.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  characterConsistencyPositive: Array.isArray(
                      evidence.characterConsistencyPositive
                  )
                      ? evidence.characterConsistencyPositive.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  characterConsistency: Array.isArray(
                      evidence.characterConsistency
                  )
                      ? evidence.characterConsistency.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  characterInterpretationPositive: Array.isArray(
                      evidence.characterInterpretationPositive
                  )
                      ? evidence.characterInterpretationPositive.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  characterInterpretation: Array.isArray(
                      evidence.characterInterpretation
                  )
                      ? evidence.characterInterpretation.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  characterAgency: Array.isArray(evidence.characterAgency)
                      ? evidence.characterAgency.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  characterAgencyFailure: Array.isArray(
                      evidence.characterAgencyFailure
                  )
                      ? evidence.characterAgencyFailure.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  relationship: Array.isArray(evidence.relationship)
                      ? evidence.relationship.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  relationshipFailure: Array.isArray(evidence.relationshipFailure)
                      ? evidence.relationshipFailure.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  continuity: Array.isArray(evidence.continuity)
                      ? evidence.continuity.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  continuityFailure: Array.isArray(evidence.continuityFailure)
                      ? evidence.continuityFailure.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  repetition: Array.isArray(evidence.repetition)
                      ? evidence.repetition.slice(
                            0,
                            GENRE_AUDIT_RESPONSE_LIMIT
                        )
                      : [],
                  reviewedResponses: Number(evidence.reviewedResponses) || 0,
              }
            : null,
        reasons:
            reasons && typeof reasons === "object"
                ? Object.fromEntries(
                      GENRE_AUDIT_CODES.map((code) => [
                          code,
                          String(reasons[code] || "")
                              .replace(/\s+/g, " ")
                              .trim()
                              .slice(0, 300),
                      ])
                  )
                : {},
        correctionCodes: correctionCodes
            .filter((code) => GENRE_AUDIT_CODES.includes(code))
            .slice(0, 2),
        correctionByCode: normalizeAuditCorrections(correctionByCode, correctionCodes),
        correctionText: normalizeCharacterCorrectionText(correctionText),
        characterFocusFields: characterFocusFields
            .filter((fieldId) => CHARACTER_BASELINE_FIELD_ID_SET.has(fieldId))
            .slice(0, 2),
        status,
        appliedMessageId: null,
        connection: {
            source: connectionSnapshot?.source === "profile" ? "profile" : "main",
            profileId: String(connectionSnapshot?.profileId || ""),
            profileName: String(
                connectionSnapshot?.profileName || "현재 채팅 연결"
            ),
            model: String(connectionSnapshot?.model || ""),
        },
        errorMessage: String(errorMessage || "").slice(0, 300),
    };
}

// @source-order 211
async function runGenreDriftAudit(chatId, selection, { manual = false, scope = "combined", trigger = manual ? "manual" : "direct" } = {}) {
    const trace = beginAuditRun({ manual, scope, trigger });
    if (genreAuditPendingChats.has(chatId)) {
        finishAuditRun(trace, 'skipped', 'busy');
        if (trigger === 'test') showGenreAuditToast('info', '이 채팅의 진단이 이미 진행 중이에요. 진행 기록에서 현재 단계를 확인해 주세요.');
        return readAuditRuns().find(row => row.id === trace.id);
    }
    genreAuditPendingChats.add(chatId);
    try {
        const beforeRestore = roleplayFingerprint();
        if (isJevUsageAllowed()) {
            traceAuditStage(trace, 'credential_restore');
            const ready = await ensureJevKeyReady();
            traceAuditStage(trace, 'credential_ready', { credentialReady: ready });
            if (!ready && chatId === getCurrentChatId()) showGenreAuditToast('info', 'Jev 키를 사용할 수 없어 이번에는 기존 진단 연결을 사용해요. 전역 설정의 키 상태를 확인해 주세요.');
        }
        if (chatId !== getCurrentChatId() || beforeRestore !== roleplayFingerprint() ||
            getGenreSelectionSignature(selection) !== getGenreSelectionSignature(getScopedAuditSelection(getBoosterSelection(ensureChatState(chatId)), scope))) {
            const reason = chatId !== getCurrentChatId() ? 'chat_changed' : beforeRestore !== roleplayFingerprint() ? 'messages_changed' : 'selection_changed';
            finishAuditRun(trace, 'cancelled', reason);
            if (chatId === getCurrentChatId()) showGenreAuditToast('info', auditCancellationMessage(reason));
            return readAuditRuns().find(row => row.id === trace.id);
        }
        await executeGenreDriftAudit(chatId, selection, { manual, scope }, trace);
    } catch (error) {
        recordStoryBoosterError(error, { task: 'audit_setup', stage: 'audit_setup' });
        finishAuditRun(trace, 'failed', 'setup_failed', { errorKind: auditTraceErrorKind(error) });
        if (chatId === getCurrentChatId()) showGenreAuditToast('warning', '진단 입력을 준비하지 못했어요. 설정을 확인한 뒤 다시 진단해 주세요.');
    } finally {
        genreAuditPendingChats.delete(chatId);
        if (trace.status === 'running') finishAuditRun(trace, 'failed', 'unexpected_exit');
    }
    return readAuditRuns().find(row => row.id === trace.id);
}

async function executeGenreDriftAudit(chatId, selection, { manual, scope }, trace) {
    let resultSaved = false;
    const auditLabel =
        scope === "genre"
            ? "장르"
            : scope === "character"
              ? "캐릭터"
              : "통합";
    const auditRunLabel = manual
        ? `${auditLabel} 수동`
        : scope === "combined"
          ? "자동 통합"
          : `자동 ${auditLabel}`;
    const auditStartState = ensureChatState(chatId);
    const correctionRevisionAtStart = ensureGenreAnchorState(
        auditStartState
    ).correctionRevision;
    const selectionSignature = getGenreSelectionSignature(selection);
    const chatSnapshot = snapshotCurrentChatMessages();
    const auditSettings = ensureModuleSettings();
    const includePlot = scope === 'combined' && selection.autoPlotEnabled === true;
    const epochAtStart = automaticPlotRuntime.epoch;
    const contextEpochAtStart = automaticPlotRuntime.contextEpoch;
    const genreEpochAtStart = automaticPlotRuntime.genreEpoch;
    const characterEpochAtStart = automaticPlotRuntime.characterEpoch;
    const keyRevisionAtStart = getJevKeyRevision();
    const fingerprintAtStart = roleplayFingerprint(chatSnapshot);
    let contextFailure = null;
    const currentContext = () => {
        const changes = [];
        if (!isOperationContextCurrentChat(operationContext)) changes.push('chat_changed');
        if (keyRevisionAtStart !== getJevKeyRevision()) changes.push('key_changed');
        if (contextEpochAtStart !== automaticPlotRuntime.contextEpoch && !changes.includes(automaticPlotRuntime.lastContextCancellationReason)) {
            changes.push(automaticPlotRuntime.lastContextCancellationReason);
        }
        if (includePlot && epochAtStart !== automaticPlotRuntime.epoch && contextEpochAtStart === automaticPlotRuntime.contextEpoch) changes.push('plot_epoch_changed');
        const currentSettings = ensureModuleSettings();
        if (currentSettings.analysisProfileId !== operationContext.profileId) changes.push('profile_changed');
        if (currentSettings.outputLanguage !== operationContext.outputLanguage) changes.push('language_changed');
        if (String(getCurrentCharacterIdentity()?.key || '') !== operationContext.characterKey) changes.push('character_changed');
        if (roleplayFingerprint() !== fingerprintAtStart) changes.push('messages_changed');
        if ((selection.primaryGenre && genreEpochAtStart !== automaticPlotRuntime.genreEpoch) ||
            (selection.characterEnabled && characterEpochAtStart !== automaticPlotRuntime.characterEpoch)) changes.push('selection_changed');
        if (!changes.includes('selection_changed') && !changes.includes('chat_changed') && getGenreSelectionSignature(getScopedAuditSelection(getBoosterSelection(ensureChatState(chatId)), scope)) !== selectionSignature) changes.push('selection_changed');
        if (changes.length && !contextFailure) {
            contextFailure = changes[0];
            const messages = getContext()?.chat || [];
            const changed = chatSnapshot.flatMap((old, index) => {
                const now = messages[index];
                return !now || old.mes !== String(now.mes || '') || old.name !== String(now.name || '') || old.is_user !== Boolean(now.is_user) || old.is_system !== Boolean(now.is_system) ? [index] : [];
            });
            const appended = messages.slice(chatSnapshot.length);
            traceAuditStage(trace, 'context_changed', { contextChanges: changes,
                epochCause: contextEpochAtStart !== automaticPlotRuntime.contextEpoch ? automaticPlotRuntime.lastContextCancellationReason : automaticPlotRuntime.lastCancellationReason,
                messageCountDelta: messages.length - chatSnapshot.length, changedMessages: changed.length,
                firstChangedIndex: changed[0] ?? -1, appendedUserMessages: appended.filter(m => m.is_user && !m.is_system).length,
                appendedAssistantMessages: appended.filter(m => !m.is_user && !m.is_system).length });
        }
        // Once invalidated, a later edit restoring the same text must not revive this run.
        return !contextFailure;
    };
    const cancelTrace = (reason = contextFailure || 'unexpected_exit') => {
        finishAuditRun(trace, 'cancelled', reason, { resultSaved });
        if (isOperationContextCurrentChat(operationContext)) showGenreAuditToast('info', auditCancellationMessage(reason, automaticPlotRuntime.lastCancellationReason));
    };
    const auditResponseLength =
        AUDIT_RESPONSE_LENGTHS[scope] || AUDIT_RESPONSE_LENGTHS.combined;
    const operationContext = createOperationContextSnapshot({
        chatId,
        chatSnapshot,
        characterKey: getCurrentCharacterIdentity()?.key || "",
        profileId: auditSettings.analysisProfileId,
        outputLanguage: auditSettings.outputLanguage,
        responseLength: auditResponseLength,
        selectionSignature,
        correctionRevision: correctionRevisionAtStart,
    });
    const latestAssistantMessageId = getLatestAssistantMessageId(chatSnapshot);
    const auditInput = buildAuditTranscript(operationContext.chatSnapshot);
    const auditTranscript = auditInput.transcript;
    const reviewedResponses = auditInput.reviewedResponses;
    const analysisSnapshot = createAuditAnalysis({ messages: chatSnapshot, reviewedResponses,
        signature: selectionSignature, baselineState: getCurrentCharacterBaseline(),
        characterKey: operationContext.characterKey, characterIncluded: selection.characterEnabled });
    const selectedProfileId = operationContext.profileId;
    let connectionSnapshot = selectedProfileId
        ? createBackgroundConnectionSnapshot({
              id: selectedProfileId,
              name: "선택한 프로필(확인 불가)",
          })
        : createBackgroundConnectionSnapshot();
    const auditDiagnostic = createOperationDiagnostic({
        task:
            scope === "genre"
                ? "genre_audit"
                : scope === "character"
                  ? "character_audit"
                  : "combined_audit",
        responseLength: operationContext.responseLength,
        connectionMode: selectedProfileId ? "profile" : "main",
    });
    traceAuditStage(trace, 'snapshot', { messageCount: chatSnapshot.length, reviewedResponses,
        transcriptChars: auditTranscript.length, interval: getGlobalAuditInterval() });
    genreAuditPendingChats.add(chatId);
    try {
        updateGenreAnchorPanel();
        if (isOperationContextCurrentChat(operationContext)) {
            showGenreAuditToast(
                "info",
                `🔍 최근 롤플을 ${auditRunLabel} 진단 중이에요…`
            );
        }
        const auditOutputLanguage = operationContext.outputLanguage;
        let auditPrompt = buildGenreAuditPrompt(
            selection,
            scope,
            auditOutputLanguage
        );
        const baseAuditSchema = buildGenreAuditJsonSchema(
            scope,
            auditOutputLanguage
        );
        const auditJsonSchema = includePlot ? addPlotAuditSchema(baseAuditSchema) : baseAuditSchema;
        if (includePlot) auditPrompt += '\n' + plotAuditPrompt();
        auditDiagnostic.responseLength = operationContext.responseLength;
        const parseAudit = (result, applyLegacyPolicy = true, allowCorrectionFallback = false) => parseGenreAuditResult(result, Boolean(selection.supportGenre), reviewedResponses, scope, auditOutputLanguage, applyLegacyPolicy, allowCorrectionFallback);
        const legacyRequest = async () => {
            traceAuditStage(trace, 'legacy_connection');
            connectionSnapshot = await resolveBackgroundConnectionSnapshot(selectedProfileId);
            updateOperationDiagnosticConnection(auditDiagnostic, connectionSnapshot);
            traceAuditStage(trace, 'legacy_request', { engine: 'legacy', attemptMode: 'plain_json', timeoutMs: BACKGROUND_REQUEST_TIMEOUT_MS });
            let validatedDiagnosisFallback = null;
            try { return await requestStructuredJsonWithCompatibility({
            prompt: auditPrompt,
            transcript: auditTranscript,
            jsonSchema: auditJsonSchema,
            // Basic diagnosis uses a large policy shape. Its fully validated
            // plain-JSON path avoids repeating a provider schema negotiation.
            // Jev's smaller feedback shape and other features retain native schemas.
            initialAttemptMode: 'plain_json',
            responseLength: operationContext.responseLength,
            repairResponseLength: operationContext.responseLength,
            connectionSnapshot,
            task: auditDiagnostic.task,
            diagnostic: auditDiagnostic,
            parseResult: result => {
                validatedDiagnosisFallback = null;
                try { return { ...parseAudit(result), engine: 'legacy',
                    plotDecision: includePlot ? parsePlotDecision(result, reviewedResponses) : null }; }
                catch (error) {
                    if (/^(corrections|next_corrections)\./.test(error.validationField || '')) {
                        validatedDiagnosisFallback = { ...parseAudit(result, true, true), engine: 'legacy',
                            plotDecision: includePlot ? parsePlotDecision(result, reviewedResponses) : null };
                    }
                    throw error;
                }
            },
            onFallback: ({ repair, error, attemptMode }) => {
                traceAuditStage(trace, 'compatibility_retry', { requestCount: auditDiagnostic.requestCount,
                    retryCount: auditDiagnostic.retryCount, compatibilityFallback: true, errorKind: auditTraceErrorKind(error),
                    attemptMode, ...responseValidationDetails(error), ...auditDiagnostic.responseMetadata, ...auditDiagnostic.requestFailure });
                if (!isOperationContextCurrentChat(operationContext)) return;
                showGenreAuditToast(
                    "info",
                    auditDiagnostic.requestFailure?.failurePhase === 'dispatch'
                        ? `🔄 ${auditLabel} 진단 요청이 완료되지 않아 다시 확인하고 있어요…`
                        : `🔄 ${auditLabel} 진단 응답을 검증하지 못해 다시 확인하고 있어요…`
                );
            },
            }); } catch (error) {
                // Only a complete, validated diagnosis whose last attempt failed
                // the writing contract can use templates. Never turn a missing
                // diagnosis, timeout or network error into a saved success.
                if (!validatedDiagnosisFallback || !/^(corrections|next_corrections)\./.test(error.validationField || '')) throw error;
                traceAuditStage(trace, 'feedback_fallback', { feedbackFallback: true, errorKind: 'response_validation',
                    ...responseValidationDetails(error), requestCount: auditDiagnostic.requestCount, retryCount: auditDiagnostic.retryCount });
                recordStoryBoosterError(error, { task: 'legacy_feedback', diagnostic: auditDiagnostic });
                if (isOperationContextCurrentChat(operationContext)) showGenreAuditToast('info', '맞춤 보정문 작성에 실패해 검증된 진단과 기존 보정 지시를 사용해요.');
                return validatedDiagnosisFallback;
            }
        };
        let auditResult;
        if (isJevUsageAllowed() && hasJevSessionKey()) {
            try {
                auditResult = await runJevDiagnosis({ selection, transcript: auditTranscript, reviewedResponses,
                    schema: baseAuditSchema, parseResult: result => parseAudit(result, false), outputLanguage: auditOutputLanguage, isCurrent: currentContext,
                    onProgress: (stage, details) => traceAuditStage(trace, stage, details) });
            } catch (error) {
                if (!currentContext()) { cancelTrace(); return; }
                traceAuditStage(trace, 'jev_fallback', { jevFallback: true, errorKind: auditTraceErrorKind(error) });
                recordStoryBoosterError(error, { task: 'jev_audit', stage: error.stage || 'jev_diagnosis' });
                if (isOperationContextCurrentChat(operationContext)) showGenreAuditToast('info', 'Jev 연결에 실패해 기존 진단으로 확인하고 있어요.');
                auditResult = { ...await legacyRequest(), jevFallback: true };
            }
            if (auditResult.engine === 'jev') {
                try {
                    auditResult = await writeJevFeedback(auditResult, selection, auditTranscript, async options => {
                        traceAuditStage(trace, 'feedback_connection');
                        connectionSnapshot = await resolveBackgroundConnectionSnapshot(selectedProfileId);
                        updateOperationDiagnosticConnection(auditDiagnostic, connectionSnapshot);
                        auditDiagnostic.responseLength = options.responseLength;
                        traceAuditStage(trace, 'feedback_request', { responseLength: options.responseLength, timeoutMs: BACKGROUND_REQUEST_TIMEOUT_MS });
                        return requestStructuredJsonWithCompatibility({ ...options, connectionSnapshot,
                            task: 'jev_feedback', diagnostic: auditDiagnostic,
                            onFallback: ({ repair, error, attemptMode }) => traceAuditStage(trace, 'compatibility_retry', {
                                requestCount: auditDiagnostic.requestCount, retryCount: auditDiagnostic.retryCount,
                                compatibilityFallback: true, errorKind: auditTraceErrorKind(error),
                                attemptMode, ...responseValidationDetails(error), ...auditDiagnostic.responseMetadata, ...auditDiagnostic.requestFailure }) });
                    }, auditOutputLanguage);
                    traceAuditStage(trace, 'feedback_received', { requestCount: auditDiagnostic.requestCount,
                        retryCount: auditDiagnostic.retryCount, promptChars: auditDiagnostic.promptChars,
                        inputChars: auditDiagnostic.inputChars, responseChars: auditDiagnostic.responseChars, ...auditDiagnostic.responseMetadata });
                    auditResult.feedbackConnection = connectionSnapshot;
                } catch (error) {
                    if (!currentContext()) { cancelTrace(); return; }
                    traceAuditStage(trace, 'feedback_fallback', { feedbackFallback: true, errorKind: auditTraceErrorKind(error), ...responseValidationDetails(error), ...auditDiagnostic.responseMetadata,
                        attemptMode: auditDiagnostic.attemptMode, ...auditDiagnostic.requestFailure,
                        requestCount: auditDiagnostic.requestCount, retryCount: auditDiagnostic.retryCount });
                    recordStoryBoosterError(error, { task: 'jev_feedback', diagnostic: auditDiagnostic });
                    auditResult.correctionGeneration = 'template_fallback';
                    auditResult.correctionText = '';
                    auditResult.correctionByCode = Object.fromEntries(auditResult.correctionCodes.map(code => [code,
                        formatAuditCorrectionInstruction(GENRE_CORRECTION_MODULES[code], auditResult.ratings[code])]));
                    auditResult.reasons = Object.fromEntries(Object.keys(auditResult.ratings).map(code => [code,
                        auditOutputLanguage === 'en' ? 'Jev completed the assessment, but the detailed explanation could not be generated.' : 'Jev 판정은 완료됐지만 구체적인 판단 이유를 작성하지 못했습니다.']));
                    if (isOperationContextCurrentChat(operationContext)) showGenreAuditToast('info', '판단 이유·맞춤 보정문 작성에 실패해 기존 보정 지시를 사용해요.');
                }
            }
        } else auditResult = await legacyRequest();
        // Discard late decisions after a chat round trip, key change, new input
        // or edited/swiped message. They must not target a different RP turn.
        if (!currentContext()) { cancelTrace(); return; }
        traceAuditStage(trace, 'result_ready', { engine: auditResult.engine,
            correctionCount: auditResult.correctionCodes?.length || 0, deferredCount: auditResult.uncertain?.length || 0,
            requestCount: auditDiagnostic.requestCount, retryCount: auditDiagnostic.retryCount,
            attemptMode: auditDiagnostic.attemptMode, ...auditDiagnostic.responseMetadata });
        const {
            ratings,
            correctionCodes,
            correctionText,
            characterFocusFields,
            evidence,
            reasons,
            correctionByCode = {},
        } = auditResult;
        const chatState = ensureModuleSettings().chats[chatId];
        if (!chatState) { cancelTrace('state_missing'); return; }
        ensureGenreAnchorState(chatState);
        const currentSelection = getScopedAuditSelection(
            getBoosterSelection(chatState),
            scope
        );
        if (
            getGenreSelectionSignature(currentSelection) !==
            operationContext.selectionSignature
        ) {
            cancelTrace('selection_changed');
            const cancelledRecord = createGenreAuditRecord({
                selection,
                manual,
                scope,
                ratings,
                correctionCodes: [],
                evidence,
                reasons,
                status: "cancelled",
                connectionSnapshot,
                errorMessage:
                    "진단 중 부스터 설정이나 캐릭터 기준이 변경되어 이전 결과를 적용하지 않았습니다.",
            });
            storeLastAuditRecord(chatState.genreAnchor, cancelledRecord, scope);
            chatState.genreAnchor.auditStatus = "waiting";
            saveSettingsDebounced();
            if (isOperationContextCurrentChat(operationContext)) {
                showGenreAuditToast(
                    "info",
                    "부스터 설정이나 캐릭터 기준이 변경되어 이전 진단 결과를 적용하지 않았어요."
                );
            }
            return;
        }
        if (
            chatState.genreAnchor.correctionRevision !==
            operationContext.correctionRevision
        ) {
            cancelTrace('correction_changed');
            const supersededRecord = createGenreAuditRecord({
                selection,
                manual,
                scope,
                ratings,
                correctionCodes,
                correctionText,
                correctionByCode,
                characterFocusFields,
                evidence,
                reasons,
                status: "cancelled",
                connectionSnapshot,
                errorMessage:
                    "진단 중 1회 보강 선택이 변경되어 진단 결과가 현재 보강 대기열을 덮어쓰지 않도록 적용을 보류했습니다.",
            });
            storeLastAuditRecord(
                chatState.genreAnchor,
                supersededRecord,
                scope
            );
            saveSettingsDebounced();
            if (isOperationContextCurrentChat(operationContext)) {
                showGenreAuditToast(
                    "info",
                    "진단은 완료됐지만 기존 1회 보강 선택을 유지했어요."
                );
            }
            return;
        }
        if (!manual && getGlobalAuditInterval() === 0) {
            cancelTrace('automatic_disabled');
            const cancelledRecord = createGenreAuditRecord({
                selection,
                manual,
                scope,
                ratings,
                correctionCodes,
                characterFocusFields,
                evidence,
                reasons,
                status: "cancelled",
                connectionSnapshot,
            });
            storeLastAuditRecord(chatState.genreAnchor, cancelledRecord, scope);
            chatState.genreAnchor.auditStatus = "waiting";
            saveSettingsDebounced();
            return;
        }
        traceAuditStage(trace, 'saving');
        const hasAttentionRatings = Object.entries(ratings || {}).some(
            ([code, rating]) => rating === "attention" && !auditResult.uncertain?.includes(code)
        );
        const hasDeferredRatings = Boolean(auditResult.uncertain?.length);
        chatState.genreAnchor.correctionCodes = correctionCodes;
        chatState.genreAnchor.correctionText = correctionText;
        chatState.genreAnchor.correctionByCode = normalizeAuditCorrections(correctionByCode, correctionCodes);
        chatState.genreAnchor.correctionFieldIds = characterFocusFields;
        chatState.genreAnchor.correctionCharacterBaselineHash = correctionCodes.some(
            (code) => CHARACTER_BOOST_CORRECTION_CODES.has(code)
        )
            ? hashStableText(String(selection.characterBaseline || ""))
            : "";
        chatState.genreAnchor.correctionRemaining = correctionCodes.length ? 1 : 0;
        chatState.genreAnchor.correctionAppliedMessageId = null;
        chatState.genreAnchor.correctionArmedRevision = 0;
        chatState.genreAnchor.auditStatus = correctionCodes.length
            ? "reinforcing"
            : hasAttentionRatings
              ? "attention"
              : hasDeferredRatings ? "deferred" : "stable";
        bumpCorrectionRevision(chatState.genreAnchor);
        const completedRecord = createGenreAuditRecord({
            selection,
            manual,
            scope,
            ratings,
            correctionCodes,
            correctionText,
            correctionByCode,
            characterFocusFields,
            evidence,
            reasons,
            status: correctionCodes.length
                ? "pending"
                : hasAttentionRatings
                  ? "attention"
                  : hasDeferredRatings ? "deferred" : "stable",
            connectionSnapshot,
        });
        completedRecord.engine = auditResult.engine;
        completedRecord.feedbackConnection = auditResult.feedbackConnection ? {
            profileName: auditResult.feedbackConnection.profileName || '현재 채팅 연결',
            model: auditResult.feedbackConnection.model || '',
        } : null;
        completedRecord.jevFallback = auditResult.jevFallback === true;
        completedRecord.uncertain = auditResult.uncertain || [];
        completedRecord.decisionTrace = auditResult.decisionTrace || {};
        completedRecord.correctionSummaries = auditResult.correctionSummaries || {};
        completedRecord.correctionGeneration = auditResult.correctionGeneration || '';
        if (auditResult.engine === 'jev') completedRecord.connection = { source: 'jev', profileId: '', profileName: 'Jev · SillyTavern 기본 중계', model: auditResult.jev?.model || 'jev-latest' };
        completedRecord.analysis = analysisSnapshot;
        completedRecord.comparison = compareAuditHistory(chatState.genreAnchor, completedRecord, chatSnapshot);
        rememberAudit(chatState.genreAnchor, completedRecord);
        storeLastAuditRecord(chatState.genreAnchor, completedRecord, scope);
        if (manual && scope === "combined") {
            chatState.genreAnchor.responseCount = 0;
            chatState.genreAnchor.lastCountedMessageId =
                latestAssistantMessageId;
        }
        saveSettingsDebounced();
        resultSaved = true;
        traceAuditStage(trace, 'saved', { resultSaved: true });

        if (isOperationContextCurrentChat(operationContext)) {
            traceAuditStage(trace, 'displaying');
            updateGenrePrompt();
            updateGenreAnchorPanel();
            traceAuditStage(trace, 'displayed', { displayUpdated: true });
            showGenreAuditToast(
                correctionCodes.length || hasAttentionRatings || hasDeferredRatings ? "info" : "success",
                correctionCodes.length
                    ? `🧭 ${auditRunLabel} 진단 완료 · 다음 응답에 보정을 적용해요`
                    : hasAttentionRatings
                      ? `🔎 ${auditRunLabel} 진단 완료 · 주의 항목의 상세 사유를 확인해 주세요`
                      : hasDeferredRatings
                        ? `🔎 ${auditRunLabel} 진단 완료 · 판단 보류 항목의 상세 사유를 확인해 주세요`
                      : `✅ ${auditRunLabel} 진단 완료 · 활성 부스터가 안정적이에요`
            );
        }
        if (includePlot && manual && currentContext()) {
            const prefs = ensureAutomaticPlotSettings(chatState);
            cancelAutomaticPlot();
            if (healthyAuditForAutomaticPlot(selection, auditResult)) {
                try {
                    const decision = auditResult.plotDecision || await diagnoseAutomaticPlot({ selection, transcript: auditTranscript, count: reviewedResponses, history: chatState.plotHistory?.slice(0, 3) });
                    if (isOperationContextCurrentChat(operationContext) && getJevKeyRevision() === keyRevisionAtStart && roleplayFingerprint() === fingerprintAtStart) {
                        prefs.lastDecision = decision?.eligible ? '수동 진단 · 정체를 확인했습니다. 사건은 자동 진단 때 준비합니다.' : plotDecisionReason(decision);
                    }
                } catch { prefs.lastDecision = '사건 필요성을 확인하지 못해 이번에는 자동 랜덤박스를 준비하지 않습니다.'; }
            } else prefs.lastDecision = plotAuditHoldReason(auditResult);
            prefs.status = 'deferred'; updateAutomaticPlotStatus(); saveSettingsDebounced();
        }
        if (includePlot && !manual && currentContext()) {
            traceAuditStage(trace, 'plot_check');
            await prepareAutomaticPlot({ chatId, selection, result: auditResult,
                transcript: auditTranscript, count: reviewedResponses, isCurrent: currentContext, parentAuditId: trace.id });
            traceAuditStage(trace, 'plot_finished', { plotStatus: ensureAutomaticPlotSettings(chatState).status });
        }
    } catch (err) {
        if (!resultSaved && !currentContext()) {
            cancelTrace();
            recordStoryBoosterError(err, { task: auditDiagnostic.task, diagnostic: auditDiagnostic, notify: false });
            return;
        }
        const errorKind = auditTraceErrorKind(err);
        finishAuditRun(trace, 'failed', resultSaved ? 'post_save_failed' : errorKind === 'timeout' ? 'request_timeout' : 'request_failed',
            { errorKind, resultSaved, requestCount: auditDiagnostic.requestCount, retryCount: auditDiagnostic.retryCount,
                ...responseValidationDetails(err), ...auditDiagnostic.responseMetadata, ...auditDiagnostic.requestFailure,
                attemptMode: auditDiagnostic.attemptMode });
        console.error(`[${MODULE_NAME}] genre drift audit failed:`, err);
        recordStoryBoosterError(err, {
            task: auditDiagnostic.task,
            diagnostic: auditDiagnostic,
        });
        // A display failure must not replace a diagnosis that was already committed.
        if (resultSaved) {
            if (isOperationContextCurrentChat(operationContext)) showGenreAuditToast('warning', '진단 결과는 저장됐지만 화면 또는 후속 처리에 문제가 생겼어요. 진단 진행 기록을 확인해 주세요.');
            return;
        }
        const chatState = ensureModuleSettings().chats[chatId];
        let staleSelection = false;
        if (chatState) {
            ensureGenreAnchorState(chatState);
            staleSelection =
                getGenreSelectionSignature(
                    getScopedAuditSelection(
                        getBoosterSelection(chatState),
                        scope
                    )
                ) !== operationContext.selectionSignature;
            chatState.genreAnchor.auditStatus = staleSelection
                ? "waiting"
                : "error";
            const errorRecord = createGenreAuditRecord({
                selection,
                manual,
                scope,
                status: staleSelection ? "cancelled" : "error",
                connectionSnapshot,
                errorMessage: staleSelection
                    ? "진단 중 부스터 설정이나 캐릭터 기준이 변경되어 이전 요청을 적용하지 않았습니다."
                    : err?.message || "진단 요청에 실패했습니다.",
            });
            storeLastAuditRecord(chatState.genreAnchor, errorRecord, scope);
            saveSettingsDebounced();
        }
        if (isOperationContextCurrentChat(operationContext)) {
            showGenreAuditToast(
                staleSelection ? "info" : "warning",
                staleSelection
                    ? "부스터 설정이나 캐릭터 기준이 변경되어 이전 진단 요청을 적용하지 않았어요."
                    : `⚠️ ${auditRunLabel} 진단 실패 · 부스팅은 계속 유지돼요`
            );
        }
    } finally {
        genreAuditPendingChats.delete(chatId);
        try {
            if (isOperationContextCurrentChat(operationContext)) updateGenreAnchorPanel();
        } catch (error) {
            finishAuditRun(trace, 'failed', resultSaved ? 'post_save_failed' : 'request_failed', { resultSaved, errorKind: auditTraceErrorKind(error) });
            recordStoryBoosterError(error, { task: 'audit_display', stage: 'panel_refresh' });
        }
        if (trace.status === 'running') finishAuditRun(trace, resultSaved ? 'completed' : 'failed', resultSaved ? 'completed' : 'unexpected_exit', { resultSaved });
    }
}

async function runAutomaticAuditTest() {
    if (!isDeveloperModeUnlocked()) { showGenreAuditToast('info', '개발자 모드를 먼저 열어 주세요.'); return null; }
    const chatId = getCurrentChatId();
    if (chatId === 'no-chat-open' || getLatestAssistantMessageId() < 0) {
        showGenreAuditToast('info', '최근 AI 답변이 있는 채팅을 열어 주세요.'); return null;
    }
    if (getGlobalAuditInterval() === 0) {
        showGenreAuditToast('info', '자동 진단 주기를 켠 뒤 테스트해 주세요.'); return null;
    }
    const selection = getBoosterSelection(ensureChatState(chatId));
    const scope = selection ? getAutomaticAuditScope(selection) : null;
    const scoped = scope ? getScopedAuditSelection(selection, scope) : null;
    if (!scoped) {
        showGenreAuditToast('info', '진단할 장르·캐릭터 또는 자동 랜덤박스를 먼저 활성화해 주세요.'); return null;
    }
    return runGenreDriftAudit(chatId, scoped, { manual: false, scope, trigger: 'test' });
}

// @source-order 212
function runManualGenreAudit(scope = "genre") {
    const state = ensureChatState();
    if (
        state.genreAnchor.correctionRemaining > 0 &&
        state.genreAnchor.correctionAppliedMessageId === null
    ) {
        toastr?.info?.(
            "대기 중인 보정을 먼저 적용하거나 ‘이번 보정 적용 안 하기’로 취소해 주세요."
        );
        return;
    }
    const selection = getScopedAuditSelection(getBoosterSelection(state), scope);
    if (!selection) {
        toastr?.warning?.(
            scope === "character"
                ? "캐릭터 수동 진단을 사용하려면 캐릭터 기준을 먼저 만들어 주세요."
                : "장르 수동 진단을 사용하려면 주 장르를 먼저 선택해 주세요."
        );
        return;
    }
    runGenreDriftAudit(getCurrentChatId(), selection, { manual: true, scope });
}

// @source-order 269
function handleGenreResponseReceived(messageId) {
    const chatId = getCurrentChatId();
    const state = ensureChatState();
    const selection = getBoosterSelection(state);
    if (!selection) return;

    const numericMessageId = Number(messageId);
    const resolvedMessageId = Number.isSafeInteger(numericMessageId)
        ? numericMessageId
        : getLatestAssistantMessageId();
    const message = getContext()?.chat?.[resolvedMessageId];
    if (!Number.isSafeInteger(resolvedMessageId) || message?.is_user || message?.is_system) {
        return;
    }

    if (state.genreAnchor.lastCountedMessageId === resolvedMessageId) {
        if (
            markArmedGenreCorrectionApplied(
                state.genreAnchor,
                resolvedMessageId
            )
        ) {
            saveSettingsDebounced();
            updateGenrePrompt();
        }
        updateGenreAnchorPanel();
        return;
    }

    state.genreAnchor.lastCountedMessageId = resolvedMessageId;
    const correctionApplied = markArmedGenreCorrectionApplied(
        state.genreAnchor,
        resolvedMessageId
    );
    if (correctionApplied) updateGenrePrompt();

    const auditInterval = getGlobalAuditInterval();
    if (auditInterval === 0) {
        state.genreAnchor.responseCount = 0;
        saveSettingsDebounced();
        updateGenreAnchorPanel();
        return;
    }

    state.genreAnchor.responseCount =
        state.genreAnchor.responseCount >= Number.MAX_SAFE_INTEGER - 1
            ? 1
            : state.genreAnchor.responseCount + 1;
    saveSettingsDebounced();

    if (
        state.genreAnchor.responseCount % auditInterval ===
        0
    ) {
        const automaticScope = getAutomaticAuditScope(selection);
        const automaticSelection = getScopedAuditSelection(
            selection,
            automaticScope
        );
        if (automaticScope && automaticSelection) {
            runGenreDriftAudit(chatId, automaticSelection, {
                scope: automaticScope,
                trigger: 'message_received',
            });
        } else {
            updateGenreAnchorPanel();
        }
    } else {
        updateGenreAnchorPanel();
    }
}

// @source-order 270
function handleGenreUserMessageSent() {
    const state = ensureChatState();
    if (state.genreAnchor.correctionAppliedMessageId !== null) {
        clearAppliedGenreCorrectionOnUserTurn();
        return;
    }
    armPendingGenreCorrectionForNextResponse(state);
}

// @source-order 271
function clearAppliedGenreCorrectionOnUserTurn() {
    const state = ensureChatState();
    if (
        state.genreAnchor.correctionRemaining <= 0 ||
        state.genreAnchor.correctionAppliedMessageId === null
    ) {
        return;
    }

    state.genreAnchor.correctionCodes = [];
    state.genreAnchor.correctionText = "";
    state.genreAnchor.correctionByCode = {};
    state.genreAnchor.correctionFieldIds = [];
    state.genreAnchor.correctionRemaining = 0;
    state.genreAnchor.correctionAppliedMessageId = null;
    state.genreAnchor.correctionArmedRevision = 0;
    state.genreAnchor.correctionCharacterBaselineHash = "";
    state.genreAnchor.auditStatus = "monitoring";
    bumpCorrectionRevision(state.genreAnchor);
    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreAnchorPanel();
}

// @source-order 272
function markPendingGenreAuditCancelled(state) {
    ["lastAudit", "lastGenreAudit", "lastCharacterAudit"].forEach((key) => {
        const record = state?.genreAnchor?.[key];
        if (record?.status !== "pending") return;
        record.status = "cancelled";
        record.appliedMessageId = null;
    });
}

// @source-order 273
function cancelPendingGenreCorrection(scope = "combined") {
    const state = ensureChatState();
    const removableCodes =
        scope === "genre"
            ? GENRE_BOOST_CORRECTION_CODES
            : scope === "character"
              ? CHARACTER_BOOST_CORRECTION_CODES
              : new Set(GENRE_AUDIT_CODES);
    const hasPendingCorrection =
        state.genreAnchor.correctionRemaining > 0 &&
        state.genreAnchor.correctionAppliedMessageId === null &&
        state.genreAnchor.correctionCodes.some((code) =>
            removableCodes.has(code)
        );

    if (!hasPendingCorrection) {
        toastr?.info?.("취소할 진단 보정이 없습니다.");
        return;
    }
    removeLiveCorrectionCodes(state.genreAnchor, removableCodes);
    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreAnchorPanel();
    showGenreAuditToast(
        "info",
        (scope === "genre"
            ? "장르"
            : scope === "character"
              ? "캐릭터"
              : "선택한") +
            " 1회 보강을 취소했어요. 부스팅은 계속 유지돼요."
    );
}

// @source-order 274
function canQueueManualAuditBoost(code) {
    if (!GENRE_AUDIT_CODES.includes(code)) return false;
    if (GENRE_BOOST_CORRECTION_CODES.has(code)) {
        const genreSelection = getGenreAnchorSelection();
        if (!genreSelection) return false;
        if (code === "support_texture" && !genreSelection.supportGenre) {
            return false;
        }
        return true;
    }
    if (CHARACTER_BOOST_CORRECTION_CODES.has(code)) {
        const readiness = getCharacterBoosterReadiness();
        return readiness.featureEnabled && readiness.baselineAvailable;
    }
    return false;
}

// @source-order 275
function toggleManualAuditBoost(code, audit = null) {
    cancelAutomaticPlot();
    if (!GENRE_AUDIT_CODES.includes(code)) return;
    if (!canQueueManualAuditBoost(code)) {
        toastr?.warning?.(
            GENRE_BOOST_CORRECTION_CODES.has(code)
                ? "현재 장르 설정에서는 이 항목을 보강할 수 없어요."
                : "캐릭터 기준과 캐릭터 부스터를 먼저 준비해 주세요."
        );
        return;
    }

    const state = ensureChatState();
    const anchor = ensureGenreAnchorState(state);
    let codes = [...anchor.correctionCodes];
    if (anchor.correctionAppliedMessageId !== null) {
        codes = [];
        anchor.correctionText = "";
        anchor.correctionByCode = {};
        anchor.correctionFieldIds = [];
        anchor.correctionCharacterBaselineHash = "";
    }

    if (codes.includes(code)) {
        codes = codes.filter((item) => item !== code);
    } else {
        if (codes.length >= 2) {
            toastr?.info?.("다음 응답 1회 보강은 최대 2개까지 선택할 수 있어요.");
            return;
        }
        codes.push(code);
    }

    anchor.correctionCodes = codes;
    anchor.correctionByCode = normalizeAuditCorrections({ ...anchor.correctionByCode, ...audit?.correctionByCode }, codes);
    anchor.correctionRemaining = codes.length ? 1 : 0;
    anchor.correctionAppliedMessageId = null;
    anchor.correctionArmedRevision = 0;
    anchor.auditStatus = codes.length
        ? "reinforcing"
        : getGlobalAuditInterval() === 0
          ? "waiting"
          : "monitoring";
    reconcilePendingAuditRecords(anchor);

    const selectedCharacterCodes = codes.filter((item) =>
        CHARACTER_BOOST_CORRECTION_CODES.has(item)
    );
    const auditCharacterCodes = Array.isArray(audit?.correctionCodes)
        ? audit.correctionCodes.filter((item) =>
              CHARACTER_BOOST_CORRECTION_CODES.has(item)
          )
        : [];
    const targetedCorrectionMatchesSelection =
        selectedCharacterCodes.length > 0 &&
        selectedCharacterCodes.length === auditCharacterCodes.length &&
        selectedCharacterCodes.every((item) => auditCharacterCodes.includes(item));
    anchor.correctionText = targetedCorrectionMatchesSelection
        ? normalizeCharacterCorrectionText(audit?.correctionText)
        : "";

    if (codes.some((item) => CHARACTER_BOOST_CORRECTION_CODES.has(item))) {
        anchor.correctionFieldIds = [
            ...new Set([
                ...anchor.correctionFieldIds,
                ...(Array.isArray(audit?.characterFocusFields)
                    ? audit.characterFocusFields
                    : []),
            ]),
        ]
            .filter((fieldId) => CHARACTER_BASELINE_FIELD_ID_SET.has(fieldId))
            .slice(0, 2);
        const baseline = getCurrentCharacterBaseline().baseline;
        anchor.correctionCharacterBaselineHash = baseline
            ? hashStableText(serializeCharacterBaseline(baseline))
            : "";
    } else {
        anchor.correctionFieldIds = [];
        anchor.correctionCharacterBaselineHash = "";
    }
    bumpCorrectionRevision(anchor);

    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreAnchorPanel();
    showGenreAuditToast(
        "info",
        codes.includes(code)
            ? `${GENRE_CORRECTION_LABELS[code]} · 다음 응답 1회 보강을 준비했어요`
            : `${GENRE_CORRECTION_LABELS[code]} · 1회 보강 선택을 해제했어요`
    );
}

// @source-order 276
function resyncLastCountedMessageId() {
    const state = ensureChatState();
    state.genreAnchor.lastCountedMessageId = getLatestAssistantMessageId();
    saveSettingsDebounced();
    updateGenreAnchorPanel();
}

export { buildGenreAuditJsonSchema, buildGenreAuditPrompt, buildGenrePromptText, canQueueManualAuditBoost, cancelPendingGenreCorrection, clearAppliedGenreCorrectionOnUserTurn, createGenreAuditRecord, getAuditOutputInstructions, getAutomaticAuditScope, getBoosterSelection, getGenreAnchorSelection, getScopedAuditSelection, handleGenreResponseReceived, handleGenreUserMessageSent, markPendingGenreAuditCancelled, parseGenreAuditResult, resyncLastCountedMessageId, runGenreDriftAudit, runAutomaticAuditTest, runManualGenreAudit, safelyUpdateGenrePrompt, showGenreAuditToast, toggleManualAuditBoost, updateGenrePrompt };
