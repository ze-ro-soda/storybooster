import { normalizeJevDecisionTrace } from './jev-trace.js';
import { normalizeAuditAnalysis, normalizeAuditComparison, normalizeAuditHistory, markAuditHistoryApplied } from './audit-history.js';
// StoryBooster: core/storage.js
import { CHARACTER_BASELINE_CORRECTION_CODES, CHARACTER_BASELINE_FIELDS, CHARACTER_BASELINE_FIELD_ID_SET, CHARACTER_BASELINE_FIELD_MAX_CHARS, CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS, CHARACTER_BOOST_ANCHOR_MAX_CHARS, CHARACTER_BOOST_CORRECTION_CODES, CHARACTER_CORRECTION_FIELD_FALLBACKS, DEFAULT_AUDIT_INTERVAL, DEFAULT_GENRES, DEFAULT_PLOT_MAX_TOKENS, EVENT_CATEGORIES, GENRE_AUDIT_CODES, GENRE_AUDIT_RESPONSE_LIMIT, MAX_AUDIT_INTERVAL, MAX_CHARACTER_BASELINE_VERSIONS, MAX_PLOT_HISTORY, MAX_PLOT_MAX_TOKENS, MIN_AUDIT_INTERVAL, MIN_PLOT_MAX_TOKENS, MODULE_NAME } from "./constants.js";
import { getCurrentCharacterIdentity, getCurrentChatId, getLatestAssistantMessageId, resolveRoleMacrosForDisplay, snapshotCurrentChatMessages } from "./context.js";
import { preparedChatStates, preparedGenreAnchors, preparedModuleSettings } from "./runtime.js";
import { extension_settings, saveSettingsDebounced } from "./sillytavern.js";
import { normalizeCharacterCorrectionText } from "./text.js";
import { invalidateCharacterAuditState } from './character-audit-state.js';

export function normalizeAuditCorrections(value, codes = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(codes)) return {};
    return Object.fromEntries([...new Set(codes)].filter(code => GENRE_AUDIT_CODES.includes(code) && typeof value[code] === 'string')
        .map(code => [code, normalizeCharacterCorrectionText(value[code])]).filter(([, text]) => text.length >= 80));
}

// @source-order 105
function createDefaultModuleSettings() {
    return {
        chats: {},
        customGenres: [],
        customPlotCategories: [],
        plotMaxTokens: DEFAULT_PLOT_MAX_TOKENS,
        outputLanguage: "ko",
        characterCardChangeDetection: true,
        selectedPlotCategoryId: EVENT_CATEGORIES[0].id,
        analysisProfileId: "",
        plotProfileId: "",
        auditInterval: DEFAULT_AUDIT_INTERVAL,
        enabledFeatures: {
            genre: true,
            character: true,
            plot: true,
        },
        characterBaselines: {},
        characterBaselineVersions: {},
        jevEnabled: false,
        jevConsentVersion: 0,
        settingsSchemaVersion: 25,
    };
}

// @source-order 106
function migrateModuleSettings(settings) {
    const previousSchemaVersion = Number.isSafeInteger(
        settings.settingsSchemaVersion
    )
        ? settings.settingsSchemaVersion
        : 0;
    let migrated = false;
    if (previousSchemaVersion < 10) {
        if (settings.plotMaxTokens === 800) {
            settings.plotMaxTokens = DEFAULT_PLOT_MAX_TOKENS;
        }
        migrated = true;
    }
    if (previousSchemaVersion < 12) {
        for (const state of Object.values(settings.chats || {})) {
            if (!state || typeof state !== "object") continue;
            const hadGenre = Boolean(state.genreSelection?.primaryId) ||
                (Array.isArray(state.genres) &&
                    state.genres.some((genre) => genre?.enabled));
            if (!state.characterBoost || typeof state.characterBoost !== "object") {
                // Older versions bundled agency and relationship guidance into
                // the genre prompt. Preserve that behavior for existing chats.
                state.characterBoost = { enabled: hadGenre };
            }
        }
        settings.settingsSchemaVersion = 12;
        migrated = true;
    }
    if (previousSchemaVersion < 13) {
        for (const [key, entry] of Object.entries(
            settings.characterBaselines || {}
        )) {
            const normalized = normalizeCharacterBaseline(entry);
            if (normalized) settings.characterBaselines[key] = normalized;
            else delete settings.characterBaselines[key];
        }
        settings.settingsSchemaVersion = 13;
        migrated = true;
    }
    if (previousSchemaVersion < 14) {
        const legacyOutputLanguage = settings.plotOutputLanguage;
        if (!["ko", "en"].includes(settings.outputLanguage)) {
            settings.outputLanguage = ["ko", "en"].includes(legacyOutputLanguage)
                ? legacyOutputLanguage
                : "ko";
        }
        settings.settingsSchemaVersion = 14;
        migrated = true;
    }
    if (previousSchemaVersion < 15) {
        if (
            !settings.enabledFeatures ||
            typeof settings.enabledFeatures !== "object"
        ) {
            settings.enabledFeatures = {};
        }
        for (const feature of ["genre", "character", "plot"]) {
            if (typeof settings.enabledFeatures[feature] !== "boolean") {
                settings.enabledFeatures[feature] = true;
            }
        }
        settings.settingsSchemaVersion = 15;
        migrated = true;
    }
    if (previousSchemaVersion < 16) {
        const legacyProfileId =
            typeof settings.backgroundProfileId === "string"
                ? settings.backgroundProfileId
                : "";
        if (typeof settings.analysisProfileId !== "string") {
            settings.analysisProfileId = legacyProfileId;
        }
        if (typeof settings.plotProfileId !== "string") {
            settings.plotProfileId = legacyProfileId;
        }
        settings.settingsSchemaVersion = 16;
        migrated = true;
    }
    if (previousSchemaVersion < 17) {
        const legacyLanguage = ["ko", "en"].includes(settings.outputLanguage)
            ? settings.outputLanguage
            : "ko";
        settings.characterCardChangeDetection = true;
        for (const [key, entry] of Object.entries(
            settings.characterBaselines || {}
        )) {
            const normalized = normalizeCharacterBaseline(entry);
            if (!normalized) continue;
            for (const field of Object.values(normalized.fields)) {
                if (!field.language) field.language = legacyLanguage;
            }
            if (normalized.boostAnchor) {
                normalized.boostAnchorDisplay ||= normalized.boostAnchor;
                normalized.boostAnchorDisplayLanguage ||= "en";
                normalized.boostAnchorUpdatedAt ||=
                    normalized.updatedAt || Date.now();
            }
            settings.characterBaselines[key] = normalized;
        }
        settings.settingsSchemaVersion = 17;
        migrated = true;
    }
    if (previousSchemaVersion < 18) {
        for (const state of Object.values(settings.chats || {})) {
            if (
                !state?.characterBoost ||
                typeof state.characterBoost !== "object"
            ) {
                continue;
            }
            // This legacy flag was superseded by the global feature toggle and
            // current anchor readiness. It no longer controls any behavior.
            delete state.characterBoost.enabled;
        }
        settings.settingsSchemaVersion = 18;
        migrated = true;
    }
    if (previousSchemaVersion < 19) {
        for (const state of Object.values(settings.chats || {})) {
            if (!state || typeof state !== "object") continue;
            // Secret mode is deliberately opt-in for every existing chat.
            state.plotSecretMode = false;
        }
        settings.settingsSchemaVersion = 19;
        migrated = true;
    }
    if (previousSchemaVersion < 20) {
        // Version 20 expands audit ratings with an intermediate attention state
        // and stores stronger positive/failure evidence for later inspection.
        settings.settingsSchemaVersion = 20;
        migrated = true;
    }
    if (previousSchemaVersion < 21) {
        // Version 21 tracks whether a pending one-response correction was
        // already armed when generation began. This prevents an audit that
        // finishes mid-generation from claiming that response as corrected.
        settings.settingsSchemaVersion = 21;
        migrated = true;
    }
    if (previousSchemaVersion < 22) {
        // Version 22 adds complete, user-selectable character baseline
        // revisions. Existing baselines remain the protected original.
        if (
            !settings.characterBaselineVersions ||
            typeof settings.characterBaselineVersions !== "object" ||
            Array.isArray(settings.characterBaselineVersions)
        ) {
            settings.characterBaselineVersions = {};
        }
        for (const state of Object.values(settings.chats || {})) {
            if (!state || typeof state !== "object") continue;
            if (!state.characterBoost || typeof state.characterBoost !== "object") {
                state.characterBoost = {};
            }
            if (typeof state.characterBoost.baselineVersionId !== "string") {
                state.characterBoost.baselineVersionId = "";
            }
        }
        settings.settingsSchemaVersion = 22;
        migrated = true;
    }

    if (previousSchemaVersion < 23) {
        settings.jevEnabled = false;
        for (const state of Object.values(settings.chats || {})) {
            if (state && typeof state === 'object') state.automaticPlot = { enabled: false, lastAppliedCount: 0, status: 'idle' };
        }
        settings.settingsSchemaVersion = 23;
        migrated = true;
    }
    if (previousSchemaVersion < 24) {
        for (const state of Object.values(settings.chats || {})) {
            if (state?.automaticPlot) delete state.automaticPlot.cooldownReplies;
        }
        settings.settingsSchemaVersion = 24;
        migrated = true;
    }
    if (previousSchemaVersion < 25) {
        // Require acceptance of the new one-line data/cost disclosure.
        settings.jevEnabled = false;
        settings.jevConsentVersion = 0;
        settings.settingsSchemaVersion = 25;
        migrated = true;
    }
    return migrated;
}

