// 스토리부스터 (StoryBooster)
// SillyTavern extension: persistent (per-chat) genre boosting + AI-generated plot events.
//
// State lives inside extension_settings[MODULE_NAME].chats[chatId] — a per-chat-id bucket
// inside the extension's own global settings object (extension_settings is guaranteed to
// exist across ST versions, unlike chat_metadata whose export name/shape has changed before).
//
// NOTE ON API PATHS:
// SillyTavern's internal module paths have shifted between versions in the past.
// The import paths below are correct for recent (2024~2025) versions where this
// extension lives at: public/scripts/extensions/third-party/<name>/index.js
// If the extension silently fails to appear anywhere (wand menu AND extensions tab),
// open the browser console (F12) — a broken import throws an error there that pinpoints
// exactly which name doesn't exist in your ST build.

import {
    extension_settings,
    getContext,
} from "../../../extensions.js";

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from "../../../../script.js";

const MODULE_NAME = "rp-genre-plot-booster";
const GENRE_PROMPT_KEY = "rp_genre_boost";
const PLOT_PROMPT_KEY = "rp_plot_trigger";

console.log(`[${MODULE_NAME}] script loaded`);

// ----------------------------------------------------------------------
// 1. DATA
// ----------------------------------------------------------------------

const DEFAULT_GENRES = [
    { id: "slice_of_life", label: "Slice of Life", emoji: "🏡", group: "story", enabled: false },
    { id: "romance", label: "Romance", emoji: "❤️", group: "story", enabled: false },
    { id: "drama", label: "Drama", emoji: "🎭", group: "story", enabled: false },
    { id: "mystery", label: "Mystery", emoji: "🕵️", group: "story", enabled: false },
    { id: "action", label: "Action", emoji: "⚡", group: "story", enabled: false },
    { id: "adventure", label: "Adventure", emoji: "🧭", group: "story", enabled: false },
    { id: "horror", label: "Horror", emoji: "👁️", group: "story", enabled: false },
    { id: "comedy", label: "Comedy", emoji: "😂", group: "tone", enabled: false },
    { id: "dark", label: "Dark", emoji: "🌑", group: "tone", enabled: false },
    { id: "healing", label: "Healing", emoji: "🌿", group: "tone", enabled: false },
    { id: "suspense", label: "Suspense", emoji: "⏳", group: "tone", enabled: false },
    { id: "fantasy", label: "Fantasy", emoji: "🧙", group: "world", enabled: false },
    { id: "scifi", label: "Sci-Fi", emoji: "🚀", group: "world", enabled: false },
    { id: "historical", label: "Historical", emoji: "📜", group: "world", enabled: false },
    { id: "supernatural", label: "Supernatural", emoji: "👻", group: "world", enabled: false },
];

const GENRE_GROUPS = Object.freeze([
    { id: "story", label: "이야기 장르" },
    { id: "tone", label: "분위기·톤" },
    { id: "world", label: "세계관" },
    { id: "custom", label: "내가 추가한 장르" },
]);

