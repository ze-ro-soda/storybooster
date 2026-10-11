// StoryBooster: core/constants.js


// @source-order 2
const MODULE_NAME = "rp-genre-plot-booster";

// @source-order 3
const STORYBOOSTER_VERSION = "1.7.3";

// @source-order 4
const GENRE_PROMPT_KEY = "rp_genre_boost";

// @source-order 5
const PLOT_PROMPT_KEY = "rp_plot_trigger";

// @source-order 6
const DEFAULT_AUDIT_INTERVAL = 10;

// @source-order 7
const MIN_AUDIT_INTERVAL = 5;

// @source-order 8
const MAX_AUDIT_INTERVAL = 15;

// @source-order 9
const GENRE_AUDIT_RESPONSE_LIMIT = 10;

// @source-order 10
const AUDIT_EVIDENCE_MAX_ITEMS = 4;

// @source-order 11
const PRIMARY_GENRE_EVIDENCE_RATIO = 0.375;

// @source-order 12
const GENRE_EXPRESSION_EVIDENCE_MINIMUM = 4;

// @source-order 13
const SCENE_DENSITY_EVIDENCE_MINIMUM = 4;

// @source-order 14
const SUPPORT_GENRE_EVIDENCE_MINIMUM = 2;

// @source-order 15
const CHARACTER_CONSISTENCY_POSITIVE_EVIDENCE_MINIMUM = 4;

// @source-order 16
const CHARACTER_INTERPRETATION_POSITIVE_EVIDENCE_MINIMUM = 3;

// @source-order 17
const CHARACTER_INTERPRETATION_FAILURE_EVIDENCE_MINIMUM = 2;

// @source-order 18
const CHARACTER_AGENCY_EVIDENCE_MINIMUM = 4;

// @source-order 19
const CHARACTER_RELATIONSHIP_EVIDENCE_MINIMUM = 3;

// @source-order 20
const CHARACTER_CONTINUITY_EVIDENCE_MINIMUM = 4;

// @source-order 21
const GENRE_FAILURE_EVIDENCE_MINIMUM = 3;

// @source-order 22
const CHARACTER_FAILURE_EVIDENCE_MINIMUM = 2;

// @source-order 23
const RELATIONSHIP_FAILURE_EVIDENCE_MINIMUM = 2;

// @source-order 24
const CONTINUITY_FAILURE_EVIDENCE_MINIMUM = 2;

// @source-order 25
const REPETITION_GENERAL_EVIDENCE_MINIMUM = 3;

// @source-order 26
const REPETITION_EXACT_EVIDENCE_MINIMUM = 2;

// @source-order 27
const CHARACTER_BASELINE_FIELD_MAX_CHARS = 1000;

// @source-order 28
const CHARACTER_BOOST_ANCHOR_MAX_CHARS = 700;

// @source-order 29
const CHARACTER_CORRECTION_MAX_CHARS = 1800;

// @source-order 30
const CHARACTER_CORRECTION_MAX_WORDS = 220;

// @source-order 31
const CHARACTER_BASELINE_AUTOSAVE_DELAY = 700;

// @source-order 32
const CHARACTER_CARD_INPUT_MAX_CHARS = 24000;

// @source-order 33
const CHARACTER_REVISION_TRANSCRIPT_MAX_CHARS = 90000;

// @source-order 34
const CHARACTER_REVISION_ASSISTANT_REPLIES = 20;

// @source-order 35
const CHARACTER_REVISION_NOTE_MAX_CHARS = 1200;

// @source-order 36
const CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS = 40;

// @source-order 37
const MAX_CHARACTER_BASELINE_VERSIONS = 10;

// @source-order 38
const DEFAULT_PLOT_MAX_TOKENS = 1200;

// @source-order 39
const MIN_PLOT_MAX_TOKENS = 200;

// @source-order 40
const MAX_PLOT_MAX_TOKENS = 4000;

// @source-order 41
const MAX_PLOT_HISTORY = 5;

// @source-order 42
const MAX_PLOT_GENERATION_ATTEMPTS = 3;

// @source-order 43
const AUDIT_MESSAGE_MAX_CHARS = 5000;

// @source-order 44
const PLOT_CONTEXT_MESSAGE_LIMIT = 10;

// @source-order 45
const PLOT_MESSAGE_MAX_CHARS = 4500;

// @source-order 46
const GENRE_RECOMMENDATION_MESSAGE_LIMIT = 10;

// @source-order 47
const GENRE_RECOMMENDATION_MESSAGE_MAX_CHARS = 3500;

// @source-order 48
const BACKGROUND_REQUEST_TIMEOUT_MS = 180000;

// @source-order 49
const ERROR_LOG_STORAGE_KEY = `${MODULE_NAME}:error-diagnostic-log`;

// @source-order 50
const MAX_ERROR_LOG_ENTRIES = 3;

// @source-order 90
const CHARACTER_BASELINE_FIELDS = Object.freeze([
    {
        id: "core_identity",
        label: "핵심 정체성",
        prompt: "The defining identity, central disposition, and enduring tension or contrast that makes the character recognizable across situations. Exclude biography or plot role unless it directly governs behavior.",
    },
    {
        id: "personality_traits",
        label: "성격·특성",
        prompt: "Major traits, coexisting or contradictory tendencies, and the conditions that bring each tendency forward. Preserve deliberate simplicity instead of inventing complexity.",
    },
    {
        id: "values_boundaries",
        label: "가치관·경계",
        prompt: "Values, priorities, taboos, personal boundaries, and the supported conditions under which the character defends, bends, or crosses them.",
    },
    {
        id: "goals_motives",
        label: "목표·동기",
        prompt: "Durable wants and avoidances, what is at stake for the character, and the supported triggers that can move them to choose or act.",
    },
    {
        id: "behavior_decisions",
        label: "행동·의사결정",
        prompt: "Decision style, problem-solving, initiative, practical abilities or limits, and behavior the character tends to choose or avoid. Distinguish consequential choice from mere activity.",
    },
    {
        id: "speech_emotion",
        label: "대사·감정 표현",
        prompt: "Speech rhythm, vocabulary, dialogue habits, and how the character reveals, hides, redirects, or defends emotion. Separate distinctive voice from incidental wording.",
    },
    {
        id: "relationship_response",
        label: "관계 반응",
        prompt: "How shared history, trust, distance, attachment, conflict, power, and boundaries change the character's responses to the persona and other people, including relationship-specific differences.",
    },
]);

// @source-order 91
const CHARACTER_BASELINE_FIELD_IDS = Object.freeze(
    CHARACTER_BASELINE_FIELDS.map((field) => field.id)
);

// @source-order 92
const CHARACTER_BASELINE_FIELD_ID_SET = new Set(CHARACTER_BASELINE_FIELD_IDS);

// @source-order 93
const CHARACTER_BASELINE_CORRECTION_CODES = new Set([
    "character_consistency",
    "character_interpretation",
    "char_agency",
    "relationship",
]);

// @source-order 94
const CHARACTER_CORRECTION_FIELD_FALLBACKS = Object.freeze({
    character_consistency: ["core_identity", "personality_traits"],
    character_interpretation: ["core_identity", "personality_traits"],
    char_agency: ["goals_motives", "behavior_decisions"],
    relationship: ["relationship_response", "values_boundaries"],
});