// @source-order 107
function normalizeModuleSettings(settings) {
    if (typeof settings.jevEnabled !== "boolean") settings.jevEnabled = false;
    if (settings.jevConsentVersion !== 1) {
        settings.jevConsentVersion = 0;
        settings.jevEnabled = false;
    }
    if (!settings.chats || typeof settings.chats !== "object" || Array.isArray(settings.chats)) {
        settings.chats = {};
    }
    if (!Array.isArray(settings.customGenres)) settings.customGenres = [];
    if (!Array.isArray(settings.customPlotCategories)) {
        settings.customPlotCategories = [];
    }
    if (
        !settings.characterBaselines ||
        typeof settings.characterBaselines !== "object" ||
        Array.isArray(settings.characterBaselines)
    ) {
        settings.characterBaselines = {};
    }
    if (
        !settings.characterBaselineVersions ||
        typeof settings.characterBaselineVersions !== "object" ||
        Array.isArray(settings.characterBaselineVersions)
    ) {
        settings.characterBaselineVersions = {};
    }
    for (const [identityKey, value] of Object.entries(
        settings.characterBaselineVersions
    )) {
        const normalized = normalizeCharacterBaselineVersionStore(value);
        if (Object.keys(normalized.versions).length) {
            settings.characterBaselineVersions[identityKey] = normalized;
        } else {
            delete settings.characterBaselineVersions[identityKey];
        }
    }
    if (
        !Number.isSafeInteger(settings.plotMaxTokens) ||
        settings.plotMaxTokens < MIN_PLOT_MAX_TOKENS
    ) {
        settings.plotMaxTokens = DEFAULT_PLOT_MAX_TOKENS;
    } else if (settings.plotMaxTokens > MAX_PLOT_MAX_TOKENS) {
        settings.plotMaxTokens = MAX_PLOT_MAX_TOKENS;
    }
    if (typeof settings.analysisProfileId !== "string") settings.analysisProfileId = "";
    if (typeof settings.plotProfileId !== "string") settings.plotProfileId = "";
    if (!["ko", "en"].includes(settings.outputLanguage)) settings.outputLanguage = "ko";
    if (typeof settings.characterCardChangeDetection !== "boolean") {
        settings.characterCardChangeDetection = true;
    }
    if (
        !settings.enabledFeatures ||
        typeof settings.enabledFeatures !== "object"
    ) {
        settings.enabledFeatures = {};
    }
    for (const feature of ["genre", "character", "plot"]) {
        if (typeof settings.enabledFeatures[feature] !== "boolean") {
            settings.enabledFeatures[feature] = true;
        }
    }
    const currentChatAuditInterval =
        settings.chats[getCurrentChatId()]?.genreAnchor?.auditInterval;
    const configuredAuditInterval = settings.auditInterval;
    const isValidAuditInterval = (value) =>
        Number.isSafeInteger(value) &&
        (value === 0 ||
            (value >= MIN_AUDIT_INTERVAL && value <= MAX_AUDIT_INTERVAL));
    if (!isValidAuditInterval(configuredAuditInterval)) {
        settings.auditInterval = isValidAuditInterval(currentChatAuditInterval)
            ? currentChatAuditInterval
            : DEFAULT_AUDIT_INTERVAL;
    }

    settings.customGenres = settings.customGenres
            .filter((genre) => genre && typeof genre.id === "string" && typeof genre.label === "string")
            .map((genre) => ({
                id: genre.id,
                label: genre.label.trim().slice(0, 50),
                emoji: "✨",
                group: "custom",
                description: String(genre.description || "").trim().slice(0, 500),
            }))
            .filter((genre) => genre.label);

    settings.customPlotCategories = settings.customPlotCategories
            .filter(
                (category) =>
                    category &&
                    typeof category.id === "string" &&
                    typeof category.label === "string"
            )
            .map((category) => ({
                id: category.id,
                label: category.label.trim().slice(0, 40),
                emoji: String(category.emoji || "✨").trim().slice(0, 8) || "✨",
                direction: String(category.direction || "").trim().slice(0, 500),
                custom: true,
            }))
            .filter((category) => category.label);

    const availablePlotCategoryIds = new Set([
        ...EVENT_CATEGORIES.map((category) => category.id),
        ...settings.customPlotCategories.map((category) => category.id),
    ]);
    if (
        typeof settings.selectedPlotCategoryId !== "string" ||
        !availablePlotCategoryIds.has(settings.selectedPlotCategoryId)
    ) {
        settings.selectedPlotCategoryId = EVENT_CATEGORIES[0].id;
    }
}