const GENRE_PROFILES = Object.freeze({
    slice_of_life: {
        core:
            "Give the setting a lived-in quality through routines, ordinary gestures, small errands, and minor coincidences. Let relationships or circumstances shift even during quiet scenes.",
        cues: [
            {
                label: "생활 공간에 작은 변화 만들기",
                prompt:
                    "Introduce a small but concrete change in the immediate environment that invites interaction and makes the setting feel inhabited.",
            },
            {
                label: "일상 속 관계를 한 걸음 움직이기",
                prompt:
                    "Use an ordinary shared activity or practical need to reveal a subtle change in trust, familiarity, or interpersonal distance.",
            },
            {
                label: "사소한 용무에서 선택 만들기",
                prompt:
                    "Let a minor task, interruption, or obligation create a meaningful choice without inflating it into a major crisis.",
            },
            {
                label: "조용한 장면에 여운 남기기",
                prompt:
                    "Allow a quiet moment to alter how the characters perceive the place, each other, or what they should do next.",
            },
        ],
    },
    romance: {
        core:
            "Use gaze, physical distance, silence, verbal aftertones, cautious contact, and misaligned intentions. Advance emotional tension and intimacy through action and conversational subtext.",
        cues: [
            {
                label: "거리와 시선의 변화",
                prompt:
                    "Create a noticeable shift in gaze, proximity, or physical awareness that changes the emotional temperature without declaring the feeling outright.",
            },
            {
                label: "감정적 취약점 드러내기",
                prompt:
                    "Let a guarded character reveal a small vulnerability through hesitation, an unfinished sentence, or an action they cannot fully hide.",
            },
            {
                label: "관계를 흔드는 선택",
                prompt:
                    "Present a choice whose outcome would meaningfully alter trust, closeness, jealousy, or commitment while leaving the user's response open.",
            },
            {
                label: "친밀감의 작은 진전",
                prompt:
                    "Advance intimacy through a specific gesture, shared secret, private understanding, or boundary negotiation rather than a sudden confession.",
            },
        ],
    },
    drama: {
        core:
            "Expose conflicting desires and emotional fallout. Let choices carry relational or practical costs that deepen tension and leave consequences behind.",
        cues: [
            {
                label: "상충하는 욕망 충돌시키기",
                prompt:
                    "Bring two legitimate but incompatible desires into the same scene so that avoidance is no longer completely possible.",
            },
            {
                label: "선택의 대가 구체화하기",
                prompt:
                    "Make the practical or relational cost of a current choice visible through a concrete consequence, demand, or sacrifice.",
            },
            {
                label: "감정의 후폭풍 보여주기",
                prompt:
                    "Show the delayed emotional consequences of an earlier action through changed behavior, strained dialogue, or a disrupted routine.",
            },
            {
                label: "숨겨진 갈등 표면화하기",
                prompt:
                    "Allow a previously contained conflict to surface through a specific trigger while preserving each character's understandable motive.",
            },
        ],
    },
    comedy: {
        core:
            "Build situational humor through timing, mismatched attitudes, unexpected reactions, misunderstandings, and escalating consequences without breaking characterization.",
        cues: [
            {
                label: "인물 간 온도 차 활용하기",
                prompt:
                    "Create humor from characters treating the same situation with sharply different levels of seriousness, confidence, or understanding.",
            },
            {
                label: "작은 오해 연쇄시키기",
                prompt:
                    "Introduce a plausible minor misunderstanding and let reactions compound it without making anyone implausibly foolish.",
            },
            {
                label: "예상 밖의 반응 배치하기",
                prompt:
                    "Let the most character-consistent reaction also be the least expected one, changing the direction of the exchange.",
            },
            {
                label: "상황을 키우고 회수하기",
                prompt:
                    "Escalate an existing inconvenience through timing and consequence, then pay off an earlier detail as part of the comedic turn.",
            },
        ],
    },
    mystery: {
        core:
            "Place meaningful clues, subtle inconsistencies, concealed motives, and unresolved questions. Reveal information gradually enough to support genuine inference.",
        cues: [
            {
                label: "해석 가능한 단서 노출하기",
                prompt:
                    "Reveal one concrete clue that can support more than one interpretation and is grounded in something observable in the scene.",
            },
            {
                label: "미묘한 불일치 만들기",
                prompt:
                    "Introduce a specific inconsistency between words, behavior, records, timing, or physical evidence that deserves attention.",
            },
            {
                label: "의심의 방향 이동시키기",
                prompt:
                    "Provide information that reasonably shifts suspicion toward a new motive, person, or explanation without proving it.",
            },
            {
                label: "부분적 진실과 새 질문",
                prompt:
                    "Answer one existing question with a partial truth that naturally creates a sharper and more consequential question.",
            },
        ],
    },
    action: {
        core:
            "Keep positions, movement, speed, and physical danger clear. Chain threats and responses so urgency produces concrete changes in the situation.",
        cues: [
            {
                label: "공간적 위협 선명하게 만들기",
                prompt:
                    "Establish a clear spatial threat using positions, distance, obstacles, and available routes so immediate choices matter.",
            },
            {
                label: "장애물 단계적으로 강화하기",
                prompt:
                    "Escalate an existing obstacle through a logical secondary complication rather than introducing an unrelated threat.",
            },
            {
                label: "순간적인 선택 제시하기",
                prompt:
                    "Create a time-sensitive choice between distinct risks while leaving the user's decision and action completely open.",
            },
            {
                label: "행동이 환경을 바꾸게 하기",
                prompt:
                    "Let movement, impact, pursuit, or defense materially alter the environment and reshape what is possible next.",
            },
        ],
    },
    dark: {
        core:
            "Create weight through ominous sensory detail, moral unease, costly choices, and difficult-to-reverse consequences rather than contextless cruelty.",
        cues: [
            {
                label: "불길한 징후 구체화하기",
                prompt:
                    "Use one restrained but specific sensory sign to imply that something is wrong before its full meaning is known.",
            },
            {
                label: "도덕적 타협 압박하기",
                prompt:
                    "Present a situation in which every practical option carries an ethical compromise, without choosing on the user's behalf.",
            },
            {
                label: "대가를 현실로 만들기",
                prompt:
                    "Make a previously implied cost tangible through loss, obligation, contamination, distrust, or a closing opportunity.",
            },
            {
                label: "되돌리기 어려운 변화",
                prompt:
                    "Introduce a consequence that cannot be neatly undone and forces the characters to adapt rather than merely endure shock.",
            },
        ],
    },
    fantasy: {
        core:
            "Render magic, supernatural phenomena, wondrous places, and setting-specific culture as tangible parts of life. Use the world's rules to create opportunities and complications.",
        cues: [
            {
                label: "마법을 생활 속에서 작동시키기",
                prompt:
                    "Show a concrete everyday use or side effect of magic that reveals how people actually live with the supernatural.",
            },
            {
                label: "세계 규칙에서 문제 만들기",
                prompt:
                    "Let an established magical or supernatural rule create an immediate opportunity, restriction, or complication.",
            },
            {
                label: "경이로운 발견 제시하기",
                prompt:
                    "Reveal a vivid wonder with sensory specificity and connect it to a meaningful choice, risk, or unanswered history.",
            },
            {
                label: "문화와 관습 충돌시키기",
                prompt:
                    "Use a setting-specific custom, belief, taboo, or institution to create tension that could not occur in a generic world.",
            },
        ],
    },
    scifi: {
        core:
            "Show how technology, social systems, and unfamiliar environments affect daily life and relationships. Actively develop possibilities and problems that follow from the setting's logic.",
        cues: [
            {
                label: "기술이 일상을 바꾸게 하기",
                prompt:
                    "Show a specific way technology changes routine behavior, privacy, dependency, status, or intimacy in the current scene.",
            },
            {
                label: "시스템의 균열 드러내기",
                prompt:
                    "Expose a concrete flaw, loophole, bias, or hidden cost in a technological or social system already relevant to the characters.",
            },
            {
                label: "사변적 딜레마 제시하기",
                prompt:
                    "Turn a speculative capability into a personal or social dilemma with multiple defensible responses.",
            },
            {
                label: "설정 논리의 결과 발생시키기",
                prompt:
                    "Let the established science, environment, or infrastructure produce a logical consequence that changes the available options.",
            },
        ],
    },
    adventure: {
        core:
            "Drive the story through purposeful travel, discovery, changing terrain, practical obstacles, and rewards that open new possibilities. Make movement through the world alter the situation.",
        cues: [
            {
                label: "새로운 길과 발견 열기",
                prompt:
                    "Reveal a route, place, person, or trace that invites purposeful exploration and offers more than one plausible way forward.",
            },
            {
                label: "여정의 목표 구체화하기",
                prompt:
                    "Turn the current journey into a concrete near-term objective whose completion would reveal, unlock, or change something meaningful.",
            },
            {
                label: "지형과 이동에 변수 만들기",
                prompt:
                    "Let terrain, distance, weather, transport, or limited supplies create a context-appropriate complication that requires adaptation.",
            },
            {
                label: "발견에 대가와 보상 남기기",
                prompt:
                    "Connect a discovery or success to a useful reward and a new consequence, responsibility, or unanswered possibility.",
            },
        ],
    },
    horror: {
        core:
            "Build dread through restrained sensory evidence, vulnerability, uncertain threat behavior, and consequences that linger. Escalate from implication to confrontation without relying on arbitrary gore.",
        cues: [
            {
                label: "불길한 징후 심기",
                prompt:
                    "Introduce one specific sensory detail or broken pattern that implies danger while leaving its full cause uncertain.",
            },
            {
                label: "취약한 지점 드러내기",
                prompt:
                    "Make a character, refuge, routine, or resource newly vulnerable in a way that follows from the established situation.",
            },
            {
                label: "위협의 행동 원리 보여주기",
                prompt:
                    "Reveal a partial pattern in how the threat observes, approaches, marks, avoids, or selects its targets.",
            },
            {
                label: "공포의 흔적 남기기",
                prompt:
                    "Let an encounter or discovery leave a persistent physical, social, or psychological consequence that changes later choices.",
            },
        ],
    },
    healing: {
        core:
            "Create warmth through attentive care, safe sensory detail, honest repair, and modest hope. Let comfort produce real relational or practical change rather than erasing conflict.",
        cues: [
            {
                label: "안전한 감각 만들기",
                prompt:
                    "Ground the scene in a small, specific sensory detail that makes rest, safety, or belonging briefly tangible.",
            },
            {
                label: "돌봄을 행동으로 보이기",
                prompt:
                    "Express care through a practical gesture, accommodation, shared task, or remembered preference rather than a general declaration.",
            },
            {
                label: "관계의 작은 균열 고치기",
                prompt:
                    "Allow one honest acknowledgment or considerate action to repair a limited part of an existing strain without resolving everything.",
            },
            {
                label: "작지만 실제적인 희망 남기기",
                prompt:
                    "Endow the current situation with one credible improvement, renewed possibility, or reason to continue that grows from prior actions.",
            },
        ],
    },
    suspense: {
        core:
            "Sustain anticipation through time pressure, incomplete information, narrowing options, near misses, and risks that become progressively clearer. Keep cause and spatial logic understandable.",
        cues: [
            {
                label: "시간 압박 가시화하기",
                prompt:
                    "Introduce a clear deadline, approaching change, or shrinking window of opportunity that makes delay consequential.",
            },
            {
                label: "확신할 수 없는 정보 주기",
                prompt:
                    "Provide an incomplete but actionable sign whose reliability matters and forces the characters to weigh competing interpretations.",
            },
            {
                label: "아슬아슬한 엇갈림 만들기",
                prompt:
                    "Create a plausible near miss, delayed discovery, or narrowly avoided exposure that intensifies the current pursuit or concealment.",
            },
            {
                label: "숨은 위험의 범위 드러내기",
                prompt:
                    "Reveal that an established risk reaches farther, arrives sooner, or involves more of the current situation than previously understood.",
            },
        ],
    },
    historical: {
        core:
            "Make the period tangible through material culture, social hierarchy, institutions, customs, and constraints appropriate to the setting. Let historical conditions actively shape choices and consequences.",
        cues: [
            {
                label: "시대의 물질감 보여주기",
                prompt:
                    "Use a period-appropriate object, space, technology, garment, or routine as a functional part of the scene rather than decoration.",
            },
            {
                label: "관습과 신분 작동시키기",
                prompt:
                    "Let a social custom, expectation, hierarchy, or reputation change how characters can speak, move, meet, or negotiate.",
            },
            {
                label: "시대 제도에서 압박 만들기",
                prompt:
                    "Bring a relevant law, institution, economy, conflict, or communication limit into the immediate situation as a practical constraint.",
            },
            {
                label: "시대적 선택의 결과 남기기",
                prompt:
                    "Make a choice carry consequences specific to this historical setting, including status, livelihood, safety, duty, or public memory.",
            },
        ],
    },
    supernatural: {
        core:
            "Let the uncanny intrude through consistent signs, boundaries, rituals, entities, and costs. Treat supernatural forces as active parts of the world with motives or rules that can be partly understood.",
        cues: [
            {
                label: "일상에 기이한 침입 만들기",
                prompt:
                    "Disturb an ordinary detail with a precise impossible change that is subtle enough to invite interpretation but impossible to dismiss.",
            },
            {
                label: "경계와 의식 작동시키기",
                prompt:
                    "Make a relevant threshold, taboo, invitation, name, ritual, or protective practice affect what can happen next.",
            },
            {
                label: "존재의 의도 암시하기",
                prompt:
                    "Reveal a partial motive, preference, demand, or method belonging to a supernatural presence without explaining it completely.",
            },
            {
                label: "초자연적 대가 남기기",
                prompt:
                    "Attach a concrete cost, mark, obligation, distortion, or altered relationship to contact with the supernatural.",
            },
        ],
    },
});