// @source-order 96
const DEFAULT_GENRES = [
    { id: "slice_of_life", label: "일상", promptLabel: "Slice of Life", emoji: "🏡", group: "story", enabled: false },
    { id: "romance", label: "로맨스", promptLabel: "Romance", emoji: "❤️", group: "story", enabled: false },
    { id: "romcom", label: "롬콤", promptLabel: "Romantic Comedy", emoji: "💞", group: "story", enabled: false },
    { id: "drama", label: "드라마", promptLabel: "Drama", emoji: "🎭", group: "story", enabled: false },
    { id: "mystery", label: "미스터리", promptLabel: "Mystery", emoji: "🕵️", group: "story", enabled: false },
    { id: "action", label: "액션", promptLabel: "Action", emoji: "⚡", group: "story", enabled: false },
    { id: "adventure", label: "모험", promptLabel: "Adventure", emoji: "🧭", group: "story", enabled: false },
    { id: "horror", label: "공포", promptLabel: "Horror", emoji: "👁️", group: "story", enabled: false },
    { id: "thriller", label: "스릴러", promptLabel: "Thriller", emoji: "🏃", group: "story", enabled: false },
    { id: "crime", label: "범죄", promptLabel: "Crime", emoji: "🚨", group: "story", enabled: false },
    { id: "psychological", label: "심리", promptLabel: "Psychological", emoji: "🧠", group: "story", enabled: false },
    { id: "political_intrigue", label: "정치극·권모술수", promptLabel: "Political Intrigue", emoji: "♟️", group: "story", enabled: false },
    { id: "survival", label: "생존", promptLabel: "Survival", emoji: "🧰", group: "story", enabled: false },
    { id: "coming_of_age", label: "성장", promptLabel: "Coming-of-Age", emoji: "🌱", group: "story", enabled: false },
    { id: "tragedy", label: "비극", promptLabel: "Tragedy", emoji: "🥀", group: "story", enabled: false },
    { id: "comedy", label: "코미디", promptLabel: "Comedy", emoji: "😂", group: "tone", enabled: false },
    { id: "angst", label: "앵스트", promptLabel: "Angst", emoji: "💔", group: "tone", enabled: false },
    { id: "dark", label: "다크", promptLabel: "Dark", emoji: "🌑", group: "tone", enabled: false },
    { id: "dead_dove", label: "데드 도브", promptLabel: "Dead Dove: Do Not Eat", emoji: "⚠️", group: "tone", enabled: false },
    { id: "healing", label: "힐링", promptLabel: "Healing", emoji: "🌿", group: "tone", enabled: false },
    { id: "suspense", label: "서스펜스", promptLabel: "Suspense", emoji: "⏳", group: "tone", enabled: false },
    { id: "gothic", label: "고딕", promptLabel: "Gothic", emoji: "🕯️", group: "tone", enabled: false },
    { id: "noir", label: "느와르", promptLabel: "Noir", emoji: "🌃", group: "tone", enabled: false },
    { id: "cozy", label: "코지", promptLabel: "Cozy", emoji: "🫖", group: "tone", enabled: false },
    { id: "melancholic", label: "멜랑콜리", promptLabel: "Melancholic", emoji: "🌧️", group: "tone", enabled: false },
    { id: "sexual_tension", label: "섹텐", promptLabel: "Sexual Tension", emoji: "🔥", group: "tone", enabled: false },
    { id: "desire", label: "욕망", promptLabel: "Desire", emoji: "❤️‍🔥", group: "tone", enabled: false },
    { id: "adult", label: "NSFW", promptLabel: "NSFW / Explicit Adult", emoji: "🔞", group: "tone", enabled: false },
    { id: "fantasy", label: "판타지", promptLabel: "Fantasy", emoji: "🧙", group: "world", enabled: false },
    { id: "scifi", label: "SF", promptLabel: "Science Fiction", emoji: "🚀", group: "world", enabled: false },
    { id: "historical", label: "시대극", promptLabel: "Historical", emoji: "📜", group: "world", enabled: false },
    { id: "supernatural", label: "초자연", promptLabel: "Supernatural", emoji: "👻", group: "world", enabled: false },
    { id: "urban_fantasy", label: "어반 판타지", promptLabel: "Urban Fantasy", emoji: "🏙️", group: "world", enabled: false },
    { id: "cyberpunk", label: "사이버펑크", promptLabel: "Cyberpunk", emoji: "🤖", group: "world", enabled: false },
    { id: "post_apocalyptic", label: "포스트 아포칼립스", promptLabel: "Post-Apocalyptic", emoji: "☢️", group: "world", enabled: false },
    { id: "eastern_fantasy", label: "동양 판타지", promptLabel: "Eastern Fantasy", emoji: "🐉", group: "world", enabled: false },
];

// @source-order 97
const GENRE_GROUPS = Object.freeze([
    { id: "story", label: "이야기 장르" },
    { id: "tone", label: "분위기·톤" },
    { id: "world", label: "세계관" },
    { id: "custom", label: "내가 추가한 장르" },
]);