// @source-order 108
function ensureModuleSettings() {
    let settings = extension_settings[MODULE_NAME];
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        settings = createDefaultModuleSettings();
        extension_settings[MODULE_NAME] = settings;
    }

    if (!preparedModuleSettings.has(settings)) {
        // Establish the collection containers before legacy migrations inspect
        // them, then perform the full normalization exactly once per object.
        if (!settings.chats || typeof settings.chats !== "object") settings.chats = {};
        if (!Array.isArray(settings.customGenres)) settings.customGenres = [];
        if (!Array.isArray(settings.customPlotCategories)) settings.customPlotCategories = [];
        if (
            !settings.characterBaselines ||
            typeof settings.characterBaselines !== "object" ||
            Array.isArray(settings.characterBaselines)
        ) {
            settings.characterBaselines = {};
        }
        if (
            !settings.characterBaselineVersions ||
            typeof settings.characterBaselineVersions !== "object" ||
            Array.isArray(settings.characterBaselineVersions)
        ) {
            settings.characterBaselineVersions = {};
        }
        const migrated = migrateModuleSettings(settings);
        normalizeModuleSettings(settings);
        preparedModuleSettings.add(settings);
        if (migrated) saveSettingsDebounced();
    }

    return settings;
}

// @source-order 109
function isBoosterFeatureEnabled(feature) {
    return ensureModuleSettings().enabledFeatures?.[feature] !== false;
}

// @source-order 110
function getGlobalAuditInterval() {
    return ensureModuleSettings().auditInterval;
}

// @source-order 112
function getAvailableGenres() {
    const settings = ensureModuleSettings();
    return [
        ...DEFAULT_GENRES.map((genre) => ({ ...genre })),
        ...settings.customGenres.map((genre) => ({ ...genre })),
    ];
}

// @source-order 113
function getGenrePromptLabel(genre) {
    return String(genre?.promptLabel || genre?.label || "").trim();
}

// @source-order 114
function getAvailablePlotCategories() {
    const settings = ensureModuleSettings();
    return [
        ...EVENT_CATEGORIES.map((category) => ({ ...category, custom: false })),
        ...settings.customPlotCategories.map((category) => ({ ...category })),
    ];
}

// @source-order 115
function getSelectedPlotCategory() {
    const settings = ensureModuleSettings();
    const categories = getAvailablePlotCategories();
    return (
        categories.find(
            (category) => category.id === settings.selectedPlotCategoryId
        ) || categories[0]
    );
}

// @source-order 116
function getRandomPlotCategory() {
    const categories = getAvailablePlotCategories();
    if (!categories.length) return null;
    return categories[Math.floor(Math.random() * categories.length)] || null;
}

// @source-order 117
function normalizeGenreSelection(state) {
    const availableIds = new Set(getAvailableGenres().map((genre) => genre.id));

    if (!state.genreSelection || typeof state.genreSelection !== "object") {
        const legacyIds = Array.isArray(state.genres)
            ? state.genres
                  .filter((genre) => genre?.enabled && availableIds.has(genre.id))
                  .map((genre) => genre.id)
            : [];

        state.genreSelection = {
            primaryId: legacyIds[0] || null,
            supportIds: legacyIds.slice(1, 2),
        };
    }

    const primaryId =
        typeof state.genreSelection.primaryId === "string" &&
        availableIds.has(state.genreSelection.primaryId)
            ? state.genreSelection.primaryId
            : null;
    const rawSupportIds = Array.isArray(state.genreSelection.supportIds)
        ? state.genreSelection.supportIds
        : [];
    const supportIds = [];

    for (const id of rawSupportIds) {
        if (
            typeof id === "string" &&
            availableIds.has(id) &&
            id !== primaryId &&
            !supportIds.includes(id)
        ) {
            supportIds.push(id);
        }
        if (supportIds.length === 1) break;
    }

    state.genreSelection = { primaryId, supportIds };
    return state.genreSelection;
}

// @source-order 118
function normalizePlotHistory(state) {
    const rawHistory = Array.isArray(state.plotHistory) ? state.plotHistory : [];
    state.plotHistory = rawHistory
        .filter(
            (entry) =>
                entry &&
                typeof entry === "object" &&
                typeof entry.text === "string" &&
                entry.text.trim()
        )
        .map((entry, index) => ({
            id:
                typeof entry.id === "string" && entry.id
                    ? entry.id
                    : `legacy_plot_${Date.now()}_${index}`,
            text: entry.text.trim(),
            createdAt: Number.isFinite(Number(entry.createdAt))
                ? Number(entry.createdAt)
                : Date.now() - index,
            mode: entry.mode === "guided" ? "guided" : "free",
            categoryId:
                typeof entry.categoryId === "string" ? entry.categoryId : "",
            userIdea:
                typeof entry.userIdea === "string"
                    ? entry.userIdea.slice(0, 2000)
                    : "",
            surpriseType: ["secret", "random", "crazy"].includes(
                entry.surpriseType
            )
                ? entry.surpriseType
                : "",
        }))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_PLOT_HISTORY);
    return state.plotHistory;
}

// @source-order 119
function ensureChatState(chatId = getCurrentChatId()) {
    const moduleSettings = ensureModuleSettings();
    const chats = moduleSettings.chats;

    if (!chats[chatId]) {
        chats[chatId] = {
            genres: DEFAULT_GENRES.map((g) => ({ ...g })),
            genreSelection: {
                primaryId: null,
                supportIds: [],
            },
            plotHistory: [],
            plotSecretMode: false,
            characterBoost: {},
            genreAnchor: {
                responseCount: 0,
                correctionCodes: [],
                correctionText: "",
            correctionByCode: {},
                correctionFieldIds: [],
                correctionCharacterBaselineHash: "",
                correctionRemaining: 0,
                correctionAppliedMessageId: null,
                correctionArmedRevision: 0,
                correctionRevision: 0,
                auditStatus: "waiting",
                recommendation: null,
                lastAudit: null,
                lastGenreAudit: null,
                lastCharacterAudit: null,
                lastCountedMessageId:
                    chatId === getCurrentChatId()
                        ? getLatestAssistantMessageId()
                        : null,
            },
        };
    }

    const state = chats[chatId];
    if (!preparedChatStates.has(state)) {
        if (!Array.isArray(state.genres)) {
            state.genres = DEFAULT_GENRES.map((g) => ({ ...g }));
        }
        normalizeGenreSelection(state);
        normalizePlotHistory(state);
        if (typeof state.plotSecretMode !== "boolean") {
            state.plotSecretMode = false;
        }
        ensureCharacterBoostState(state);
        preparedChatStates.add(state);
    }
    ensureGenreAnchorState(state);

    return state;
}

// @source-order 120
function ensureCharacterBoostState(state) {
    if (!state.characterBoost || typeof state.characterBoost !== "object") {
        state.characterBoost = {};
    }
    if (typeof state.characterBoost.baselineVersionId !== "string") {
        state.characterBoost.baselineVersionId = "";
    }
    return state.characterBoost;
}