const EVENT_CATEGORIES = [
    "정보",
    "인물",
    "목표",
    "사건",
    "관계",
    "미스터리",
    "갈등",
    "환경",
    "감정",
];

// ----------------------------------------------------------------------
// 2. STATE — persisted in extension_settings[MODULE_NAME].chats[chatId],
//    so it's specific to the CURRENTLY OPEN CHAT, not global to the
//    extension. Switching chats gives you independently saved state.
// ----------------------------------------------------------------------

function getCurrentChatId() {
    const context = getContext();
    // chatId is the standard per-chat identifier exposed by getContext();
    // fall back to a fixed key if it's ever missing (e.g. no chat open yet).
    return context?.chatId || "no-chat-open";
}

function ensureModuleSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { chats: {}, customGenres: [] };
    }
    if (!extension_settings[MODULE_NAME].chats) {
        extension_settings[MODULE_NAME].chats = {};
    }
    if (!Array.isArray(extension_settings[MODULE_NAME].customGenres)) {
        extension_settings[MODULE_NAME].customGenres = [];
    }

    extension_settings[MODULE_NAME].customGenres =
        extension_settings[MODULE_NAME].customGenres
            .filter((genre) => genre && typeof genre.id === "string" && typeof genre.label === "string")
            .map((genre) => ({
                id: genre.id,
                label: genre.label.trim().slice(0, 50),
                emoji: "✨",
                group: "custom",
                description: String(genre.description || "").trim().slice(0, 500),
            }))
            .filter((genre) => genre.label);

    return extension_settings[MODULE_NAME];
}

function getAvailableGenres() {
    const settings = ensureModuleSettings();
    return [
        ...DEFAULT_GENRES.map((genre) => ({ ...genre })),
        ...settings.customGenres.map((genre) => ({ ...genre })),
    ];
}

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
            supportIds: legacyIds.slice(1, 3),
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
        if (supportIds.length === 2) break;
    }

    state.genreSelection = { primaryId, supportIds };
    return state.genreSelection;
}

function ensureChatState() {
    const moduleSettings = ensureModuleSettings();

    const chatId = getCurrentChatId();
    const chats = moduleSettings.chats;

    if (!chats[chatId]) {
        chats[chatId] = {
            genres: DEFAULT_GENRES.map((g) => ({ ...g })),
            genreSelection: {
                primaryId: null,
                supportIds: [],
            },
            genreDirector: {
                step: 0,
                locked: false,
                cadence: 3,
            },
        };
    }

    const state = chats[chatId];
    if (!Array.isArray(state.genres)) {
        state.genres = DEFAULT_GENRES.map((g) => ({ ...g }));
    }
    normalizeGenreSelection(state);
    if (!state.genreDirector || typeof state.genreDirector !== "object") {
        state.genreDirector = {
            step: 0,
            locked: false,
            cadence: 3,
        };
    }
    if (!Number.isSafeInteger(state.genreDirector.step) || state.genreDirector.step < 0) {
        state.genreDirector.step = 0;
    }
    state.genreDirector.locked = Boolean(state.genreDirector.locked);
    if (![2, 3, 4].includes(state.genreDirector.cadence)) {
        state.genreDirector.cadence = 3;
    }

    return state;
}

// ----------------------------------------------------------------------
// 3. DYNAMIC GENRE DIRECTOR — one persistent primary genre plus up to two
//    stable supporting textures. The primary cue changes on a configurable
//    cadence instead of every reply. No additional LLM request is used.
// ----------------------------------------------------------------------

function getGenreProfile(genre) {
    const configured = GENRE_PROFILES[genre.id];
    if (configured) return configured;

    const customDirection = String(genre.description || "").trim();
    return {
        core: customDirection
            ? `Treat the following user-defined direction as the genre foundation for ${genre.label}: ${customDirection}`
            : `Make the ${genre.label} genre clearly perceptible through setting, character behavior, pacing, and consequential story movement.`,
        cues: [
            {
                label: "배경과 감각에 장르 드러내기",
                prompt:
                    `Make ${genre.label} distinctly perceptible through concrete environmental, sensory, and social details that fit the established setting.`,
            },
            {
                label: "인물 행동과 대사에 장르 반영하기",
                prompt:
                    `Let ${genre.label} shape character behavior, conversational subtext, interpersonal distance, and immediate priorities without naming the genre.`,
            },
            {
                label: "장르다운 전개 능동적으로 만들기",
                prompt:
                    `Initiate one context-appropriate event, discovery, opportunity, obstacle, or NPC action that actively advances the scene in the mode of ${genre.label}.`,
            },
            {
                label: "결과와 여운 남기기",
                prompt:
                    `Give the scene a concrete change or consequence whose emotional and narrative aftertone distinctly supports ${genre.label}.`,
            },
        ],
    };
}