// @source-order 98
const GENRE_PROFILES = Object.freeze({
    slice_of_life: {
        identity: "Let ordinary routines, small needs, and lived-in surroundings carry meaningful change.",
        ui: "일상적인 행동과 작은 필요 속에서 관계와 상황이 조금씩 변합니다.",
        signals: "Use practical tasks, familiar habits, minor inconveniences, casual encounters, and quiet choices.",
        effects: "Make everyday behavior reveal priorities and gradually alter relationships or circumstances.",
        texture: "Favor concrete domestic, social, and environmental detail with an unhurried rhythm.",
        guard: "Do not confuse quietness with stasis or manufacture a major incident to make the scene matter.",
    },
    romance: {
        identity: "Make emotional attraction and the changing relationship the scene's central source of meaning.",
        ui: "감정적 끌림과 관계의 변화가 캐릭터의 선택과 장면 의미의 중심이 됩니다.",
        signals: "Use gaze, distance, silence, verbal aftertones, cautious contact, vulnerability, and misaligned intentions.",
        effects: "Let {{char}}'s choices change trust, intimacy, boundaries, or emotional distance.",
        texture: "Give gestures, pauses, proximity, and remembered details relational weight.",
        guard: "Do not reduce romance to generic affection, instant intimacy, or a fixed trope detached from characterization.",
    },
    romcom: {
        identity: "Keep romantic progression central while character-driven comic friction changes how the pair approach, misread, and understand each other.",
        ui: "로맨스의 관계 진전을 중심에 두고, 캐릭터다운 엇갈림과 타이밍이 웃음과 친밀감의 변화를 함께 만듭니다.",
        signals: "Use banter, awkward proximity, mismatched intentions, embarrassment, reversals, and callbacks that expose attraction or vulnerability.",
        effects: "Let {{char}} pursue a relational want through a flawed choice whose comic consequence changes trust, intimacy, or distance.",
        texture: "Balance buoyant comic timing with sincere pauses, charged gestures, and specific emotional aftereffects.",
        guard: "Do not become generic comedy, decorative romance, random slapstick, humiliating spectacle, or constant quipping that erases sincere stakes.",
    },
    drama: {
        identity: "Drive the scene through incompatible desires and the emotional or practical cost of choosing.",
        ui: "서로 충돌하는 욕망과 선택의 감정적·현실적 대가를 강화합니다.",
        signals: "Use confrontations, withheld truths, obligations, reversals, difficult admissions, and visible fallout.",
        effects: "Force priorities into conflict and let decisions leave relational consequences.",
        texture: "Emphasize charged dialogue, behavioral tells, and consequences that remain after the peak emotion.",
        guard: "Do not substitute arbitrary melodrama, constant shouting, or suffering without causal roots.",
    },
    comedy: {
        identity: "Create humor from character-consistent friction between intentions, timing, and consequences.",
        ui: "캐릭터다운 의도와 어긋난 타이밍·결과에서 상황적 웃음을 만듭니다.",
        signals: "Use mismatched attitudes, misunderstandings, reversals, awkward precision, callbacks, and escalating practical complications.",
        effects: "Let {{char}} actively commit to choices whose consequences sharpen the comic situation.",
        texture: "Favor clear setup, economical timing, contrast, and concrete reactions.",
        guard: "Do not break characterization, acknowledge the audience, or turn every line into a joke.",
    },
    angst: {
        identity: "Let sustained pain, longing, guilt, fear, grief, or an unresolved wound press on choices and relationships without predetermining tragedy.",
        ui: "상실·죄책감·두려움·그리움 같은 지속적인 정서적 고통이 선택과 관계에 구체적인 압력을 줍니다.",
        signals: "Use painful restraint, avoidance, failed connection, defensive choices, charged silence, remembered hurt, and difficult admissions.",
        effects: "Let {{char}} protect, reject, reach for, conceal, or withdraw in character-specific ways that change trust, distance, boundaries, or the next choice.",
        texture: "Favor precise subtext, restrained heaviness, negative space, bodily tension, and concrete reminders of what is feared, lost, or wanted.",
        guard: "Do not confuse angst with tragedy, melancholy, generic sadness, repetitive crying, arbitrary suffering, forced misunderstanding, or passive misery.",
    },
    mystery: {
        identity: "Organize attention around an unresolved question that can be investigated through information and inference.",
        ui: "해결되지 않은 의문을 중심으로 단서·모순·추론과 정보 변화를 강화합니다.",
        signals: "Use meaningful clues, omissions, contradictions, concealed motives, patterns, and partial revelations.",
        effects: "Make new information alter suspicion, interpretation, trust, or the next investigative choice.",
        texture: "Direct attention toward specific details whose significance can change over time.",
        guard: "Do not solve the question immediately, hide everything arbitrarily, or treat danger alone as mystery.",
    },
    action: {
        identity: "Advance the situation through physical objectives, movement, danger, and immediate tactical decisions.",
        ui: "위치와 움직임이 선명한 위험 속에서 즉각적인 판단과 대응으로 상황을 바꿉니다.",
        signals: "Keep positions, distance, momentum, obstacles, capabilities, and cause-and-effect responses clear.",
        effects: "Make {{char}} choose, commit, adapt, and accept concrete physical or strategic consequences.",
        texture: "Use precise spatial verbs, changing tempo, and selective impact detail.",
        guard: "Do not replace spatial logic with vague spectacle or make danger consequence-free.",
    },
    dark: {
        identity: "Give choices moral weight through unease, compromise, and consequences that are difficult to reverse.",
        ui: "도덕적 불편함과 타협, 되돌리기 어려운 선택의 무게를 강화합니다.",
        signals: "Use coercive circumstances, damaged trust, ominous implications, costly bargains, and constrained hope.",
        effects: "Make {{char}} confront what they will sacrifice, tolerate, or become.",
        texture: "Favor restrained heaviness, unsettling detail, and aftermath over constant intensity.",
        guard: "Do not equate darkness with contextless cruelty, gore, or universal hopelessness.",
    },
    dead_dove: {
        identity: "Treat established disturbing, transgressive, morally compromised, or harmful material without sanitizing it or granting automatic absolution.",
        ui: "이미 설정된 불편하거나 금기적인 소재를 순화·미화·자동 면죄하지 않고, 명시된 그대로의 무게와 결과를 유지합니다.",
        signals: "When relevant, show power imbalance, coercion, obsession, cruelty, complicity, taboo, or harm through concrete behavior and consequences.",
        effects: "Let {{char}}'s established motives expose control, vulnerability, complicity, fixation, damage, or irreversible cost without reducing anyone to a stock monster or victim.",
        texture: "Use unflinching specificity, sustained discomfort, charged silence, visceral detail, and credible aftermath at the intensity established by context.",
        guard: "Preserve existing material; do not invent a taboo, unrelated abuse or gore, automatic escalation, erased consequences, or forced disturbing content.",
    },
    fantasy: {
        identity: "Make magic, wondrous places, and setting-specific cultures tangible forces in everyday life.",
        ui: "마법과 고유 문화·세계 규칙이 삶과 관계, 선택에 실제로 작용합니다.",
        signals: "Use consistent magical rules, obligations, costs, artifacts, customs, creatures, and altered possibilities.",
        effects: "Let the world's supernatural logic shape {{char}}'s choices, relationships, opportunities, and consequences.",
        texture: "Render wonder through specific material, sensory, social, and ritual detail.",
        guard: "Do not rely on generic spectacle, unexplained convenience, or unrelated lore dumps.",
    },
    scifi: {
        identity: "Explore how technology, scientific possibility, social systems, or unfamiliar environments reshape life.",
        ui: "기술·사회 시스템·낯선 환경의 논리가 삶과 관계의 가능성과 문제를 바꿉니다.",
        signals: "Use functional technology, institutional adaptation, new constraints, unintended effects, and extrapolated social practices.",
        effects: "Make the setting's logic change what {{char}} can know, choose, risk, or value.",
        texture: "Ground unfamiliar concepts in practical use, material detail, and human consequence.",
        guard: "Do not treat futuristic decoration or unexplained gadgets as sufficient genre expression.",
    },
    adventure: {
        identity: "Drive change through purposeful movement into unfamiliar places, challenges, and discoveries.",
        ui: "목적 있는 이동과 탐험, 장애와 발견을 통해 상황과 관계를 변화시킵니다.",
        signals: "Use travel goals, changing terrain, navigation, practical obstacles, discoveries, and rewards that open possibilities.",
        effects: "Make each stage of the journey alter resources, knowledge, relationships, or the objective.",
        texture: "Emphasize place, distance, preparation, discovery, and the feeling of forward movement.",
        guard: "Do not confuse wandering or repeated combat with an adventure that changes the situation.",
    },
    horror: {
        identity: "Build fear from vulnerability before a threat whose nature, reach, or rules remain partly uncertain.",
        ui: "불완전하게 이해되는 위협과 취약성, 감각적 징후를 통해 공포를 축적합니다.",
        signals: "Use restrained sensory evidence, violated safety, anomalous behavior, failed assumptions, exposure, and lingering consequences.",
        effects: "Make {{char}}'s attempts to understand or survive reveal limits and increase meaningful risk.",
        texture: "Control absence, silence, space, bodily awareness, and delayed recognition.",
        guard: "Do not rely on arbitrary gore, random shocks, or omnipotent threats without usable logic.",
    },
    healing: {
        identity: "Center credible recovery through care, safety, honesty, and gradual repair.",
        ui: "돌봄과 안전, 정직한 관계 수선을 통해 점진적이고 실제적인 회복을 만듭니다.",
        signals: "Use attentive acts, boundaries, rest, practical support, difficult openness, and modest signs of renewed trust.",
        effects: "Let comfort change what {{char}} can admit, attempt, accept, or offer.",
        texture: "Use warm but specific sensory detail and quiet behavioral change.",
        guard: "Do not erase conflict, trauma, or consequences through instant reassurance.",
    },
    suspense: {
        identity: "Sustain anticipation around an unresolved outcome whose danger or cost is drawing nearer.",
        ui: "다가오는 위험이나 결과를 기다리는 불안과 예상을 지속적으로 끌어갑니다.",
        signals: "Use warning signs, delayed confirmation, near misses, time pressure, incomplete information, and narrowing safety.",
        effects: "Make each choice change what may happen and how long the characters have to prevent it.",
        texture: "Stretch attention across timing, thresholds, silence, distance, and small changes.",
        guard: "Do not require constant pursuit or action; the tension must come from a credible pending outcome.",
    },
    historical: {
        identity: "Make the period's material conditions, institutions, and social assumptions active forces in the story.",
        ui: "시대의 생활 조건·제도·관습과 위계가 선택과 관계를 실제로 제한합니다.",
        signals: "Use period-specific work, objects, etiquette, hierarchy, law, communication, travel, and limitations.",
        effects: "Let historical conditions constrain {{char}}'s choices, status, relationships, and consequences.",
        texture: "Favor lived material and social detail over encyclopedic explanation.",
        guard: "Do not use modern assumptions unchanged or reduce the period to costume and vocabulary.",
    },
    supernatural: {
        identity: "Let the uncanny intrude on ordinary reality through forces that exceed conventional explanation.",
        ui: "일상에 침입한 기이한 징후·존재·의식과 불완전한 규칙을 강화합니다.",
        signals: "Use recurring signs, thresholds, rituals, entities, taboos, bargains, and costs with partial consistency.",
        effects: "Make contact with the uncanny alter belief, behavior, relationships, or safety.",
        texture: "Emphasize disturbed familiarity, charged objects, liminal spaces, and uncertain causality.",
        guard: "Do not turn every anomaly into generic magic or explain away all uncertainty immediately.",
    },
    thriller: {
        identity: "Escalate a contest of survival, exposure, or control through active danger and shrinking options.",
        ui: "추적·마감·반전과 좁아지는 선택지로 능동적인 위험과 압박을 높입니다.",
        signals: "Use pursuit, deadlines, reversals, traps, leverage, compromised plans, and credible adversarial pressure.",
        effects: "Make each decision alter the balance of risk and force the next commitment.",
        texture: "Favor urgent causality, strategic awareness, and sharply changing control.",
        guard: "Do not confuse vague anxiety or disconnected twists with sustained adversarial pressure.",
    },
    crime: {
        identity: "Center wrongdoing and its practical effects on trust, power, evidence, and accountability.",
        ui: "범죄의 동기·증거·은폐·제도와 현실적 대가가 신뢰와 힘의 균형을 바꿉니다.",
        signals: "Use motives, opportunity, concealment, leverage, witnesses, evidence, institutions, networks, and legal or social exposure.",
        effects: "Let criminal choices reshape {{char}}'s loyalties, options, risk, and relationships.",
        texture: "Ground pressure in procedures, material traces, compromised spaces, and unequal power.",
        guard: "Do not treat any danger as crime; keep wrongdoing, concealment, or accountability materially relevant.",
    },
    psychological: {
        identity: "Build tension from perception, repression, self-deception, fixation, and conflicting interpretations.",
        ui: "인식·억압·자기기만·집착과 해석의 충돌이 행동과 관계를 흔듭니다.",
        signals: "Use behavioral contradiction, distorted attention, defensive patterns, intrusive associations, projection, and unreliable certainty.",
        effects: "Make inner conflict shape {{char}}'s choices and how relationships are interpreted.",
        texture: "Use selective subjectivity, recurring detail, subtext, and gaps between action and explanation.",
        guard: "Do not make behavior arbitrary, equate psychology with exposition, or use diagnosis as shorthand.",
    },
    political_intrigue: {
        identity: "Drive change through competing interests, alliances, legitimacy, reputation, and asymmetric power.",
        ui: "이해관계·동맹·평판·협상과 비대칭 권력이 선택의 결과를 좌우합니다.",
        signals: "Use negotiation, favors, secrets, factions, public positioning, private leverage, and institutional constraints.",
        effects: "Make {{char}} weigh loyalty, appearance, access, and strategic consequence in every commitment.",
        texture: "Give language, protocol, audience, and status practical significance.",
        guard: "Do not reduce politics to random betrayal or detached lore about offices and factions.",
    },
    survival: {
        identity: "Make continued safety depend on scarce resources, practical knowledge, and costly tradeoffs.",
        ui: "자원·부상·환경·시간과 생존을 위한 현실적인 대가를 지속적으로 반영합니다.",
        signals: "Track shelter, injury, terrain, weather, time, fatigue, supplies, exposure, and maintenance.",
        effects: "Keep {{char}} resourceful and proactive while each solution consumes something or creates a constraint.",
        texture: "Use bodily condition, material limits, distance, and environmental feedback.",
        guard: "Do not grant convenient resources, ignore accumulated strain, or use danger without logistical consequence.",
    },
    coming_of_age: {
        identity: "Track identity and maturity through experience, responsibility, error, and changing self-understanding.",
        ui: "실수와 책임, 시험받는 가치관을 거치며 이후 선택과 관계가 달라집니다.",
        signals: "Use tested values, first consequences, shifting loyalties, new responsibilities, disillusionment, and earned confidence.",
        effects: "Let experience visibly alter {{char}}'s later choices, boundaries, and relationships.",
        texture: "Balance immediacy with reflection grounded in changed behavior.",
        guard: "Do not announce growth abstractly or resolve it through one lesson without lasting change.",
    },
    tragedy: {
        identity: "Build irreversible loss from understandable motives, flaws, obligations, and choices.",
        ui: "이해 가능한 동기와 의무·결함·선택이 되돌릴 수 없는 상실로 이어집니다.",
        signals: "Use conflicting duties, missed chances, costly knowledge, narrowing alternatives, and consequences that cannot be fully repaired.",
        effects: "Let {{char}} act meaningfully even when every available choice carries loss.",
        texture: "Give inevitability emotional clarity through causality, restraint, and aftermath.",
        guard: "Do not substitute arbitrary suffering, helplessness, or sudden punishment for tragic causation.",
    },
    gothic: {
        identity: "Bind oppressive intimacy and buried history to spaces, inheritance, beauty, and dread.",
        ui: "퇴락한 공간과 묻힌 역사, 상속된 부담이 친밀감과 공포를 압박합니다.",
        signals: "Use decaying places, family or institutional secrets, confinement, doubling, taboo, obsession, and inherited burdens.",
        effects: "Make the setting press on {{char}}'s relationships, memory, identity, and freedom.",
        texture: "Favor sensuous decay, architectural pressure, charged silence, and haunted repetition.",
        guard: "Do not use ornate gloom as decoration without a historical or relational burden.",
    },
    noir: {
        identity: "Frame desire and survival within compromised loyalties, unequal power, and moral ambiguity.",
        ui: "타협된 충성·불평등한 힘·위험한 끌림과 도덕적 모호함을 강화합니다.",
        signals: "Use leverage, corruption, dangerous attraction, private codes, betrayal, debt, and choices with no clean outcome.",
        effects: "Make {{char}} reveal what principle, person, or self-image they will compromise.",
        texture: "Use sharp observation, restraint, urban pressure, and consequence-heavy dialogue.",
        guard: "Do not mistake empty cynicism, darkness, or detective props for noir.",
    },
    cozy: {
        identity: "Create meaningful movement within intimate spaces, familiar routines, mutual care, and manageable stakes.",
        ui: "친밀한 공간과 익숙한 일상, 돌봄과 감당 가능한 문제 속에서 변화를 만듭니다.",
        signals: "Use shared tasks, food, local customs, small obligations, familiar faces, comforts, and solvable disruptions.",
        effects: "Let modest choices strengthen belonging, trust, competence, or community ties.",
        texture: "Favor tactile comfort, local detail, gentle rhythm, and socially specific warmth.",
        guard: "Do not remove all tension or confuse coziness with inactive sweetness.",
    },
    melancholic: {
        identity: "Sustain movement under the weight of absence, memory, fading possibility, and quiet longing.",
        ui: "부재·기억·사라지는 가능성과 절제된 그리움을 품은 채 장면을 이어갑니다.",
        signals: "Use missed timing, preserved objects, changed places, restrained admissions, tenderness, and choices shaped by loss.",
        effects: "Let {{char}} act despite what cannot be restored, revealing attachment through restraint.",
        texture: "Favor concrete reminders, negative space, subdued rhythm, and bittersweet sensory detail.",
        guard: "Do not turn melancholy into static sadness or erase loss with easy reassurance.",
    },
    sexual_tension: {
        identity: "Build unresolved sexual anticipation through mutual awareness, restraint, and the possibility of crossing a boundary.",
        ui: "시선·거리·접촉과 절제를 통해 해소 전의 아슬한 성적 긴장을 축적합니다.",
        signals: "Use charged proximity, gaze, teasing or double-edged dialogue, interrupted moments, deliberate restraint, and meaningful touch.",
        effects: "Let {{char}} test, approach, retreat, or intensify the tension through character-specific choices.",
        texture: "Focus on timing, breath, distance, attention, and sensory details that heighten anticipation.",
        guard: "Favor accumulation over immediate payoff; do not assume mutual response or replace chemistry with generic explicitness.",
    },
    desire: {
        identity: "Make wanting someone a psychologically consequential force that competes with restraint, pride, fear, or duty.",
        ui: "갈망·집착·충동과 절제의 충돌이 캐릭터의 선택과 위험 감수를 바꿉니다.",
        signals: "Use yearning, fixation, possessiveness, temptation, intrusive attention, denial, and conflict between impulse and control.",
        effects: "Let desire expose {{char}}'s priorities and change what they risk, conceal, demand, or refuse.",
        texture: "Use recurring attention, charged absence, bodily awareness, and emotionally specific longing.",
        guard: "Do not reduce desire to instant gratification, generic lust, or ownership without character logic.",
    },
    adult: {
        identity: "Treat established sexual desire and physical intimacy between adult characters as fully on-page NSFW narrative content rather than fade-to-black implication.",
        ui: "성인 캐릭터 사이의 성적 욕망과 신체적 친밀감을 생략·암전·완곡한 요약 없이 이어지는 NSFW 장면으로 강화합니다.",
        signals: "Once an NSFW encounter is underway, sustain it through connected actions, reactions, dialogue, changing positions, embodied arousal, and character-specific preferences or limits.",
        effects: "Keep the interaction responsive to {{char}}'s motives, personality, trust, vulnerability, power dynamics, and relational consequences.",
        texture: "Use direct physical language, clear spatial continuity, and specific sensory and emotional detail across multiple connected beats.",
        guard: "Do not sanitize, euphemize, summarize, fade out, skip ahead, or prematurely end an active NSFW scene; preserve characterization and roleplay continuity.",
    },
    urban_fantasy: {
        identity: "Interweave hidden supernatural systems with recognizable modern city life, technology, and institutions.",
        ui: "현대 도시의 일상·기술·제도와 숨겨진 초자연 질서가 서로 영향을 줍니다.",
        signals: "Use concealed communities, magical jurisdiction, urban territory, mundane logistics, secrecy, and supernatural consequences inside modern systems.",
        effects: "Make {{char}} navigate obligations and risks created by both ordinary and supernatural structures.",
        texture: "Juxtapose everyday urban material with specific uncanny rules and hidden social layers.",
        guard: "Do not present generic fantasy in a city backdrop; modern systems must actively interact with the supernatural.",
    },
    cyberpunk: {
        identity: "Make advanced technology inseparable from surveillance, corporate power, inequality, and control over bodies or information.",
        ui: "기술·감시·기업 권력·신체 개조와 불평등이 삶과 정체성을 통제합니다.",
        signals: "Use data ownership, implants, mediated identity, privatized systems, black markets, monitoring, and unequal access.",
        effects: "Let systems determine what {{char}} can hide, buy, become, resist, or lose.",
        texture: "Combine dense technological materiality with social precarity and contested identity.",
        guard: "Do not reduce cyberpunk to neon, gadgets, or generic futuristic crime without systemic power.",
    },
    post_apocalyptic: {
        identity: "Show how life after systemic collapse reshapes value, memory, community, and survival.",
        ui: "붕괴 이후의 자원·폐허·공동체와 과거의 기억이 생존과 재건의 우선순위를 바꿉니다.",
        signals: "Use ruins, fragile infrastructure, scavenging, improvised governance, scarce expertise, old-world remnants, and contested rebuilding.",
        effects: "Make {{char}} choose between immediate survival, trust, preservation, and the kind of future to build.",
        texture: "Ground loss and adaptation in material reuse, broken systems, distance, and remembered normality.",
        guard: "Do not treat ruins as scenery while resources, institutions, and social order function normally.",
    },
    eastern_fantasy: {
        identity: "Build an East Asian-inspired fantastical order from cosmology, cultivation, lineage, duty, court, and spiritual practice.",
        ui: "동아시아풍 우주관·수행·문파·혈통·의무와 영적 규칙이 선택과 관계를 형성합니다.",
        signals: "Use internally consistent qi or spiritual rules, sects, clans, vows, ritual status, martial traditions, courts, and karmic or ancestral obligations.",
        effects: "Let honor, hierarchy, cultivation, and spiritual consequence shape {{char}}'s choices and relationships.",
        texture: "Use setting-specific ritual, material culture, landscape, address, and disciplined bodily detail.",
        guard: "Do not rely on interchangeable exotic imagery or mix traditions without coherent world rules and social consequence.",
    },
});