// @source-order 126
function normalizeCharacterBaseline(entry) {
    if (!entry || typeof entry !== "object") return null;
    const rawFields =
        entry.fields && typeof entry.fields === "object" ? entry.fields : {};
    const legacySummary = String(entry.summary || "").trim();
    const fields = {};
    CHARACTER_BASELINE_FIELDS.forEach((definition, index) => {
        const raw = rawFields[definition.id];
        const rawObject = raw && typeof raw === "object" ? raw : null;
        const fallbackText = index === 0 ? legacySummary : "";
        fields[definition.id] = {
            text: String(rawObject?.text ?? raw ?? fallbackText)
                .trim()
                .slice(0, CHARACTER_BASELINE_FIELD_MAX_CHARS),
            pinned: rawObject?.pinned === true,
            language: ["ko", "en"].includes(rawObject?.language)
                ? rawObject.language
                : "",
            source:
                rawObject?.source === "user" ||
                (!rawObject && index === 0 && entry.manuallyEdited === true)
                    ? "user"
                    : "ai",
            updatedAt: Number(rawObject?.updatedAt) || Number(entry.updatedAt) || Date.now(),
        };
    });
    if (!Object.values(fields).some((field) => field.text)) return null;
    return {
        characterName: String(entry.characterName || "").slice(0, 100),
        fields,
        boostAnchor: String(entry.boostAnchor || "")
            .trim()
            .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS),
        boostAnchorDisplay: String(
            entry.boostAnchorDisplay || entry.boostAnchor || ""
        )
            .trim()
            .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS),
        boostAnchorDisplayLanguage: ["ko", "en"].includes(
            entry.boostAnchorDisplayLanguage
        )
            ? entry.boostAnchorDisplayLanguage
            : entry.boostAnchor
              ? "en"
              : "",
        boostAnchorUpdatedAt:
            Number(entry.boostAnchorUpdatedAt) ||
            (entry.boostAnchor ? Number(entry.updatedAt) || Date.now() : 0),
        boostAnchorNeedsRefresh: entry.boostAnchorNeedsRefresh === true,
        sourceHash: String(entry.sourceHash || "").slice(0, 100),
        notifiedSourceHash: String(entry.notifiedSourceHash || "").slice(0, 100),
        updatedAt: Number(entry.updatedAt) || Date.now(),
    };
}