function getGenreDirectorSelection(state = ensureChatState()) {
    const genresById = new Map(getAvailableGenres().map((genre) => [genre.id, genre]));
    const genreSelection = normalizeGenreSelection(state);
    const leadGenre = genresById.get(genreSelection.primaryId);
    if (!leadGenre) return null;

    const step = state.genreDirector.step;
    const cadence = state.genreDirector.cadence;
    const cueCycle = Math.floor(step / cadence);
    const phaseIndex = step % cadence;
    const leadProfile = getGenreProfile(leadGenre);
    const leadCue = leadProfile.cues[cueCycle % leadProfile.cues.length];

    const supportGenres = genreSelection.supportIds
        .map((id) => genresById.get(id))
        .filter(Boolean);

    return {
        activeGenres: [leadGenre, ...supportGenres],
        leadGenre,
        leadCue,
        supportGenres,
        cadence,
        phaseIndex,
        locked: state.genreDirector.locked,
    };
}

function buildGenrePromptText(selection) {
    const {
        activeGenres,
        leadGenre,
        leadCue,
        supportGenres,
        cadence,
        phaseIndex,
        locked,
    } = selection;
    const genreFoundations = activeGenres.map(
        (genre) => `- ${genre.label}: ${getGenreProfile(genre).core}`
    );
    const phaseDirections = [
        "CONTINUE: Preserve the immediate action, conversation, and emotional focus. Express the genre mainly through setting detail, reactions, subtext, and pacing. Do not begin a new event.",
        "DEEPEN: Develop the current interaction or unresolved beat through one subtle causal detail, reaction, or shift. Avoid abrupt escalation, interruption, or scene change.",
        "PROGRESS GENTLY: If the current beat is ready, allow one small organic consequence or opening. If it is not ready, continue deepening it instead of forcing progression.",
        "SETTLE: Give the current beat room to breathe through response, reflection, sensory continuity, or relational aftertone. A transition is optional, never mandatory.",
    ];
    const pacingDirection = locked
        ? "SCENE HOLD IS ACTIVE: Stay with the current immediate situation. Do not introduce a new event, complication, discovery, location, time skip, or scene transition. Deepen only what is already happening through reactions, dialogue, subtext, and sensory continuity."
        : phaseDirections[Math.min(phaseIndex, phaseDirections.length - 1)];

    return [
        "[STORYBOOSTER — CONTINUITY-FIRST GENRE DIRECTOR]",
        `PRIMARY GENRE (PERSISTENT): ${leadGenre.label}`,
        `SUPPORTING GENRES (STABLE SECONDARY TEXTURES): ${
            supportGenres.map((genre) => genre.label).join(", ") || "None"
        }`,
        `CURRENT DIRECTOR CUE (HELD FOR ${cadence} RESPONSES): ${leadCue.prompt}`,
        `PACING PHASE: ${pacingDirection}`,
        "GENRE FOUNDATIONS:",
        ...genreFoundations,
        "EXECUTION:",
        "- Continue unresolved actions, conversations, emotions, and immediate consequences before considering anything new.",
        "- Keep the primary genre dominant. Use the director cue as a gradual emphasis across several responses, not as a demand to complete a new plot beat in every response.",
        "- Keep all supporting genres present as restrained, stable textures. Do not rotate them, spotlight them one by one, or let them compete with the primary genre.",
        "- Express genre through concrete environmental detail, character behavior, conversational subtext, emotional rhythm, and pacing. Never name or discuss the genres in the narrative.",
        "- Do not introduce a major event, unrelated complication, sudden discovery, scene transition, or time skip merely to demonstrate the genre. Deliberate event generation belongs to the Plot Booster.",
        "- Preserve established characterization, world rules, spatial continuity, and the current scene's emotional momentum. Show emotion through behavior and reactions rather than merely explaining it.",
        "CONTINUITY AND AGENCY: Prioritize established world rules and conversational causality. Never decide the user's actions, dialogue, thoughts, or emotions. Instead, present concrete situations that invite the user to react and choose.",
    ]
        .filter(Boolean)
        .join("\n");
}

function updateGenrePrompt() {
    const s = ensureChatState();
    const selection = getGenreDirectorSelection(s);

    if (!selection) {
        setExtensionPrompt(GENRE_PROMPT_KEY, "", extension_prompt_types.IN_CHAT, 0);
        console.log(`[${MODULE_NAME}] genre prompt cleared (no primary genre)`);
        return;
    }

    const text = buildGenrePromptText(selection);
    setExtensionPrompt(
        GENRE_PROMPT_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        0, // depth 0 = after the latest chat message for a clearly visible boost
        false, // scan
        extension_prompt_roles.SYSTEM
    );
    console.log(`[${MODULE_NAME}] genre prompt set:`, text);
}

function advanceGenreDirector({ force = false, nextCue = false } = {}) {
    const state = ensureChatState();
    if (!getGenreDirectorSelection(state)) return false;
    if (state.genreDirector.locked && !force) return false;

    if (nextCue) {
        const currentCueCycle = Math.floor(
            state.genreDirector.step / state.genreDirector.cadence
        );
        const nextStep = (currentCueCycle + 1) * state.genreDirector.cadence;
        state.genreDirector.step =
            Number.isSafeInteger(nextStep) && nextStep < Number.MAX_SAFE_INTEGER
                ? nextStep
                : 0;
    } else {
        state.genreDirector.step =
            state.genreDirector.step >= Number.MAX_SAFE_INTEGER - 1
                ? 0
                : state.genreDirector.step + 1;
    }
    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreDirectorPanel();
    return true;
}

function toggleGenreDirectorLock() {
    const state = ensureChatState();
    if (!getGenreDirectorSelection(state)) return;

    state.genreDirector.locked = !state.genreDirector.locked;
    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreDirectorPanel();
    toastr?.info?.(
        state.genreDirector.locked
            ? "장면 유지를 켰습니다. 새로운 사건이나 장면 전환을 억제합니다."
            : "장면 유지를 해제했습니다. 완만한 큐 순환을 다시 시작합니다."
    );
}

function changeGenreDirectorCadence(value) {
    const cadence = Number(value);
    if (![2, 3, 4].includes(cadence)) return;

    const state = ensureChatState();
    const previousCadence = state.genreDirector.cadence;
    const currentCueCycle = Math.floor(state.genreDirector.step / previousCadence);
    state.genreDirector.cadence = cadence;

    const nextStep = currentCueCycle * cadence;
    state.genreDirector.step =
        Number.isSafeInteger(nextStep) && nextStep < Number.MAX_SAFE_INTEGER
            ? nextStep
            : 0;

    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreDirectorPanel();
}

// ----------------------------------------------------------------------
// 4. PLOT EVENT — generated in the background, then optionally injected once.
//
// IMPORTANT: we register exactly ONE persistent MESSAGE_RECEIVED listener
// (see init, below) and gate its behavior with `plotPending`, instead of
// adding/removing a listener per trigger. Repeatedly calling
// eventSource.removeListener() was likely the cause of generation hanging —
// if that method doesn't exist on this ST build's event emitter, it throws
// mid-way through MESSAGE_RECEIVED handling and can prevent ST's own
// listeners (the ones that clear the "generating" spinner) from finishing.
// ----------------------------------------------------------------------

let plotPending = false;
let eventGenerationPending = false;