// @source-order 99
const EVENT_CATEGORIES = [
    { id: "discovery", label: "정보·발견", promptLabel: "Information and Discovery", emoji: "💡", direction: "Reveal a concrete fact, discovery, or usable piece of information that changes what the characters can understand or do." },
    { id: "clue", label: "비밀·단서", promptLabel: "Secrets and Clues", emoji: "🔍", direction: "Introduce a secret, trace, contradiction, or clue that deepens an unresolved question rather than immediately answering it." },
    { id: "npc", label: "제3자 개입", promptLabel: "Third-Party Intervention", emoji: "👥", direction: "Let an NPC other than {{char}} and {{user}} intervene from their own motive and meaningfully change the characters' immediate options or pressures." },
    { id: "opportunity", label: "목표·선택", promptLabel: "Goals and Choices", emoji: "🎯", direction: "Create a concrete objective, proposal, dilemma, or choice that gives {{char}} something meaningful to pursue or decide." },
    { id: "obstacle", label: "갈등·장애", promptLabel: "Conflicts and Obstacles", emoji: "⚔️", direction: "Introduce credible resistance, incompatible desires, or a practical obstacle rooted in the current context." },
    { id: "relationship", label: "관계 변화", promptLabel: "Relationship Shift", emoji: "🤝", direction: "Create a concrete shift in trust, distance, obligation, status, intimacy, or power between existing characters." },
    { id: "emotion", label: "감정 표출", promptLabel: "Emotion in Action", emoji: "💓", direction: "Let an emotion that is justified by the immediate context become visible through behavior, dialogue, restraint, avoidance, vulnerability, humor, or a decision that fits {{char}}'s established personality and tendencies. Ground both the emotion and its expression in the transcript. Jealousy, possessiveness, obsession, overprotectiveness, territorial behavior, or controlling behavior is not a default form of emotional intensity. Use any of them only when the recent transcript clearly establishes that {{char}} has that tendency and the immediate situation specifically activates it; affection, concern, attraction, fear of loss, or emotional intensity alone is not sufficient evidence." },
    { id: "environment", label: "상황 변화", promptLabel: "Situation Shift", emoji: "🌦️", direction: "Change an immediate condition such as place, weather, time, crowd, access, or social circumstances so it meaningfully alters the current scene's options." },
    { id: "consequence", label: "결과·후폭풍", promptLabel: "Consequences and Aftermath", emoji: "🌊", direction: "Return a consequence of an earlier choice, promise, conflict, omission, or action to the present scene." },
    { id: "everyday", label: "일상·계기", promptLabel: "Everyday Occasion", emoji: "☕", direction: "Build the next development from an ordinary activity, practical need, shared routine, minor inconvenience, casual plan, domestic detail, or familiar social moment. Let its interest come from character-specific interaction and a small shift in comfort, habit, understanding, or relationship texture rather than from an exceptional incident or dramatic escalation." },
    { id: "world", label: "세계·세력", promptLabel: "World and Factions", emoji: "🏛️", direction: "Let an organization, institution, faction, custom, law, or wider world condition actively affect the current situation." },
    { id: "wildcard", label: "돌발 변수", promptLabel: "Unexpected Variable", emoji: "⚡", direction: "Introduce an unexpected but causally grounded variable that changes the immediate options without becoming a random unrelated disaster." },
];