// @source-order 127
function normalizeCharacterBaselineVersionStore(value) {
    const raw = value && typeof value === "object" ? value : {};
    const rawVersions =
        raw.versions && typeof raw.versions === "object" &&
        !Array.isArray(raw.versions)
            ? raw.versions
            : {};
    const versions = {};
    Object.entries(rawVersions)
        .map(([key, entry]) => {
            const baseline = normalizeCharacterBaseline(entry?.baseline);
            if (!baseline) return null;
            const id = String(entry?.id || key).trim().slice(0, 100);
            if (!id) return null;
            return {
                id,
                label:
                    String(entry?.label || "갱신본")
                        .trim()
                        .slice(0, CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS) ||
                    "갱신본",
                baseline,
                parentVersionId: String(entry?.parentVersionId || "").slice(
                    0,
                    100
                ),
                revisionMode: ["directed", "automatic"].includes(
                    entry?.revisionMode
                )
                    ? entry.revisionMode
                    : "",
                evidenceLevel: ["strong", "partial", "limited"].includes(
                    entry?.evidenceLevel
                )
                    ? entry.evidenceLevel
                    : "",
                createdAt: Number(entry?.createdAt) || Date.now(),
                updatedAt:
                    Number(entry?.updatedAt) ||
                    Number(baseline.updatedAt) ||
                    Date.now(),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-MAX_CHARACTER_BASELINE_VERSIONS)
        .forEach((entry) => {
            versions[entry.id] = entry;
        });
    const inferredNextNumber =
        Object.values(versions).reduce((highest, entry) => {
            const match = String(entry.label || "").match(/^(\d+)번 갱신$/);
            return match ? Math.max(highest, Number(match[1]) + 1) : highest;
        }, 1) || 1;
    return {
        nextNumber: Math.max(
            inferredNextNumber,
            Number.isSafeInteger(raw.nextNumber) ? raw.nextNumber : 1
        ),
        versions,
    };
}

// @source-order 128
function getCharacterBaselineVersionStore(identityKey, { create = false } = {}) {
    const key = String(identityKey || "");
    if (!key) return null;
    const settings = ensureModuleSettings();
    const existing = settings.characterBaselineVersions[key];
    if (!existing && !create) {
        return { nextNumber: 1, versions: {} };
    }
    const normalized = normalizeCharacterBaselineVersionStore(existing);
    if (create || Object.keys(normalized.versions).length) {
        settings.characterBaselineVersions[key] = normalized;
    }
    return normalized;
}

// @source-order 129
function getCharacterBaselineVersion(identityKey, versionId = "") {
    const settings = ensureModuleSettings();
    const id = String(versionId || "");
    if (!id) {
        return normalizeCharacterBaseline(settings.characterBaselines[identityKey]);
    }
    const store = getCharacterBaselineVersionStore(identityKey);
    return normalizeCharacterBaseline(store?.versions?.[id]?.baseline);
}

// @source-order 130
function writeCharacterBaselineVersion(identity, baseline, versionId = "") {
    const normalized = normalizeCharacterBaseline(baseline);
    if (!identity?.key || !normalized) return false;
    normalized.characterName = identity.name || normalized.characterName;
    const settings = ensureModuleSettings();
    if (!versionId) {
        settings.characterBaselines[identity.key] = normalized;
        return true;
    }
    const store = getCharacterBaselineVersionStore(identity.key, {
        create: true,
    });
    const record = store.versions[versionId];
    if (!record) return false;
    record.baseline = normalized;
    record.updatedAt = Date.now();
    settings.characterBaselineVersions[identity.key] = store;
    return true;
}

// @source-order 131
function createCharacterBaselineVersion(
    identity,
    baseline,
    {
        chatId = getCurrentChatId(),
        parentVersionId = "",
        label = "",
        revisionMode = "",
        evidenceLevel = "",
    } = {}
) {
    const normalized = normalizeCharacterBaseline(baseline);
    if (!identity?.key || !normalized) return null;
    const settings = ensureModuleSettings();
    const store = getCharacterBaselineVersionStore(identity.key, {
        create: true,
    });
    if (Object.keys(store.versions).length >= MAX_CHARACTER_BASELINE_VERSIONS) {
        throw new Error(
            `갱신본은 캐릭터당 최대 ${MAX_CHARACTER_BASELINE_VERSIONS}개까지 저장할 수 있습니다.`
        );
    }
    const number = store.nextNumber;
    const id = `revision_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    const now = Date.now();
    const record = {
        id,
        label:
            String(label || `${number}번 갱신`)
                .trim()
                .slice(0, CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS) ||
            `${number}번 갱신`,
        baseline: {
            ...normalized,
            characterName: identity.name || normalized.characterName,
            updatedAt: now,
        },
        parentVersionId: String(parentVersionId || "").slice(0, 100),
        revisionMode: ["directed", "automatic"].includes(revisionMode)
            ? revisionMode
            : "",
        evidenceLevel: ["strong", "partial", "limited"].includes(evidenceLevel)
            ? evidenceLevel
            : "",
        createdAt: now,
        updatedAt: now,
    };
    store.nextNumber = number + 1;
    store.versions[id] = record;
    settings.characterBaselineVersions[identity.key] = store;
    const boostState = ensureCharacterBoostState(ensureChatState(chatId));
    boostState.baselineVersionId = id;
    return record;
}

// @source-order 132
function getCharacterBaselineVersionOptions(identityKey) {
    const store = getCharacterBaselineVersionStore(identityKey);
    return Object.values(store?.versions || {}).sort(
        (a, b) => a.createdAt - b.createdAt
    );
}

// @source-order 133
function createEmptyCharacterBaseline(identity) {
    const fields = Object.fromEntries(
        CHARACTER_BASELINE_FIELDS.map((definition) => [
            definition.id,
            {
                text: "",
                pinned: false,
                language: "",
                source: "ai",
                updatedAt: Date.now(),
            },
        ])
    );
    return {
        characterName: String(identity?.name || "").slice(0, 100),
        fields,
        boostAnchor: "",
        boostAnchorDisplay: "",
        boostAnchorDisplayLanguage: "",
        boostAnchorUpdatedAt: 0,
        boostAnchorNeedsRefresh: false,
        sourceHash: String(identity?.sourceHash || ""),
        notifiedSourceHash: "",
        updatedAt: Date.now(),
    };
}

// @source-order 134
function serializeCharacterBaseline(baseline, fieldIds = null) {
    if (!baseline?.fields) return "";
    const allowedIds = Array.isArray(fieldIds)
        ? new Set(fieldIds.filter((id) => CHARACTER_BASELINE_FIELD_ID_SET.has(id)))
        : null;
    return CHARACTER_BASELINE_FIELDS.filter(
        (definition) => !allowedIds || allowedIds.has(definition.id)
    ).map((definition) => {
        const text = String(baseline.fields[definition.id]?.text || "").trim();
        return text ? `[${definition.label}]\n${text}` : "";
    })
        .filter(Boolean)
        .join("\n\n");
}

// @source-order 135
function resolveCharacterCorrectionFieldIds(
    baseline,
    requestedFieldIds,
    correctionCodes
) {
    if (!baseline?.fields) return [];
    const hasCharacterCorrection = (
        Array.isArray(correctionCodes) ? correctionCodes : []
    ).some((code) => CHARACTER_BASELINE_CORRECTION_CODES.has(code));
    if (!hasCharacterCorrection) return [];
    const hasText = (fieldId) =>
        Boolean(String(baseline.fields[fieldId]?.text || "").trim());
    const resolved = [];
    const add = (fieldId) => {
        if (
            resolved.length < 2 &&
            CHARACTER_BASELINE_FIELD_ID_SET.has(fieldId) &&
            hasText(fieldId) &&
            !resolved.includes(fieldId)
        ) {
            resolved.push(fieldId);
        }
    };
    (Array.isArray(requestedFieldIds) ? requestedFieldIds : []).forEach(add);
    (Array.isArray(correctionCodes) ? correctionCodes : []).forEach((code) => {
        (CHARACTER_CORRECTION_FIELD_FALLBACKS[code] || []).forEach(add);
    });
    return resolved.slice(0, 2);
}

// @source-order 136
function getCurrentCharacterBaseline(chatId = getCurrentChatId()) {
    const identity = getCurrentCharacterIdentity();
    if (!identity) return { status: "unavailable", identity: null, baseline: null };
    const boostState = ensureCharacterBoostState(ensureChatState(chatId));
    const requestedVersionId = String(boostState.baselineVersionId || "");
    let versionId = requestedVersionId;
    let baseline = getCharacterBaselineVersion(identity.key, versionId);
    if (versionId && !baseline) {
        versionId = "";
        boostState.baselineVersionId = "";
        invalidateCharacterAuditState(ensureGenreAnchorState(ensureChatState(chatId)), getGlobalAuditInterval());
        baseline = getCharacterBaselineVersion(identity.key, "");
        saveSettingsDebounced();
    }
    const version = versionId
        ? getCharacterBaselineVersionStore(identity.key)?.versions?.[versionId]
        : null;
    return {
        identity,
        baseline,
        versionId,
        versionLabel: version?.label || "원본",
        isOriginal: !versionId,
        // Character-card edits do not automatically invalidate a saved
        // baseline or pause its anchor. Users explicitly choose when to run a
        // new full summary; sourceHash is retained only as source metadata.
        status: baseline ? "current" : "missing",
    };
}

// @source-order 141
function getCharacterCardChangeStatus(
    baselineState = getCurrentCharacterBaseline()
) {
    const enabled = ensureModuleSettings().characterCardChangeDetection === true;
    const identity = baselineState?.identity || null;
    const baseline = baselineState?.baseline || null;
    const currentHash = String(identity?.sourceHash || "");
    const savedHash = String(baseline?.sourceHash || "");
    const changed = Boolean(
        enabled && baseline && currentHash && savedHash && currentHash !== savedHash
    );
    return {
        enabled,
        changed,
        identity,
        baseline,
        versionId: String(baselineState?.versionId || ""),
        currentHash,
        alreadyNotified:
            changed && baseline?.notifiedSourceHash === currentHash,
    };
}

// @source-order 144
function getCharacterAnchorDisplayValue(baseline) {
    if (!baseline) return "";
    const language = ensureModuleSettings().outputLanguage;
    if (
        language === "ko" &&
        baseline.boostAnchorDisplayLanguage === "ko" &&
        baseline.boostAnchorDisplay
    ) {
        return resolveRoleMacrosForDisplay(baseline.boostAnchorDisplay);
    }
    return resolveRoleMacrosForDisplay(baseline.boostAnchor || "");
}

// @source-order 145
function hasCharacterDisplayLanguageMismatch(baseline) {
    if (!baseline) return false;
    const language = ensureModuleSettings().outputLanguage;
    const fieldMismatch = CHARACTER_BASELINE_FIELDS.some((definition) => {
        const field = baseline.fields?.[definition.id];
        return Boolean(field?.text && field.language && field.language !== language);
    });
    const anchorMismatch = Boolean(
        baseline.boostAnchor && baseline.boostAnchorDisplayLanguage !== language
    );
    return fieldMismatch || anchorMismatch;
}

// @source-order 146
function formatSavedAt(timestamp) {
    const value = Number(timestamp);
    if (!value) return "";
    try {
        return new Intl.DateTimeFormat(
            ensureModuleSettings().outputLanguage === "en" ? "en-US" : "ko-KR",
            {
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
            }
        ).format(new Date(value));
    } catch {
        return new Date(value).toLocaleString();
    }
}

// @source-order 147
function getCharacterBoosterReadiness(
    baselineState = getCurrentCharacterBaseline()
) {
    const featureEnabled = isBoosterFeatureEnabled("character");
    const baseline = baselineState?.baseline || null;
    const baselineAvailable = Boolean(baseline);
    const boostAnchor = String(baseline?.boostAnchor || "")
        .trim()
        .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS);
    const anchorContentStale = Boolean(
        baselineAvailable && baseline.boostAnchorNeedsRefresh
    );
    const needsAnchorRefresh = anchorContentStale;
    return {
        featureEnabled,
        baselineAvailable,
        boostAnchor,
        anchorContentStale,
        needsAnchorRefresh,
        boostActive: Boolean(
            featureEnabled &&
                baselineAvailable &&
                boostAnchor &&
                !needsAnchorRefresh &&
                baselineState.status === "current"
        ),
    };
}

// @source-order 257
function normalizeStoredAuditEvidenceArray(value) {
    return Array.isArray(value)
        ? value
              .map((item) => Number(item))
              .filter(
                  (item) =>
                      Number.isSafeInteger(item) &&
                      item >= 1 &&
                      item <= GENRE_AUDIT_RESPONSE_LIMIT
              )
              .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
        : [];
}

// @source-order 258
function normalizeGenreAuditRecord(record) {
    if (!record || typeof record !== "object") return null;
    const allowedStatuses = [
        "pending",
        "applied",
        "cancelled",
        "attention",
        "deferred",
        "stable",
        "error",
    ];
    const ratings =
        record.ratings && typeof record.ratings === "object"
            ? {
                  primary_genre: ["present", "attention", "weak", "na"].includes(
                      record.ratings.primary_genre
                  )
                      ? record.ratings.primary_genre
                      : "na",
                  genre_expression: ["present", "attention", "weak", "na"].includes(
                      record.ratings.genre_expression
                  )
                      ? record.ratings.genre_expression
                      : "na",
                  support_texture: ["present", "attention", "dormant", "weak", "na"].includes(
                      record.ratings.support_texture
                  )
                      ? record.ratings.support_texture
                      : "na",
                  scene_density: ["present", "attention", "weak", "na"].includes(
                      record.ratings.scene_density
                  )
                      ? record.ratings.scene_density
                      : ["present", "weak"].includes(record.ratings.description)
                        ? record.ratings.description
                        : "na",
                  character_consistency: [
                      "stable",
                      "attention",
                      "drifted",
                      "unavailable",
                      "na",
                  ].includes(record.ratings.character_consistency)
                      ? record.ratings.character_consistency
                      : "unavailable",
                  character_interpretation: [
                      "stable",
                      "attention",
                      "biased",
                      "unavailable",
                      "na",
                  ].includes(record.ratings.character_interpretation)
                      ? record.ratings.character_interpretation
                      : "unavailable",
                  char_agency: ["present", "attention", "weak", "na"].includes(
                      record.ratings.char_agency
                  )
                      ? record.ratings.char_agency
                      : "na",
                  relationship: ["present", "attention", "weak", "na"].includes(
                      record.ratings.relationship
                  )
                      ? record.ratings.relationship
                      : "na",
                  continuity: ["present", "attention", "weak", "na"].includes(
                      record.ratings.continuity
                  )
                      ? record.ratings.continuity
                      : "na",
                  repetition: ["stable", "attention", "weak", "na"].includes(
                      record.ratings.repetition
                  )
                      ? record.ratings.repetition
                      : record.ratings.repetition === true
                        ? "weak"
                        : record.ratings.repetition === false
                          ? "stable"
                          : "na",
              }
            : null;

    return {
        id: String(record.id || `audit-${Date.now()}`),
        createdAt: Number.isFinite(Number(record.createdAt))
            ? Number(record.createdAt)
            : Date.now(),
        mode: record.mode === "manual" ? "manual" : "auto",
        scope: ["genre", "character"].includes(record.scope)
            ? record.scope
            : "combined",
        primaryId: String(record.primaryId || ""),
        primaryLabel: String(record.primaryLabel || "").slice(0, 100),
        supportId: String(record.supportId || ""),
        supportLabel: String(record.supportLabel || "").slice(0, 100),
        characterIncluded: record.characterIncluded === true,
        ratings,
        evidence:
            record.evidence && typeof record.evidence === "object"
                ? {
                      primary: Array.isArray(record.evidence.primary)
                          ? record.evidence.primary
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      primaryFailure: normalizeStoredAuditEvidenceArray(
                          record.evidence.primaryFailure
                      ),
                      genreExpression: Array.isArray(
                          record.evidence.genreExpression
                      )
                          ? record.evidence.genreExpression
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      genreExpressionFailure: normalizeStoredAuditEvidenceArray(
                          record.evidence.genreExpressionFailure
                      ),
                      support: Array.isArray(record.evidence.support)
                          ? record.evidence.support
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      supportOpportunity: Array.isArray(
                          record.evidence.supportOpportunity
                      )
                          ? record.evidence.supportOpportunity
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      supportIdentifiable:
                          record.evidence.supportIdentifiable === true,
                      sceneDensity: Array.isArray(
                          record.evidence.sceneDensity
                      )
                          ? record.evidence.sceneDensity
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      sceneDensityFailure: normalizeStoredAuditEvidenceArray(
                          record.evidence.sceneDensityFailure
                      ),
                      characterConsistencyPositive:
                          normalizeStoredAuditEvidenceArray(
                              record.evidence.characterConsistencyPositive
                          ),
                      characterConsistency: Array.isArray(
                          record.evidence.characterConsistency
                      )
                          ? record.evidence.characterConsistency
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      characterInterpretationPositive:
                          normalizeStoredAuditEvidenceArray(
                              record.evidence.characterInterpretationPositive
                          ),
                      characterInterpretation: Array.isArray(
                          record.evidence.characterInterpretation
                      )
                          ? record.evidence.characterInterpretation
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      characterAgency: Array.isArray(
                          record.evidence.characterAgency
                      )
                          ? record.evidence.characterAgency
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      characterAgencyFailure: normalizeStoredAuditEvidenceArray(
                          record.evidence.characterAgencyFailure
                      ),
                      relationship: Array.isArray(
                          record.evidence.relationship
                      )
                          ? record.evidence.relationship
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      relationshipFailure: normalizeStoredAuditEvidenceArray(
                          record.evidence.relationshipFailure
                      ),
                      continuity: Array.isArray(record.evidence.continuity)
                          ? record.evidence.continuity
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      continuityFailure: normalizeStoredAuditEvidenceArray(
                          record.evidence.continuityFailure
                      ),
                      repetition: Array.isArray(record.evidence.repetition)
                          ? record.evidence.repetition
                                .map((value) => Number(value))
                                .filter(
                                    (value) =>
                                        Number.isSafeInteger(value) &&
                                        value >= 1 &&
                                        value <= GENRE_AUDIT_RESPONSE_LIMIT
                                )
                                .slice(0, GENRE_AUDIT_RESPONSE_LIMIT)
                          : [],
                      reviewedResponses: Math.max(
                          0,
                          Math.min(
                              GENRE_AUDIT_RESPONSE_LIMIT,
                              Number(record.evidence.reviewedResponses) || 0
                          )
                      ),
                  }
                : null,
        reasons: Object.fromEntries(
            GENRE_AUDIT_CODES.map((code) => [
                code,
                String(record.reasons?.[code] || "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 300),
            ])
        ),
        correctionCodes: Array.isArray(record.correctionCodes)
            ? record.correctionCodes
                  .filter((code) => GENRE_AUDIT_CODES.includes(code))
                  .slice(0, 2)
            : [],
        analysis: normalizeAuditAnalysis(record.analysis),
        comparison: normalizeAuditComparison(record.comparison),
        engine: record.engine === 'jev' ? 'jev' : 'legacy',
        decisionTrace: record.engine === 'jev' ? normalizeJevDecisionTrace(record.decisionTrace) : {},
        jevFallback: record.jevFallback === true,
        correctionGeneration: ['generated', 'template_fallback'].includes(record.correctionGeneration) ? record.correctionGeneration : '',
        uncertain: Array.isArray(record.uncertain) ? record.uncertain.filter(c => GENRE_AUDIT_CODES.includes(c)) : [],
        correctionByCode: normalizeAuditCorrections(record.correctionByCode, record.correctionCodes || []),
        correctionSummaries: Object.fromEntries((Array.isArray(record.correctionCodes) ? record.correctionCodes : []).filter(code => GENRE_AUDIT_CODES.includes(code) && typeof record.correctionSummaries?.[code] === 'string').slice(0, 2).map(code => [code, record.correctionSummaries[code].trim().slice(0, 140)])),
        feedbackConnection: record.feedbackConnection && typeof record.feedbackConnection === 'object' ? {
            profileName: String(record.feedbackConnection.profileName || '').slice(0, 100),
            model: String(record.feedbackConnection.model || '').slice(0, 150),
        } : null,
        correctionText: normalizeCharacterCorrectionText(record.correctionText),
        characterFocusFields: Array.isArray(record.characterFocusFields)
            ? record.characterFocusFields
                  .filter((fieldId) =>
                      CHARACTER_BASELINE_FIELD_ID_SET.has(fieldId)
                  )
                  .slice(0, 2)
            : [],
        status: record.status === 'stable' && Array.isArray(record.uncertain) && record.uncertain.some(code => GENRE_AUDIT_CODES.includes(code))
            ? 'deferred' : allowedStatuses.includes(record.status)
            ? record.status
            : "stable",
        appliedMessageId: Number.isSafeInteger(record.appliedMessageId)
            ? record.appliedMessageId
            : null,
        connection: {
            source:
                record.connection?.source === "jev" ? "jev" : record.connection?.source === "profile" ? "profile" : "main",
            profileId: String(record.connection?.profileId || ""),
            profileName: String(
                record.connection?.profileName || "현재 채팅 연결"
            ).slice(0, 100),
            model: String(record.connection?.model || "").slice(0, 150),
        },
        errorMessage: String(record.errorMessage || "").slice(0, 300),
    };
}

// @source-order 259
function storeLastAuditRecord(anchor, record, scope = "combined") {
    if (!anchor || !record) return;
    anchor.lastAudit = record;
    const hasGenreResult =
        scope === "genre" ||
        (scope === "combined" && Boolean(record.primaryId));
    const hasCharacterResult =
        scope === "character" ||
        (scope === "combined" &&
            (record.characterIncluded === true ||
                (record.ratings &&
                    [
                        record.ratings.character_consistency,
                        record.ratings.char_agency,
                        record.ratings.relationship,
                    ].some(
                        (rating) => !["na", undefined].includes(rating)
                    ))));
    if (hasGenreResult) anchor.lastGenreAudit = record;
    if (hasCharacterResult) anchor.lastCharacterAudit = record;
}

// @source-order 260
function updateStoredAuditStatus(anchor, status, appliedMessageId = null) {
    const appliedRecordIds = new Set();
    const activeCodes = new Set(anchor?.correctionCodes || []);
    if (!activeCodes.size) return;
    ["lastAudit", "lastGenreAudit", "lastCharacterAudit"].forEach((key) => {
        const record = anchor[key];
        if (
            record?.status !== "pending" ||
            !record.correctionCodes?.some((code) => activeCodes.has(code))
        ) {
            return;
        }
        if (status === "applied") appliedRecordIds.add(record.id);
        record.status = status;
        record.appliedMessageId = Number.isSafeInteger(appliedMessageId)
            ? appliedMessageId
            : null;
    });
    if (status === 'applied') markAuditHistoryApplied(anchor, appliedRecordIds, activeCodes, appliedMessageId, snapshotCurrentChatMessages());
}

// @source-order 261
function ensureGenreAnchorState(state) {
    if (!state.genreAnchor || typeof state.genreAnchor !== "object") {
        state.genreAnchor = {
            responseCount: 0,
            correctionCodes: [],
            correctionText: "",
            correctionByCode: {},
            correctionFieldIds: [],
            correctionCharacterBaselineHash: "",
            correctionRemaining: 0,
            correctionAppliedMessageId: null,
            correctionArmedRevision: 0,
            correctionRevision: 0,
            auditStatus: "waiting",
            recommendation: null,
            lastAudit: null,
            lastGenreAudit: null,
            lastCharacterAudit: null,
            lastCountedMessageId: null,
        };
    }
    if (preparedGenreAnchors.has(state.genreAnchor)) {
        return state.genreAnchor;
    }

    if (
        !Number.isSafeInteger(state.genreAnchor.responseCount) ||
        state.genreAnchor.responseCount < 0
    ) {
        state.genreAnchor.responseCount = 0;
    }
    if (!Array.isArray(state.genreAnchor.correctionCodes)) {
        state.genreAnchor.correctionCodes = [];
    }
    state.genreAnchor.correctionCodes = state.genreAnchor.correctionCodes
        .filter((code) => GENRE_AUDIT_CODES.includes(code))
        .slice(0, 2);
    state.genreAnchor.correctionByCode = normalizeAuditCorrections(state.genreAnchor.correctionByCode, state.genreAnchor.correctionCodes);
    state.genreAnchor.correctionFieldIds = Array.isArray(
        state.genreAnchor.correctionFieldIds
    )
        ? state.genreAnchor.correctionFieldIds
              .filter((fieldId) =>
                  CHARACTER_BASELINE_FIELD_ID_SET.has(fieldId)
              )
              .slice(0, 2)
        : [];
    if (
        !state.genreAnchor.correctionCodes.some((code) =>
            CHARACTER_BASELINE_CORRECTION_CODES.has(code)
        )
    ) {
        state.genreAnchor.correctionFieldIds = [];
    }
    state.genreAnchor.correctionText = normalizeCharacterCorrectionText(
        state.genreAnchor.correctionText
    );
    state.genreAnchor.correctionCharacterBaselineHash = String(
        state.genreAnchor.correctionCharacterBaselineHash || ""
    ).slice(0, 100);
    if (
        !Number.isSafeInteger(state.genreAnchor.correctionRemaining) ||
        state.genreAnchor.correctionRemaining < 0
    ) {
        state.genreAnchor.correctionRemaining = 0;
    }
    if (
        state.genreAnchor.correctionAppliedMessageId !== null &&
        !Number.isSafeInteger(state.genreAnchor.correctionAppliedMessageId)
    ) {
        state.genreAnchor.correctionAppliedMessageId = null;
    }
    if (
        !Number.isSafeInteger(state.genreAnchor.correctionArmedRevision) ||
        state.genreAnchor.correctionArmedRevision < 0
    ) {
        state.genreAnchor.correctionArmedRevision = 0;
    }
    if (
        state.genreAnchor.correctionRemaining <= 0 ||
        state.genreAnchor.correctionAppliedMessageId !== null ||
        !state.genreAnchor.correctionCodes.length
    ) {
        state.genreAnchor.correctionArmedRevision = 0;
    }
    if (
        !Number.isSafeInteger(state.genreAnchor.correctionRevision) ||
        state.genreAnchor.correctionRevision < 0
    ) {
        state.genreAnchor.correctionRevision = 0;
    }
    if (
        ![
            "waiting",
            "monitoring",
            "attention",
            "deferred",
            "stable",
            "reinforcing",
            "error",
        ].includes(
            state.genreAnchor.auditStatus
        )
    ) {
        state.genreAnchor.auditStatus = "waiting";
    }
    if (
        state.genreAnchor.lastCountedMessageId !== null &&
        !Number.isSafeInteger(state.genreAnchor.lastCountedMessageId)
    ) {
        state.genreAnchor.lastCountedMessageId = null;
    }
    if (
        state.genreAnchor.recommendation !== null &&
        (typeof state.genreAnchor.recommendation !== "object" ||
            typeof state.genreAnchor.recommendation.primaryId !== "string")
    ) {
        state.genreAnchor.recommendation = null;
    }
    state.genreAnchor.auditHistory = normalizeAuditHistory(state.genreAnchor.auditHistory);
    state.genreAnchor.lastAudit = normalizeGenreAuditRecord(
        state.genreAnchor.lastAudit
    );
    state.genreAnchor.lastGenreAudit = normalizeGenreAuditRecord(
        state.genreAnchor.lastGenreAudit
    );
    state.genreAnchor.lastCharacterAudit = normalizeGenreAuditRecord(
        state.genreAnchor.lastCharacterAudit
    );
    if (!state.genreAnchor.lastGenreAudit) {
        const legacyAudit = state.genreAnchor.lastAudit;
        if (legacyAudit?.ratings?.primary_genre !== "na") {
            state.genreAnchor.lastGenreAudit = legacyAudit;
        }
    }
    if (!state.genreAnchor.lastCharacterAudit) {
        const legacyAudit = state.genreAnchor.lastAudit;
        if (
            legacyAudit?.ratings &&
            [
                legacyAudit.ratings.character_consistency,
                legacyAudit.ratings.char_agency,
                legacyAudit.ratings.relationship,
            ].some((rating) => !["na", "unavailable", undefined].includes(rating))
        ) {
            state.genreAnchor.lastCharacterAudit = legacyAudit;
        }
    }

    preparedGenreAnchors.add(state.genreAnchor);
    return state.genreAnchor;
}

// @source-order 262
function bumpCorrectionRevision(anchor) {
    if (!anchor) return 0;
    anchor.correctionRevision =
        Number.isSafeInteger(anchor.correctionRevision) &&
        anchor.correctionRevision < Number.MAX_SAFE_INTEGER
            ? anchor.correctionRevision + 1
            : 1;
    return anchor.correctionRevision;
}

// @source-order 263
function reconcilePendingAuditRecords(anchor) {
    if (!anchor) return;
    const activeCodes = new Set(anchor.correctionCodes || []);
    ["lastAudit", "lastGenreAudit", "lastCharacterAudit"].forEach((key) => {
        const record = anchor[key];
        if (record?.status !== "pending") return;
        record.correctionCodes = (record.correctionCodes || []).filter((code) =>
            activeCodes.has(code)
        );
        if (!record.correctionCodes.length) {
            record.status = "cancelled";
            record.appliedMessageId = null;
        }
    });
}

// @source-order 264
function normalizeLiveCorrectionState(
    anchor,
    { emptyStatus = getGlobalAuditInterval() === 0 ? "waiting" : "monitoring" } = {}
) {
    if (!anchor) return;
    anchor.correctionCodes = [...new Set(anchor.correctionCodes || [])]
        .filter((code) => GENRE_AUDIT_CODES.includes(code))
        .slice(0, 2);
    anchor.correctionByCode = normalizeAuditCorrections(anchor.correctionByCode, anchor.correctionCodes);
    const hasCharacterCorrection = anchor.correctionCodes.some((code) =>
        CHARACTER_BOOST_CORRECTION_CODES.has(code)
    );
    if (!hasCharacterCorrection) anchor.correctionText = "";
    if (!hasCharacterCorrection) {
        anchor.correctionFieldIds = [];
        anchor.correctionCharacterBaselineHash = "";
    }
    if (!anchor.correctionCodes.length) {
        anchor.correctionText = "";
        anchor.correctionFieldIds = [];
        anchor.correctionCharacterBaselineHash = "";
        anchor.correctionRemaining = 0;
        anchor.correctionAppliedMessageId = null;
        anchor.correctionArmedRevision = 0;
        anchor.auditStatus = emptyStatus;
        return;
    }

    anchor.correctionRemaining = 1;
    anchor.correctionArmedRevision = 0;
    anchor.auditStatus = "reinforcing";
}

// @source-order 265
function removeLiveCorrectionCodes(anchor, codesToRemove, options = {}) {
    if (!anchor) return false;
    const removalSet =
        codesToRemove instanceof Set ? codesToRemove : new Set(codesToRemove || []);
    const previousCodes = [...(anchor.correctionCodes || [])];
    anchor.correctionCodes = previousCodes.filter((code) => !removalSet.has(code));
    if (anchor.correctionCodes.length === previousCodes.length) return false;
    normalizeLiveCorrectionState(anchor, options);
    reconcilePendingAuditRecords(anchor);
    bumpCorrectionRevision(anchor);
    return true;
}

// @source-order 266
function isPendingGenreCorrectionArmed(anchor) {
    return Boolean(
        anchor &&
            anchor.correctionRemaining > 0 &&
            anchor.correctionAppliedMessageId === null &&
            anchor.correctionArmedRevision > 0 &&
            anchor.correctionArmedRevision === anchor.correctionRevision
    );
}

// @source-order 267
function armPendingGenreCorrectionForNextResponse(
    state = ensureChatState()
) {
    const anchor = ensureGenreAnchorState(state);
    if (
        anchor.correctionRemaining <= 0 ||
        anchor.correctionAppliedMessageId !== null ||
        !anchor.correctionCodes.length
    ) {
        return false;
    }
    if (anchor.correctionArmedRevision === anchor.correctionRevision) {
        return true;
    }
    anchor.correctionArmedRevision = anchor.correctionRevision;
    saveSettingsDebounced();
    return true;
}

// @source-order 268
function markArmedGenreCorrectionApplied(anchor, messageId) {
    if (
        !isPendingGenreCorrectionArmed(anchor) ||
        !Number.isSafeInteger(messageId)
    ) {
        return false;
    }
    anchor.correctionAppliedMessageId = messageId;
    anchor.correctionArmedRevision = 0;
    bumpCorrectionRevision(anchor);
    updateStoredAuditStatus(anchor, "applied", messageId);
    return true;
}

export { armPendingGenreCorrectionForNextResponse, bumpCorrectionRevision, createCharacterBaselineVersion, createDefaultModuleSettings, createEmptyCharacterBaseline, ensureCharacterBoostState, ensureChatState, ensureGenreAnchorState, ensureModuleSettings, formatSavedAt, getAvailableGenres, getAvailablePlotCategories, getCharacterAnchorDisplayValue, getCharacterBaselineVersion, getCharacterBaselineVersionOptions, getCharacterBaselineVersionStore, getCharacterBoosterReadiness, getCharacterCardChangeStatus, getCurrentCharacterBaseline, getGenrePromptLabel, getGlobalAuditInterval, getRandomPlotCategory, getSelectedPlotCategory, hasCharacterDisplayLanguageMismatch, isBoosterFeatureEnabled, isPendingGenreCorrectionArmed, markArmedGenreCorrectionApplied, migrateModuleSettings, normalizeCharacterBaseline, normalizeCharacterBaselineVersionStore, normalizeGenreAuditRecord, normalizeGenreSelection, normalizeLiveCorrectionState, normalizeModuleSettings, normalizePlotHistory, normalizeStoredAuditEvidenceArray, reconcilePendingAuditRecords, removeLiveCorrectionCodes, resolveCharacterCorrectionFieldIds, serializeCharacterBaseline, storeLastAuditRecord, updateStoredAuditStatus, writeCharacterBaselineVersion };