function triggerPlotEvent(eventText) {
    const line = eventText?.trim();
    if (!line) return;

    const text =
        `[방금 발생한 사건: ${line}] ` +
        `이 사건을 현재 장면과 캐릭터의 성격에 맞게 자연스럽게 반영하여 다음 응답을 이어가라. ` +
        `유저의 행동이나 감정은 임의로 확정하지 마라.`;

    setExtensionPrompt(
        PLOT_PROMPT_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        0, // depth 0 = right before the next reply
        false,
        extension_prompt_roles.SYSTEM
    );

    plotPending = true;
}

function clearPlotPromptIfPending() {
    if (!plotPending) return;
    try {
        setExtensionPrompt(PLOT_PROMPT_KEY, "", extension_prompt_types.IN_CHAT, 0);
    } catch (err) {
        console.error(`[${MODULE_NAME}] failed to clear plot prompt:`, err);
    }
    plotPending = false;
}

function buildEventGenerationPrompt(category, previousEvent = "") {
    const state = ensureChatState();
    const selection = getGenreDirectorSelection(state);
    const activeGenres = selection?.activeGenres.map((genre) => genre.label) || [];

    const genreLine = activeGenres.length
        ? `현재 선택된 장르 방향성: ${activeGenres.join(", ")}.`
        : "별도로 선택된 장르 방향성은 없다.";
    const directorLine = selection
        ? [
              `현재 동적 연출 큐의 주 장르는 ${selection.leadGenre.label}이다.`,
              `사건은 다음 연출 목표와 조화를 이루어야 한다: ${selection.leadCue.prompt}`,
              selection.supportGenres.length
                  ? `보조 장르는 ${selection.supportGenres
                        .map((genre) => genre.label)
                        .join(", ")}이며 주 장르를 압도하지 않는 안정적인 질감으로만 활용하라.`
                  : "",
          ]
              .filter(Boolean)
              .join(" ")
        : "";

    const retryLine = previousEvent
        ? `직전 후보와는 분명히 다른 사건을 만들어라. 직전 후보: ${previousEvent}`
        : "";

    return [
        "현재 진행 중인 롤플레이의 다음 흐름에 사용할 새로운 사건 후보를 하나 만들어라.",
        `사건 카테고리: ${category}.`,
        genreLine,
        directorLine,
        "현재 대화, 캐릭터 성격, 관계, 세계관을 우선해서 지금 이 장면에 자연스럽게 이어질 사건을 창작하라.",
        "미리 정해진 사건 목록에서 고르지 말고 현재 맥락에 맞는 구체적인 변화를 자유롭게 만들어라.",
        "사건은 새로운 반응과 선택을 유도해야 하지만, 유저의 행동·대사·생각·감정을 대신 결정하지 마라.",
        "사건을 완전히 해결하지 말고 다음 전개로 이어질 여지를 남겨라.",
        "제목, 번호, 카테고리명, 설명, 따옴표 없이 사건 내용만 한국어 1~3문장으로 출력하라.",
        retryLine,
    ]
        .filter(Boolean)
        .join("\n");
}

async function generateEventCandidate() {
    if (eventGenerationPending) return;

    const categorySelect = document.getElementById("rp-event-category");
    const resultWrap = document.getElementById("rp-event-result-wrap");
    const resultField = document.getElementById("rp-event-result");
    const status = document.getElementById("rp-event-status");
    const generateButton = document.getElementById("rp-event-generate-btn");
    const actionButtons = document.querySelectorAll(".rp-event-result-action");

    if (!categorySelect || !resultWrap || !resultField || !status || !generateButton) return;

    const previousEvent = resultField.value.trim();
    const originalButtonText = generateButton.textContent;
    eventGenerationPending = true;
    generateButton.disabled = true;
    actionButtons.forEach((button) => (button.disabled = true));
    status.textContent = "현재 대화 맥락을 읽고 사건을 만들고 있어요…";
    status.classList.add("is-loading");

    try {
        const context = getContext();
        if (typeof context?.generateQuietPrompt !== "function") {
            throw new Error("이 SillyTavern 버전에서는 백그라운드 생성 API를 찾을 수 없습니다.");
        }

        const result = await context.generateQuietPrompt({
            quietPrompt: buildEventGenerationPrompt(categorySelect.value, previousEvent),
        });
        const eventText = String(result ?? "").trim();

        if (!eventText) {
            throw new Error("AI가 빈 사건 후보를 반환했습니다.");
        }

        resultField.value = eventText;
        resultWrap.hidden = false;
        status.textContent = "생성된 사건을 직접 고친 뒤 원하는 방식으로 적용할 수 있어요.";
        resultField.focus();
    } catch (err) {
        console.error(`[${MODULE_NAME}] event generation failed:`, err);
        status.textContent = `사건 생성 실패: ${err?.message || err}`;
        toastr?.error?.("사건 후보를 생성하지 못했습니다. 연결 상태와 콘솔을 확인하세요.");
    } finally {
        eventGenerationPending = false;
        generateButton.disabled = false;
        generateButton.textContent = originalButtonText;
        actionButtons.forEach((button) => (button.disabled = false));
        status.classList.remove("is-loading");
    }
}

function getGeneratedEventText() {
    return document.getElementById("rp-event-result")?.value.trim() || "";
}

function closeBoosterPopup() {
    const popupRoot = document.getElementById("rp-booster-popup");
    const popup = popupRoot?.closest(".popup, .dialogue_popup");
    const closeButton =
        popup?.querySelector(".popup-button-ok, .popup_ok, .popup-button-close") ||
        document.getElementById("dialogue_popup_ok");

    closeButton?.click();
}

function insertEventIntoComposer() {
    const eventText = getGeneratedEventText();
    if (!eventText) {
        toastr?.warning?.("먼저 사건 후보를 생성하세요.");
        return;
    }

    const composer = document.getElementById("send_textarea");
    if (!composer) {
        toastr?.error?.("채팅 입력창을 찾을 수 없습니다.");
        return;
    }

    const currentText = String(composer.value || "");
    composer.value = currentText ? `${currentText.replace(/\s+$/, "")}\n${eventText}` : eventText;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));

    closeBoosterPopup();
    setTimeout(() => composer.focus(), 100);
    toastr?.success?.("사건을 채팅 입력창에 넣었습니다.");
}

async function injectEventAndGenerateReply() {
    const eventText = getGeneratedEventText();
    if (!eventText) {
        toastr?.warning?.("먼저 사건 후보를 생성하세요.");
        return;
    }

    const context = getContext();
    if (typeof context?.generate !== "function") {
        toastr?.error?.("이 SillyTavern 버전에서는 즉시 응답 생성 API를 찾을 수 없습니다.");
        return;
    }

    triggerPlotEvent(eventText);
    closeBoosterPopup();

    // Let the popup finish closing before starting a regular assistant reply.
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
        await context.generate("normal");
    } catch (err) {
        console.error(`[${MODULE_NAME}] reply generation failed:`, err);
        toastr?.error?.("사건을 주입했지만 AI 응답 생성에 실패했습니다.");
    } finally {
        // MESSAGE_RECEIVED normally clears this first. The finally block also
        // covers cancellation and failed generations so no stale event remains.
        clearPlotPromptIfPending();
    }
}