// @source-order 100
const EVENT_CATEGORY_DESCRIPTIONS = Object.freeze({
    discovery: "활용할 수 있는 새로운 사실이나 정보가 드러납니다.",
    clue: "답보다 새로운 의문을 남기는 비밀·흔적·단서가 생깁니다.",
    npc: "제3자가 자기 목적을 가지고 현재 상황에 개입합니다.",
    opportunity: "캐릭터가 추구하거나 결정할 목표와 선택이 생깁니다.",
    obstacle: "현재 맥락에서 저항·욕망의 충돌·현실적인 장애가 생깁니다.",
    relationship: "신뢰·거리·의무·지위·친밀감·권력관계가 변합니다.",
    emotion: "현재 맥락과 캐릭터 성향에 맞는 감정이 그 캐릭터다운 방식으로 드러납니다.",
    environment: "장소·시간·접근 조건 등 현재 장면의 상황이 변합니다.",
    consequence: "이전 선택·약속·갈등·행동의 결과가 현재로 돌아옵니다.",
    everyday: "생활 속 행동·필요·습관에서 상호작용과 작은 관계 변화의 계기가 생깁니다.",
    world: "조직·제도·세력·관습·법이나 세계의 조건이 움직입니다.",
    wildcard: "뜬금없는 사고가 아닌, 현재 맥락에서 예상 밖의 변수가 생깁니다.",
});