// ----------------------------------------------------------------------
// 5. UI — single popup opened from the wand (extensions) menu in chat.
//    Contains both the genre toggles and the event generator, all scoped
//    to whichever chat is currently open.
// ----------------------------------------------------------------------

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function renderGenreOptions(selectedId, emptyLabel) {
    const availableGenres = getAvailableGenres();
    const groups = GENRE_GROUPS.map((group) => {
        const options = availableGenres
            .filter((genre) => genre.group === group.id)
            .map(
                (genre) =>
                    `<option value="${escapeHtml(genre.id)}" ${
                        genre.id === selectedId ? "selected" : ""
                    }>${escapeHtml(`${genre.emoji} ${genre.label}`)}</option>`
            )
            .join("");

        return options
            ? `<optgroup label="${escapeHtml(group.label)}">${options}</optgroup>`
            : "";
    }).join("");

    return `<option value="" ${selectedId ? "" : "selected"}>${escapeHtml(
        emptyLabel
    )}</option>${groups}`;
}

function renderCustomGenreList() {
    const list = document.getElementById("rp-custom-genre-list");
    if (!list) return;

    const customGenres = ensureModuleSettings().customGenres;
    if (customGenres.length === 0) {
        list.innerHTML = '<p class="rp-custom-empty">아직 추가한 장르가 없습니다.</p>';
        return;
    }

    list.innerHTML = customGenres
        .map(
            (genre) => `
            <div class="rp-custom-genre-item">
                <div>
                    <strong>✨ ${escapeHtml(genre.label)}</strong>
                    ${
                        genre.description
                            ? `<small>${escapeHtml(genre.description)}</small>`
                            : '<small>별도 방향 설명 없음</small>'
                    }
                </div>
                <button type="button" class="menu_button rp-custom-genre-delete" data-id="${escapeHtml(
                    genre.id
                )}" aria-label="${escapeHtml(genre.label)} 삭제">삭제</button>
            </div>`
        )
        .join("");
}

function populateGenreSelectionControls() {
    const state = ensureChatState();
    const selection = normalizeGenreSelection(state);
    const primarySelect = document.getElementById("rp-primary-genre");
    const supportSelect1 = document.getElementById("rp-support-genre-1");
    const supportSelect2 = document.getElementById("rp-support-genre-2");

    if (!primarySelect || !supportSelect1 || !supportSelect2) return;

    primarySelect.innerHTML = renderGenreOptions(selection.primaryId, "사용하지 않음");
    supportSelect1.innerHTML = renderGenreOptions(selection.supportIds[0] || null, "없음");
    supportSelect2.innerHTML = renderGenreOptions(selection.supportIds[1] || null, "없음");
}

function syncGenreSelectionFromControls() {
    const primarySelect = document.getElementById("rp-primary-genre");
    const supportSelect1 = document.getElementById("rp-support-genre-1");
    const supportSelect2 = document.getElementById("rp-support-genre-2");
    if (!primarySelect || !supportSelect1 || !supportSelect2) return;

    const primaryId = primarySelect.value || null;
    const supportIds = [];
    for (const id of [supportSelect1.value, supportSelect2.value]) {
        if (id && id !== primaryId && !supportIds.includes(id)) {
            supportIds.push(id);
        }
    }

    const state = ensureChatState();
    state.genreSelection = { primaryId, supportIds };
    state.genreDirector.step = 0;
    state.genreDirector.locked = false;

    populateGenreSelectionControls();
    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreDirectorPanel();
}

function addCustomGenre() {
    const nameInput = document.getElementById("rp-custom-genre-name");
    const descriptionInput = document.getElementById("rp-custom-genre-description");
    const status = document.getElementById("rp-custom-genre-status");
    if (!nameInput || !descriptionInput || !status) return;

    const label = nameInput.value.trim().slice(0, 50);
    const description = descriptionInput.value.trim().slice(0, 500);
    if (!label) {
        status.textContent = "장르 이름을 입력해 주세요.";
        nameInput.focus();
        return;
    }

    const settings = ensureModuleSettings();
    const duplicate = getAvailableGenres().some(
        (genre) => genre.label.toLocaleLowerCase() === label.toLocaleLowerCase()
    );
    if (duplicate) {
        status.textContent = "같은 이름의 장르가 이미 있습니다.";
        return;
    }

    settings.customGenres.push({
        id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        label,
        emoji: "✨",
        group: "custom",
        description,
    });

    nameInput.value = "";
    descriptionInput.value = "";
    status.textContent = `“${label}” 장르를 추가했습니다.`;
    populateGenreSelectionControls();
    renderCustomGenreList();
    saveSettingsDebounced();
}

function deleteCustomGenre(genreId) {
    const settings = ensureModuleSettings();
    const genre = settings.customGenres.find((item) => item.id === genreId);
    if (!genre) return;
    if (!window.confirm(`“${genre.label}” 장르를 목록에서 삭제할까요?`)) return;

    settings.customGenres = settings.customGenres.filter((item) => item.id !== genreId);
    for (const state of Object.values(settings.chats)) {
        if (!state || typeof state !== "object") continue;
        normalizeGenreSelection(state);
        if (state.genreSelection.primaryId === genreId) {
            state.genreSelection.primaryId = null;
        }
        state.genreSelection.supportIds = state.genreSelection.supportIds.filter(
            (id) => id !== genreId
        );
        if (state.genreDirector) {
            state.genreDirector.step = 0;
            state.genreDirector.locked = false;
        }
    }

    populateGenreSelectionControls();
    renderCustomGenreList();
    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreDirectorPanel();
}

function updateGenreDirectorPanel() {
    const emptyState = document.getElementById("rp-director-empty");
    const content = document.getElementById("rp-director-content");
    const lead = document.getElementById("rp-director-lead");
    const cue = document.getElementById("rp-director-cue");
    const support = document.getElementById("rp-director-support");
    const cycleNote = document.getElementById("rp-director-cycle-note");
    const cadenceSelect = document.getElementById("rp-director-cadence");
    const nextButton = document.getElementById("rp-director-next-btn");
    const lockButton = document.getElementById("rp-director-lock-btn");

    if (
        !emptyState ||
        !content ||
        !lead ||
        !cue ||
        !support ||
        !cycleNote ||
        !cadenceSelect ||
        !nextButton ||
        !lockButton
    ) {
        return;
    }

    const state = ensureChatState();
    const selection = getGenreDirectorSelection(state);

    if (!selection) {
        emptyState.hidden = false;
        content.hidden = true;
        cadenceSelect.disabled = true;
        nextButton.disabled = true;
        lockButton.disabled = true;
        lockButton.classList.remove("is-active");
        lockButton.setAttribute("aria-pressed", "false");
        lockButton.textContent = "🫧 장면 유지";
        return;
    }

    emptyState.hidden = true;
    content.hidden = false;
    cadenceSelect.disabled = false;
    cadenceSelect.value = String(selection.cadence);
    nextButton.disabled = false;
    lockButton.disabled = false;

    lead.textContent = `${selection.leadGenre.emoji} 주 장르: ${selection.leadGenre.label}`;
    cue.textContent = `🎬 ${selection.leadCue.label}`;

    if (selection.supportGenres.length) {
        support.hidden = false;
        support.textContent = `보조 장르 · 안정적 질감: ${selection.supportGenres
            .map((genre) => `${genre.emoji} ${genre.label}`)
            .join(" · ")}`;
    } else {
        support.hidden = true;
        support.textContent = "";
    }

    cycleNote.textContent = state.genreDirector.locked
        ? "장면 유지 중: 새 사건이나 장면 전환 없이 현재 흐름을 깊게 이어갑니다."
        : `현재 큐 ${selection.phaseIndex + 1}/${selection.cadence} · 같은 큐를 ${
              selection.cadence
          }회 유지한 뒤 다음 큐로 이동합니다.`;
    lockButton.classList.toggle("is-active", state.genreDirector.locked);
    lockButton.setAttribute("aria-pressed", String(state.genreDirector.locked));
    lockButton.textContent = state.genreDirector.locked
        ? "▶️ 장면 유지 해제"
        : "🫧 장면 유지";
}

function activateBoosterTab(tabName, { focus = false } = {}) {
    const popupRoot = document.getElementById("rp-booster-popup");
    if (!popupRoot) return;

    const tabButtons = [...popupRoot.querySelectorAll(".rp-booster-tab")];
    const tabPanels = [...popupRoot.querySelectorAll(".rp-booster-tab-panel")];

    tabButtons.forEach((button) => {
        const isActive = button.dataset.tab === tabName;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-selected", String(isActive));
        button.tabIndex = isActive ? 0 : -1;
        if (isActive && focus) button.focus();
    });

    tabPanels.forEach((panel) => {
        panel.hidden = panel.dataset.tabPanel !== tabName;
    });
}

function handleBoosterTabKeydown(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    const tabs = [...event.currentTarget.querySelectorAll(".rp-booster-tab")];
    const currentIndex = tabs.indexOf(document.activeElement);
    if (currentIndex < 0) return;

    event.preventDefault();
    let nextIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else {
        const direction = event.key === "ArrowRight" ? 1 : -1;
        nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    }

    activateBoosterTab(tabs[nextIndex].dataset.tab, { focus: true });
}

function renderBoosterPopupHtml() {
    const s = ensureChatState();
    const genreSelection = normalizeGenreSelection(s);

    const categoryOptions = EVENT_CATEGORIES.map(
        (category) =>
            `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`
    ).join("");

    return `
    <div id="rp-booster-popup">
        <h3>🎭 스토리부스터 <small style="opacity:0.6;">(이 채팅에만 적용)</small></h3>

        <div class="rp-booster-tabs" role="tablist" aria-label="스토리부스터 기능">
            <button id="rp-tab-genre" type="button" class="rp-booster-tab is-active" role="tab" aria-selected="true" aria-controls="rp-booster-genre-panel" data-tab="genre">
                🎭 장르 부스터
            </button>
            <button id="rp-tab-plot" type="button" class="rp-booster-tab" role="tab" aria-selected="false" aria-controls="rp-booster-plot-panel" data-tab="plot" tabindex="-1">
                🎲 플롯 부스터
            </button>
        </div>

        <section id="rp-booster-genre-panel" class="rp-booster-tab-panel" role="tabpanel" aria-labelledby="rp-tab-genre" data-tab-panel="genre">
        <h4>장르 부스터 <small>(채팅별 저장)</small></h4>
        <p class="rp-genre-help">주 장르는 중심을 유지하고, 보조 장르는 교대하지 않는 안정적인 질감으로만 더해집니다. 큰 사건은 플롯 부스터에서 따로 만듭니다.</p>
        <div class="rp-genre-select-grid">
            <label class="rp-primary-select" for="rp-primary-genre">
                <span>⭐ 주 장르</span>
                <select id="rp-primary-genre">${renderGenreOptions(
                    genreSelection.primaryId,
                    "사용하지 않음"
                )}</select>
            </label>
            <label for="rp-support-genre-1">
                <span>＋ 보조 장르 1</span>
                <select id="rp-support-genre-1">${renderGenreOptions(
                    genreSelection.supportIds[0] || null,
                    "없음"
                )}</select>
            </label>
            <label for="rp-support-genre-2">
                <span>＋ 보조 장르 2</span>
                <select id="rp-support-genre-2">${renderGenreOptions(
                    genreSelection.supportIds[1] || null,
                    "없음"
                )}</select>
            </label>
        </div>

        <section id="rp-genre-director">
            <div class="rp-director-title">🎬 동적 장르 디렉터</div>
            <p id="rp-director-empty">주 장르를 선택하면 이번 응답의 연출 큐가 표시됩니다.</p>

            <div id="rp-director-content" hidden>
                <div id="rp-director-lead"></div>
                <div id="rp-director-cue"></div>
                <div id="rp-director-support" hidden></div>
                <p id="rp-director-cycle-note"></p>
            </div>

            <label class="rp-director-cadence-control" for="rp-director-cadence">
                <span>연출 전환 속도</span>
                <select id="rp-director-cadence">
                    <option value="4" ${s.genreDirector.cadence === 4 ? "selected" : ""}>느긋하게 · 같은 큐 4회 유지</option>
                    <option value="3" ${s.genreDirector.cadence === 3 ? "selected" : ""}>균형 · 같은 큐 3회 유지</option>
                    <option value="2" ${s.genreDirector.cadence === 2 ? "selected" : ""}>빠르게 · 같은 큐 2회 유지</option>
                </select>
            </label>

            <div class="rp-director-actions">
                <button id="rp-director-next-btn" type="button" class="menu_button">⏭️ 다음 연출 큐</button>
                <button id="rp-director-lock-btn" type="button" class="menu_button" aria-pressed="false">🫧 장면 유지</button>
            </div>
        </section>

        <details id="rp-custom-genre-editor">
            <summary>✨ 원하는 장르 직접 추가</summary>
            <p class="rp-custom-help">한 번 추가한 장르는 모든 채팅의 선택 목록에서 재사용할 수 있습니다.</p>
            <label for="rp-custom-genre-name">장르 이름</label>
            <input id="rp-custom-genre-name" type="text" maxlength="50" placeholder="예: Gothic Romance, Court Intrigue">
            <label for="rp-custom-genre-description">장르 방향 <small>(선택)</small></label>
            <textarea id="rp-custom-genre-description" rows="3" maxlength="500" placeholder="AI가 반드시 살렸으면 하는 분위기와 전개를 자유롭게 적어 주세요. 한국어도 사용할 수 있습니다."></textarea>
            <button id="rp-custom-genre-add-btn" type="button" class="menu_button">장르 목록에 추가</button>
            <p id="rp-custom-genre-status" aria-live="polite"></p>
            <div id="rp-custom-genre-list"></div>
        </details>
        </section>

        <section id="rp-booster-plot-panel" class="rp-booster-tab-panel" role="tabpanel" aria-labelledby="rp-tab-plot" data-tab-panel="plot" hidden>
        <h4>플롯 부스터</h4>
        <p class="rp-event-help">카테고리만 고르면 현재 대화에 맞는 새로운 사건을 AI가 자유롭게 만듭니다.</p>

        <label for="rp-event-category">카테고리</label>
        <select id="rp-event-category">${categoryOptions}</select>

        <button id="rp-event-generate-btn" type="button" class="menu_button">🎲 사건 후보 생성</button>
        <p id="rp-event-status" aria-live="polite">생성 결과는 이 아래에 표시됩니다.</p>

        <div id="rp-event-result-wrap" hidden>
            <label for="rp-event-result">생성된 사건 <small>(직접 수정 가능)</small></label>
            <textarea id="rp-event-result" rows="5"></textarea>

            <div class="rp-event-actions">
                <button id="rp-event-regenerate-btn" type="button" class="menu_button rp-event-result-action">↻ 다시 생성</button>
                <button id="rp-event-insert-btn" type="button" class="menu_button rp-event-result-action">✍️ 입력창에 넣기</button>
                <button id="rp-event-inject-btn" type="button" class="menu_button rp-event-result-action">⚡ 주입 후 AI 응답 생성</button>
            </div>
        </div>
        </section>
    </div>`;
}