// @source-order 101
const EVENT_CATEGORY_GUIDANCE = Object.freeze({
    discovery: {
        required: "INFORMATION AND DISCOVERY: Center a concrete, usable fact that becomes known or accessible and changes what the characters can understand, plan, or do next.",
        avoid: "Do not substitute an unresolved mystery clue, a third-party interruption, or a dramatic incident for the information itself. Unlike Secrets and Clues, the usable fact itself becomes available now; the new knowledge and its practical use must remain central.",
        completion: "A complete candidate states what information becomes available, how it follows from the current context, and what new action or understanding it enables.",
        novelty: "source of information, fact revealed, way it becomes available, practical use, or resulting option",
    },
    clue: {
        required: "SECRET AND CLUE: Center a trace, contradiction, concealed fact, suspicious absence, or partial evidence that creates or deepens a specific unresolved question.",
        avoid: "Do not explain the entire truth, solve the mystery immediately, or replace the clue with an unrelated danger, confession, or generic revelation. Unlike Information and Discovery, the result must preserve a meaningful unknown rather than deliver a fully usable answer.",
        completion: "A complete candidate states the concrete clue, why it matters in the current context, and what question or line of inquiry remains open.",
        novelty: "clue type, hidden question, source, implicated detail, interpretation, or next line of inquiry",
    },
    npc: {
        required: "THIRD-PARTY INTERVENTION: Center an established or contextually plausible NPC acting from a motive of their own and changing the immediate options, obligations, access, or pressure around {{char}} and {{user}}.",
        avoid: "Do not use the NPC as a disposable messenger, random stranger, exposition device, or excuse for a disconnected crisis. Their individual motive and action—not a general institution or world rule—must drive the intervention.",
        completion: "A complete candidate identifies who intervenes, what they independently want or do, and how that changes the current situation without deciding {{user}}'s response.",
        novelty: "NPC, motive, intervention method, demand, leverage, relationship, or option changed",
    },
    opportunity: {
        required: "GOAL AND CHOICE: Center a concrete objective, proposal, opening, dilemma, or meaningful option that {{char}} can pursue, reject, negotiate, or prioritize.",
        avoid: "Do not substitute a crisis, obstacle, revelation, or forced decision for a genuine choice. Unlike Conflicts and Obstacles, the available objective or branching decision—not the resistance to it—must remain central. Do not decide {{user}}'s action, answer, consent, or commitment.",
        completion: "A complete candidate states the available goal or choice, why it matters now, and what distinct paths or stakes remain open.",
        novelty: "objective, offer, dilemma, available path, stake, resource, or decision owner",
    },
    obstacle: {
        required: "CONFLICT AND OBSTACLE: Center credible resistance, incompatible aims, a practical barrier, or a constraint that directly obstructs something already being attempted or desired.",
        avoid: "Do not rely on a random accident, arbitrary misunderstanding, unrelated enemy, or instant catastrophe. Unlike Goals and Choices, an existing aim must meet active resistance or constraint. Do not solve the obstacle in the same candidate.",
        completion: "A complete candidate identifies the active aim, the grounded source of resistance, and the unresolved action or compromise the obstacle now requires.",
        novelty: "blocked aim, source of resistance, practical constraint, competing desire, cost, or possible response",
    },
    relationship: {
        required: "RELATIONSHIP SHIFT: Center a concrete change in trust, distance, obligation, status, intimacy, boundaries, dependence, or power between characters who already have an established relationship.",
        avoid: "Do not add an external incident merely to make the relationship move. Unlike Emotion in Action, the relationship axis itself must change rather than merely reveal one character's feeling. Do not use jealousy, possessiveness, obsession, overprotection, or control as generic shorthand for intimacy or intensity.",
        completion: "A complete candidate states what interaction or realization alters the relationship axis and what new tension, closeness, boundary, or uncertainty remains.",
        novelty: "relationship axis, initiating interaction, boundary, obligation, trust signal, power balance, or unresolved relational effect",
    },
    emotion: {
        required: "CHARACTER-GROUNDED EMOTION: Center an emotion already supported or immediately activated by the current context, and let {{char}} reveal, suppress, redirect, disguise, or act on it in a way specific to their established personality, motives, boundaries, speech, and relationship history.",
        avoid: "Do not create a new accident, threat, secret, third party, confession, or major relationship event merely to trigger emotion. Unlike Relationship Shift, an emotion may become visible without changing the relationship's status or direction. Do not default to jealousy, possessiveness, obsession, overprotectiveness, territorial behavior, surveillance, control, or restriction of autonomy unless both the established character tendency and immediate trigger are explicit in the transcript.",
        completion: "A complete candidate identifies the existing emotional trigger, {{char}}'s characteristic mode of expression through behavior, tone, restraint, avoidance, humor, vulnerability, or decision, and the small relational opening or tension left afterward.",
        novelty: "emotion, immediate trigger, mode of expression, degree of restraint, relational subtext, or small interpersonal effect",
    },
    environment: {
        required: "SITUATION SHIFT: Center a change in an immediate condition—place, time, weather, crowd, privacy, access, schedule, visibility, or social setting—that materially changes what can happen in the current scene.",
        avoid: "Do not treat the condition as decorative background, turn it into a random catastrophe, or let an unrelated character or revelation become the real center of the development. Unlike Unexpected Variable, the changed situational condition itself—not surprise or reversal—must remain central.",
        completion: "A complete candidate states the changed condition, its concrete effect on the characters' immediate options, and what remains possible or difficult next.",
        novelty: "condition changed, location, timing, access, privacy, crowd, sensory limitation, or option affected",
    },
    consequence: {
        required: "CONSEQUENCE AND AFTERMATH: Center a concrete effect of an earlier choice, action, promise, conflict, omission, or unresolved event returning to shape the present.",
        avoid: "Do not invent unrelated punishment, coincidence, disaster, moral retribution, or a brand-new conflict and call it a consequence. The prior cause must already exist in the transcript, and the causal link must be visible and specific.",
        completion: "A complete candidate identifies the prior cause, the consequence arriving now, and the unresolved cost, responsibility, adjustment, or next response it creates.",
        novelty: "prior cause, delayed effect, affected person or resource, responsibility, cost, or response now required",
    },
    everyday: {
        required: "EVERYDAY DIRECTION: Center an ordinary activity, practical need, shared routine, minor inconvenience, casual plan, domestic detail, familiar place, or recurring social moment. Let interest come from how these specific characters handle ordinary life together.",
        avoid: "Do not introduce danger, a major revelation, exceptional coincidence, dramatic confrontation, new antagonist, or sudden escalation. Do not turn the ordinary occasion into a disguised Relationship Shift or Conflict; a small change in comfort, habit, understanding, cooperation, or relationship texture is sufficient.",
        completion: "A complete candidate states the ordinary occasion, the character-specific interaction or practical adjustment it opens, and what remains available to do next.",
        novelty: "everyday activity, practical need, setting, routine, minor inconvenience, interaction pattern, or small relational effect",
    },
    world: {
        required: "WORLD AND FACTIONS: Center an established or contextually inferable organization, institution, faction, law, custom, economy, technology, or wider world condition actively constraining or enabling the current situation.",
        avoid: "Do not produce a lore dump, invent a grand new faction solely for spectacle, or let generic worldbuilding replace a concrete effect on the characters' present options. Unlike Third-Party Intervention, the system, rule, institution, or collective pressure—not one individual's independent action—must be central.",
        completion: "A complete candidate identifies the relevant world force, how it reaches the current scene, and what practical option, duty, risk, or limitation it creates.",
        novelty: "world force, rule, institution, faction interest, custom, resource system, or practical effect",
    },
    wildcard: {
        required: "UNEXPECTED VARIABLE: Center a surprising but causally plausible variable that reconfigures the immediate options without breaking established characterization, world rules, or scene continuity.",
        avoid: "Do not use a random disaster, arbitrary betrayal, unrelated stranger, implausible coincidence, or shock twist with no support in the transcript. Unlike Situation Shift, the overlooked cause or reversal—not merely a changed condition—must create the surprise.",
        completion: "A complete candidate states the unexpected variable, the existing basis that makes it plausible, and how it changes the next available actions without resolving everything.",
        novelty: "overlooked cause, variable introduced, expectation reversed, option changed, participant affected, or immediate consequence",
    },
});

// @source-order 152
const GENRE_AUDIT_CODES = Object.freeze([
    "primary_genre",
    "genre_expression",
    "character_consistency",
    "char_agency",
    "relationship",
    "support_texture",
    "scene_density",
    "continuity",
    "character_interpretation",
    "repetition",
]);

// @source-order 153
const AUDIT_REASON_MAX_CHARS_KO = 80;

// @source-order 154
const AUDIT_REASON_MAX_CHARS_EN = 140;

// @source-order 155
const AUDIT_REASON_MAX_SENTENCES = 1;

// @source-order 156
const AUDIT_REASON_SCHEMA_MAX_CHARS_KO = 240;

// @source-order 157
const AUDIT_REASON_SCHEMA_MAX_CHARS_EN = 320;

// @source-order 158
const AUDIT_REASON_DISPLAY_HARD_LIMIT = 600;

// @source-order 159
// Shared output allowance for diagnosis reasons and correction writing.
const AUDIT_WRITING_OUTPUT_TOKENS = 4800;
const AUDIT_RESPONSE_LENGTHS = Object.freeze({
    genre: AUDIT_WRITING_OUTPUT_TOKENS,
    character: AUDIT_WRITING_OUTPUT_TOKENS,
    combined: AUDIT_WRITING_OUTPUT_TOKENS,
});

// @source-order 160
const GENRE_BOOST_CORRECTION_CODES = new Set([
    "primary_genre",
    "support_texture",
    "genre_expression",
    "scene_density",
]);

// @source-order 161
const CHARACTER_BOOST_CORRECTION_CODES = new Set([
    "character_consistency",
    "character_interpretation",
    "char_agency",
    "relationship",
    "continuity",
    "repetition",
]);

// @source-order 162
const THINKING_OUTPUT_ERROR =
    "선택한 thinking 모델이 결과를 일반 응답이 아닌 추론 영역에만 반환했습니다. SillyTavern을 업데이트하거나 추론 강도를 최소/끔으로 바꾼 뒤 다시 시도해 주세요.";

// @source-order 163
const EMPTY_STRUCTURED_OUTPUT_ERROR =
    "모델 또는 연결에서 빈 구조화 응답을 반환했습니다.";

// @source-order 192
const GENRE_CORRECTION_LABELS = Object.freeze({
    primary_genre: "주 장르 정체성",
    genre_expression: "장르 표현",
    character_consistency: "캐릭터성",
    char_agency: "캐릭터 능동성",
    relationship: "캐릭터·유저 관계성",
    support_texture: "보조 장르 렌즈",
    scene_density: "장면 밀도",
    continuity: "현재 장면 연속성",
    character_interpretation: "캐릭터 해석",
    repetition: "표현 반복 방지",
});

// @source-order 193
const GENRE_CORRECTION_MODULES = Object.freeze({
    primary_genre:
        "Restore the primary genre as the response's governing narrative logic. Use a recognizable mechanism from its stated direction and expression, and let it change {{char}}'s choice, relationship behavior, or the scene's consequence while respecting the genre boundary. Continue the existing situation; do not add unrelated lore, a forced trope, or an arbitrary event merely to display the genre.",
    genre_expression:
        "Make the primary genre recognizable in how this response is staged: descriptive focus, dialogue and action beats, pacing, event development, and consequences. Use its stated expression techniques rather than labels, decorative keywords, generic mood, or a neighboring genre's shorthand, while continuing the current scene organically.",
    character_consistency:
        "Restore {{char}}'s established personality, values, boundaries, voice, capabilities, and decision logic. Correct the diagnosed contradiction through one plausible choice, line, or reaction in the current scene; do not explain the correction, recite the baseline, or force every trait to appear.",
    char_agency:
        "Give {{char}} meaningful, character-specific agency in this response. Based on an established motive and decision style, let {{char}} make at least one relevant choice by initiating, refusing, withholding, redirecting, negotiating, proposing, or acting instead of only mirroring, waiting for {{user}}, or handing a choice that belongs to {{char}} back to {{user}}.",
    relationship:
        "Make the specific established relationship clearly matter in this response. Let {{char}} react through shared history, subtext, boundaries, trust, tension, power, unresolved feelings, or changing distance. Use one context-relevant relational beat rather than generic affection, hostility, jealousy, possession, protection, or forced progression.",
    support_texture:
        "Restore the supporting genre as a secondary lens without taking over the scene. Through an existing opening, use its stated texture, pressure, relationship context, or social or world logic in a way that is identifiable beyond generic mood and respects its boundary. Keep the primary genre central; do not introduce unrelated lore or manufacture an event merely to display the supporting genre.",
    scene_density:
        "Restore scene density through purposeful action, dialogue, spatial awareness, sensory or material detail, behavioral cues, subtext, and immediate consequences. Let concrete details affect choice, attention, pressure, or emotional meaning instead of becoming detached decoration or summary.",
    continuity:
        "First advance the unresolved action, conversation, emotional beat, or immediate causal consequence already present. Preserve location, timing, knowledge, physical state, and spatial logic before adding any new development; avoid an unexplained reset, interruption, time skip, or unrelated turn.",
    repetition:
        "Replace the diagnosed mechanical repetition with a visibly different gesture, sensory focus, sentence pattern, emotional display, relational beat, or ending structure. Preserve genuine signature voice and behavior, characterization, continuity, and genre identity.",
    character_interpretation:
        "Restore only the context-relevant established facets of {{char}} that were flattened by the recent one-sided or generic interpretation. Keep the specific tension between traits, motives, boundaries, and relationship behavior without inventing a virtue, flaw, trauma, contradiction, or hidden side.",
});