function openBoosterPopup() {
    console.log(`[${MODULE_NAME}] booster button clicked`);

    let context;
    try {
        context = getContext();
    } catch (err) {
        console.error(`[${MODULE_NAME}] getContext() threw:`, err);
        alert("getContext() 실패 — 콘솔을 확인하세요.");
        return;
    }

    console.log(`[${MODULE_NAME}] context.callGenericPopup exists?`, typeof context?.callGenericPopup);
    console.log(`[${MODULE_NAME}] window.callPopup exists?`, typeof window.callPopup);

    const html = renderBoosterPopupHtml();

    try {
        if (context.callGenericPopup) {
            context.callGenericPopup(html, context.POPUP_TYPE.TEXT, "", { wide: true, large: false });
        } else if (window.callPopup) {
            window.callPopup(html, "text");
        } else {
            console.error(`[${MODULE_NAME}] no popup API found on context or window`);
            alert("팝업 API를 찾을 수 없습니다. ST 버전을 확인하세요.");
            return;
        }
        console.log(`[${MODULE_NAME}] popup call issued`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] popup call threw:`, err);
        alert("팝업 호출 중 오류 발생 — 콘솔을 확인하세요.");
        return;
    }

    // wire up events after popup is in the DOM
    setTimeout(() => {
        const popupRoot = document.getElementById("rp-booster-popup");
        if (!popupRoot) {
            console.error(`[${MODULE_NAME}] #rp-booster-popup not found in DOM after popup call — popup likely didn't render`);
            return;
        }
        console.log(`[${MODULE_NAME}] wiring up popup controls`);

        const tabList = popupRoot.querySelector(".rp-booster-tabs");
        popupRoot.querySelectorAll(".rp-booster-tab").forEach((button) => {
            button.addEventListener("click", () => activateBoosterTab(button.dataset.tab));
        });
        tabList?.addEventListener("keydown", handleBoosterTabKeydown);
        activateBoosterTab("genre");

        // Primary/support genre selectors
        [
            popupRoot.querySelector("#rp-primary-genre"),
            popupRoot.querySelector("#rp-support-genre-1"),
            popupRoot.querySelector("#rp-support-genre-2"),
        ].forEach((select) => {
            select?.addEventListener("change", syncGenreSelectionFromControls);
        });

        popupRoot
            .querySelector("#rp-director-next-btn")
            ?.addEventListener("click", () =>
                advanceGenreDirector({ force: true, nextCue: true })
            );
        popupRoot
            .querySelector("#rp-director-lock-btn")
            ?.addEventListener("click", toggleGenreDirectorLock);
        popupRoot
            .querySelector("#rp-director-cadence")
            ?.addEventListener("change", (event) =>
                changeGenreDirectorCadence(event.currentTarget.value)
            );
        popupRoot
            .querySelector("#rp-custom-genre-add-btn")
            ?.addEventListener("click", addCustomGenre);
        popupRoot.addEventListener("click", (event) => {
            const deleteButton = event.target.closest(".rp-custom-genre-delete");
            if (deleteButton) deleteCustomGenre(deleteButton.dataset.id);
        });
        renderCustomGenreList();
        updateGenreDirectorPanel();

        // AI event generator controls
        popupRoot
            .querySelector("#rp-event-generate-btn")
            ?.addEventListener("click", generateEventCandidate);
        popupRoot
            .querySelector("#rp-event-regenerate-btn")
            ?.addEventListener("click", generateEventCandidate);
        popupRoot
            .querySelector("#rp-event-insert-btn")
            ?.addEventListener("click", insertEventIntoComposer);
        popupRoot
            .querySelector("#rp-event-inject-btn")
            ?.addEventListener("click", injectEventAndGenerateReply);
    }, 50);
}

function addWandMenuButton() {
    if (document.getElementById("rp-open-booster")) return true; // already attached

    const menu = document.getElementById("extensionsMenu");
    if (!menu) return false; // not in the DOM yet

    const button = document.createElement("div");
    button.id = "rp-open-booster";
    button.className = "list-group-item flex-container flexGap5 interactable";
    button.tabIndex = 0;
    button.innerHTML = `
        <div class="fa-solid fa-fw fa-dice extensionsMenuExtensionButton"></div>
        스토리부스터
    `;
    // no listener attached here on purpose — see delegated listener in init,
    // which survives even if ST re-renders/replaces this element later.

    menu.appendChild(button);
    console.log(`[${MODULE_NAME}] wand menu button attached`);
    return true;
}

// #extensionsMenu is sometimes rendered after this script runs, so retry
// on an interval until it exists, then stop.
function attachWandMenuButtonWithRetry() {
    let attempts = 0;
    const maxAttempts = 40; // ~20s at 500ms
    const interval = setInterval(() => {
        attempts++;
        if (addWandMenuButton() || attempts >= maxAttempts) {
            clearInterval(interval);
            if (attempts >= maxAttempts) {
                console.error(`[${MODULE_NAME}] could not find #extensionsMenu after ${maxAttempts} attempts`);
            }
        }
    }, 500);
}

// ----------------------------------------------------------------------
// 6. INIT
// ----------------------------------------------------------------------

jQuery(async () => {
    try {
        console.log(`[${MODULE_NAME}] initializing`);

        attachWandMenuButtonWithRetry();

        // delegated listener: works even if #rp-open-booster gets re-created
        // by SillyTavern re-rendering the wand menu later.
        document.addEventListener("click", (e) => {
            if (e.target.closest("#rp-open-booster")) {
                openBoosterPopup();
            }
        });

        // apply genre prompt for whichever chat is open at load time
        updateGenrePrompt();

        // A received assistant message consumes the one-shot plot injection
        // and advances the dynamic genre cue for the following response.
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            try {
                clearPlotPromptIfPending();
                advanceGenreDirector();
            } catch (err) {
                console.error(`[${MODULE_NAME}] error in MESSAGE_RECEIVED handler:`, err);
            }
        });

        // when the user switches chats, reload state for the NEW chat and
        // discard any leftover one-shot plot injection from the previous chat
        eventSource.on(event_types.CHAT_CHANGED, () => {
            plotPending = false;
            setExtensionPrompt(PLOT_PROMPT_KEY, "", extension_prompt_types.IN_CHAT, 0);
            updateGenrePrompt();
            updateGenreDirectorPanel();
        });

        console.log(`[${MODULE_NAME}] initialized successfully`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] failed to initialize:`, err);
    }
});