// @source-order 194
const GENRE_CORRECTION_DESCRIPTIONS = Object.freeze({
    primary_genre:
        "캐릭터의 동기·관계·장면 의미에서 주 장르가 다시 중심이 되도록 강화",
    genre_expression:
        "묘사·행동·대화·사건 진행과 결과가 선택한 장르답게 드러나도록 보강",
    character_consistency:
        "기준 요약과 어긋난 성격·대사·행동을 캐릭터답게 되돌리도록 보정",
    support_texture:
        "현재 장면을 유지하며 보조 장르의 압력·분위기·묘사 질감을 보강",
    char_agency:
        "캐릭터가 자신의 목적에 따라 먼저 말하거나 행동하고 선택하도록 강화",
    relationship:
        "캐릭터와 유저 사이의 신뢰·긴장·경계·감정 변화를 행동과 대화에 반영",
    scene_density:
        "장르 고유의 배경·감각·공간·행동 디테일로 평면적인 장면을 보강",
    continuity:
        "진행 중인 행동·대화·감정과 즉각적인 결과를 먼저 이어가도록 보정",
    repetition:
        "최근 반복된 몸짓·이미지·문장 패턴·관계 흐름을 다른 표현으로 전환",
    character_interpretation:
        "한쪽 성향이나 흔한 전형으로 치우친 캐릭터 해석을 기존 결에 맞게 복원",
});

// @source-order 339
const GENRE_AUDIT_DISPLAY_ITEMS = Object.freeze([
    { code: "primary_genre", label: "주 장르", title: "주 장르 정체성" },
    { code: "support_texture", label: "보조 렌즈", title: "보조 장르 렌즈" },
    { code: "genre_expression", label: "장르 표현", title: "묘사·행동·사건 진행의 장르 표현" },
    { code: "scene_density", label: "장면 밀도", title: "장면의 구체성과 체감 밀도" },
]);

// @source-order 340
const CHARACTER_AUDIT_DISPLAY_ITEMS = Object.freeze([
    { code: "character_consistency", label: "캐릭터성", title: "캐릭터 설정 일관성" },
    { code: "character_interpretation", label: "캐릭터 해석", title: "한쪽 성향·전형 편향" },
    { code: "char_agency", label: "능동성", title: "캐릭터 능동성" },
    { code: "relationship", label: "관계 반응", title: "캐릭터-유저 관계 반응" },
    { code: "continuity", label: "연속성", title: "현재 장면 연속성" },
    { code: "repetition", label: "표현 반복", title: "표현 반복 방지" },
]);

// @source-order 361
const GENRE_RECOMMENDATION_NO_SUPPORT_ID = "none";

export { AUDIT_EVIDENCE_MAX_ITEMS, AUDIT_MESSAGE_MAX_CHARS, AUDIT_REASON_DISPLAY_HARD_LIMIT, AUDIT_REASON_MAX_CHARS_EN, AUDIT_REASON_MAX_CHARS_KO, AUDIT_REASON_MAX_SENTENCES, AUDIT_REASON_SCHEMA_MAX_CHARS_EN, AUDIT_REASON_SCHEMA_MAX_CHARS_KO, AUDIT_RESPONSE_LENGTHS, AUDIT_WRITING_OUTPUT_TOKENS, BACKGROUND_REQUEST_TIMEOUT_MS, CHARACTER_AGENCY_EVIDENCE_MINIMUM, CHARACTER_AUDIT_DISPLAY_ITEMS, CHARACTER_BASELINE_AUTOSAVE_DELAY, CHARACTER_BASELINE_CORRECTION_CODES, CHARACTER_BASELINE_FIELDS, CHARACTER_BASELINE_FIELD_IDS, CHARACTER_BASELINE_FIELD_ID_SET, CHARACTER_BASELINE_FIELD_MAX_CHARS, CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS, CHARACTER_BOOST_ANCHOR_MAX_CHARS, CHARACTER_BOOST_CORRECTION_CODES, CHARACTER_CARD_INPUT_MAX_CHARS, CHARACTER_CONSISTENCY_POSITIVE_EVIDENCE_MINIMUM, CHARACTER_CONTINUITY_EVIDENCE_MINIMUM, CHARACTER_CORRECTION_FIELD_FALLBACKS, CHARACTER_CORRECTION_MAX_CHARS, CHARACTER_CORRECTION_MAX_WORDS, CHARACTER_FAILURE_EVIDENCE_MINIMUM, CHARACTER_INTERPRETATION_FAILURE_EVIDENCE_MINIMUM, CHARACTER_INTERPRETATION_POSITIVE_EVIDENCE_MINIMUM, CHARACTER_RELATIONSHIP_EVIDENCE_MINIMUM, CHARACTER_REVISION_ASSISTANT_REPLIES, CHARACTER_REVISION_NOTE_MAX_CHARS, CHARACTER_REVISION_TRANSCRIPT_MAX_CHARS, CONTINUITY_FAILURE_EVIDENCE_MINIMUM, DEFAULT_AUDIT_INTERVAL, DEFAULT_GENRES, DEFAULT_PLOT_MAX_TOKENS, EMPTY_STRUCTURED_OUTPUT_ERROR, ERROR_LOG_STORAGE_KEY, EVENT_CATEGORIES, EVENT_CATEGORY_DESCRIPTIONS, EVENT_CATEGORY_GUIDANCE, GENRE_AUDIT_CODES, GENRE_AUDIT_DISPLAY_ITEMS, GENRE_AUDIT_RESPONSE_LIMIT, GENRE_BOOST_CORRECTION_CODES, GENRE_CORRECTION_DESCRIPTIONS, GENRE_CORRECTION_LABELS, GENRE_CORRECTION_MODULES, GENRE_EXPRESSION_EVIDENCE_MINIMUM, GENRE_FAILURE_EVIDENCE_MINIMUM, GENRE_GROUPS, GENRE_PROFILES, GENRE_PROMPT_KEY, GENRE_RECOMMENDATION_MESSAGE_LIMIT, GENRE_RECOMMENDATION_MESSAGE_MAX_CHARS, GENRE_RECOMMENDATION_NO_SUPPORT_ID, MAX_AUDIT_INTERVAL, MAX_CHARACTER_BASELINE_VERSIONS, MAX_ERROR_LOG_ENTRIES, MAX_PLOT_GENERATION_ATTEMPTS, MAX_PLOT_HISTORY, MAX_PLOT_MAX_TOKENS, MIN_AUDIT_INTERVAL, MIN_PLOT_MAX_TOKENS, MODULE_NAME, PLOT_CONTEXT_MESSAGE_LIMIT, PLOT_MESSAGE_MAX_CHARS, PLOT_PROMPT_KEY, PRIMARY_GENRE_EVIDENCE_RATIO, RELATIONSHIP_FAILURE_EVIDENCE_MINIMUM, REPETITION_EXACT_EVIDENCE_MINIMUM, REPETITION_GENERAL_EVIDENCE_MINIMUM, SCENE_DENSITY_EVIDENCE_MINIMUM, STORYBOOSTER_VERSION, SUPPORT_GENRE_EVIDENCE_MINIMUM, THINKING_OUTPUT_ERROR };
