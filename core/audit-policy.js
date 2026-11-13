// Both engines choose at most two one-shot repairs using the same ordering.
import { GENRE_FAILURE_EVIDENCE_MINIMUM, CHARACTER_FAILURE_EVIDENCE_MINIMUM, CHARACTER_INTERPRETATION_FAILURE_EVIDENCE_MINIMUM, RELATIONSHIP_FAILURE_EVIDENCE_MINIMUM, CONTINUITY_FAILURE_EVIDENCE_MINIMUM } from './constants.js';
import { feedbackValidationError } from './response-validation.js';
import { normalizeCharacterCorrectionText } from './text.js';

// Controlled facet IDs, shared importance and evidence gates; never accept a
// model-provided numeric priority. Keep these IDs aligned with Jev questions.
export const AUDIT_PROBLEM_IMPACT = Object.freeze({
    character_consistency: { motives: 4, values: 4, boundaries: 4, emotion: 3, voice: 2, vocabulary: 1 },
    continuity: { actions: 4, knowledge: 4, consequences: 4, space: 3, time: 3, emotion: 3 },
    char_agency: { user_agency: 4, judgment: 4, purpose: 4, execution: 3, initiative: 3, delegation: 3 },
    relationship: { boundaries: 4, history: 3, trust: 3, distance: 3, pace: 3, scope: 3 },
    primary_genre: { core: 3, motives: 3, choices: 3, conflict: 3, relationship: 3, consequences: 3 },
    character_interpretation: { individuality: 3, development: 3, softening: 3, balance: 2, situation: 2, nuance: 2 },
    genre_expression: { narration: 2, dialogue: 2, behavior: 2, pacing: 2, atmosphere: 2, effects: 2 },
    support_texture: { identity: 2, setting: 2, pressure: 2, texture: 2, integration: 2, restraint: 2 },
    scene_density: { space: 2, perception: 2, material: 2, body: 2, action: 2, causality: 2 },
    repetition: { wording: 1, structure: 1, gesture: 1, emotion: 1, relationship: 1, ending: 1 },
});
export const AUDIT_FACET_VERDICTS = Object.freeze(['yes', 'no', 'justified', 'temporary', 'no_opportunity', 'uncertain']);
export const AUDIT_CORRECTION_MIN_CHARS = 80;
export const AUDIT_CORRECTION_MAX_CHARS = 1800;
// Under-realization is not a contradiction. Repeated concrete missed opportunities
// can justify one light repair without manufacturing drift or penalizing quietness.
export const AUDIT_UNDERUSE_CODES = Object.freeze(['primary_genre', 'genre_expression', 'support_texture',
    'scene_density', 'character_interpretation', 'char_agency', 'relationship']);
export function auditUnderusePrompt(jsonContract = true) {
    return 'MISSED-OPPORTUNITY POLICY: Separately inspect whether an applicable, already established genre mechanism or character-specific tendency had a concrete natural opening but was replaced by a generic interchangeable reaction. Require at least TWO distinct numbered replies showing the same under-realized applicable facet before a final attention verdict. Repeated supported under-realization is attention, not drifted/biased/weak by itself. When the only issue is missed distinctive realization replaced by generic reactions, use this underuse route when a dimension refers to generic, ignored or flattened realization. Direct failure requires an observable incompatible choice, imposed trope, contradiction or broken obligation beyond missing distinctive realization. Keep those direct contradictions, concrete lapses and mechanical repetition in their existing failure arrays; do not mix underuse evidence into those arrays or inflate severity. A trait with no opportunity, an unspecified baseline, quiet daily life, intentional restraint, supported growth, a single ambiguous reply or repeated deferred labels is not underuse. Do not require all facets, genre conflict, criminal acts, relationship escalation, ornate prose or constant initiative. For character consistency, continuity and repetition use their existing rules; gradual loss of individuality belongs to character_interpretation. ' + (jsonContract ? ' Report underuse_evidence as {dimension:[{reply:integer,facet:allowed_facet_id}]}, at most four links per dimension. Each link associates one reply with exactly one actually missed facet; do not invent links to meet a threshold. Repeated underuse requires TWO DISTINCT replies linked to the SAME facet. Different facets cannot be added together. Identify the supported facet in problem_facets; return [] without observations.' : ' For per-reply choices use underused_FACET only when offered for that exact facet; otherwise choose uncertain for unsupported underuse, never direct failure.');
}
export function normalizeUnderuseEvidence(value, requestedCodes, count = 10) {
    if (value === undefined) return {};
    const fail = code => { throw feedbackValidationError(code, 'underuse_evidence'); };
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('field_type');
    const allowed = requestedCodes.filter(code => AUDIT_UNDERUSE_CODES.includes(code));
    const output = {};
    for (const [code, rows] of Object.entries(value)) {
        if (!allowed.includes(code)) fail('unexpected_field');
        if (!Array.isArray(rows)) fail('field_type');
        if (rows.length > 4) fail('field_too_long');
        const links = rows.map(row => {
            // dev.3 compatibility: numeric observations can be interpreted only
            // when their sole explicit problem facet identifies the same group.
            if (Number.isSafeInteger(row) && row >= 1 && row <= count) return { reply: row, facet: '' };
            if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 2 ||
                !Number.isSafeInteger(row.reply) || row.reply < 1 || row.reply > count ||
                typeof row.facet !== 'string' || !Object.hasOwn(AUDIT_PROBLEM_IMPACT[code], row.facet)) fail('field_value');
            return { reply: row.reply, facet: row.facet };
        });
        output[code] = [...new Map(links.map(row => [`${row.reply}:${row.facet}`, row])).values()]
            .sort((a,b) => a.reply-b.reply || a.facet.localeCompare(b.facet));
    }
    return output;
}
// Both engines reduce the same facet-linked observations, never dimension totals.
export function summarizeAuditUnderuse(code, rows = [], problemFacets = [], verdicts = null) {
    const eligible = [...new Set(problemFacets)].filter(id => Object.hasOwn(AUDIT_PROBLEM_IMPACT[code] || {}, id) &&
        (code !== 'character_interpretation' || verdicts?.[id] === 'no'));
    const explicit = [...new Set(problemFacets)];
    const links = rows.map(row => ({ reply: row.reply, facet: row.facet || (explicit.length === 1 ? explicit[0] : '') }))
        .filter(row => eligible.includes(row.facet));
    const groups = eligible.map(facet => ({ facet, replies: [...new Set(links.filter(row => row.facet === facet).map(row => row.reply))] }));
    const confirmed = groups.filter(row => row.replies.length >= 2);
    return { facets: confirmed.map(row => row.facet),
        replies: [...new Set(confirmed.flatMap(row => row.replies))].sort((a,b) => a-b) };
}
export function normalizeStoredUnderuseReplyIds(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(AUDIT_UNDERUSE_CODES.filter(code => Array.isArray(value[code])).map(code => [code,
        [...new Set(value[code].filter(n => Number.isSafeInteger(n) && n >= 1 && n <= 10))].slice(0, 4)]));
}
export function normalizeStoredUnderuseEvidence(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const code of AUDIT_UNDERUSE_CODES) {
        if (!Array.isArray(value[code])) continue;
        const rows = value[code].slice(0, 4).flatMap(row => {
            try { return normalizeUnderuseEvidence({ [code]: [row] }, [code])[code].filter(link => link.facet); }
            catch { return []; }
        });
        out[code] = [...new Map(rows.map(row => [`${row.reply}:${row.facet}`, row])).values()];
    }
    return out;
}
// A provider label cannot erase or exaggerate validated direct failures. These
// thresholds never shrink because fewer replies were available to review.
export function resolveAuditFailureRating(code, replies, severe = false) {
    const count = new Set(replies).size;
    if (!count) return null;
    if (code === 'character_consistency') return severe || count >= CHARACTER_FAILURE_EVIDENCE_MINIMUM ? 'drifted' : 'attention';
    if (code === 'character_interpretation') return count >= CHARACTER_INTERPRETATION_FAILURE_EVIDENCE_MINIMUM ? 'biased' : 'attention';
    if (code === 'continuity') return severe || count >= CONTINUITY_FAILURE_EVIDENCE_MINIMUM ? 'weak' : 'attention';
    const minimum = ['primary_genre', 'genre_expression', 'scene_density'].includes(code) ? GENRE_FAILURE_EVIDENCE_MINIMUM
        : code === 'relationship' ? RELATIONSHIP_FAILURE_EVIDENCE_MINIMUM : CHARACTER_FAILURE_EVIDENCE_MINIMUM;
    return count >= minimum ? 'weak' : 'attention';
}

export function getAuditProblemImpact(code, facets = []) {
    const known = facets.map(facet => AUDIT_PROBLEM_IMPACT[code]?.[typeof facet === 'string' ? facet : facet.id])
        .filter(Number.isFinite);
    // Compatible older results without a problem type have neutral importance,
    // not the old blanket maximum for every character consistency problem.
    return known.length ? Math.max(...known) : code === 'repetition' ? 1 : 2;
}
export function hasSufficientCharacterFacets(observations = []) {
    const applicable = observations.filter(facet => facet.verdict !== 'no_opportunity');
    const positives = applicable.filter(facet => ['yes', 'justified', 'temporary'].includes(facet.verdict));
    return applicable.length > 0 && positives.length >= Math.min(2, applicable.length);
}

// Both members must already have concrete negative evidence. A numbered pair
// establishes a comparator, not a new failed reply. Disconnected pairs cannot
// be added together to manufacture a sustained three-reply pattern.
export function reduceRepetitionEvidence(failedReplies, matches = [], reviewedResponses = 10) {
    const failures = new Set(failedReplies.filter(n => Number.isSafeInteger(n) && n >= 1 && n <= reviewedResponses));
    const edges = matches.filter(pair => Number.isSafeInteger(pair.left) && Number.isSafeInteger(pair.right)
        && pair.left !== pair.right && failures.has(pair.left) && failures.has(pair.right)
        && ['pattern', 'near_verbatim'].includes(pair.kind) && Object.hasOwn(AUDIT_PROBLEM_IMPACT.repetition, pair.facet));
    const connected = new Map();
    for (const pair of edges) {
        for (const [a, b] of [[pair.left, pair.right], [pair.right, pair.left]]) {
            const key = `${pair.facet}:${a}`, other = `${pair.facet}:${b}`;
            if (!connected.has(key)) connected.set(key, new Set());
            connected.get(key).add(other);
        }
    }
    const visited = new Set(); let sustained = false;
    for (const start of connected.keys()) {
        if (visited.has(start)) continue;
        const stack = [start]; let size = 0;
        while (stack.length) {
            const n = stack.pop(); if (visited.has(n)) continue;
            visited.add(n); size++;
            stack.push(...connected.get(n));
        }
        if (size >= 3) sustained = true;
    }
    const exact = edges.some(pair => pair.kind === 'near_verbatim');
    return { confirmed: edges.length > 0, rating: sustained || exact ? 'weak' : 'attention',
        evidence: [...new Set([...connected.keys()].map(key => Number(key.split(':')[1])))].sort((a, b) => a - b), exact };
}

export function auditCorrectionWritingPrompt() {
    return 'For each selected target write a separate concrete English imperative: 80-110 words for a character target, 50-80 words for a genre target; minimum 80 and maximum 1800 characters. Name the supported defect and a specific local action for the NEXT reply that makes the repair visible through choice, dialogue, behavior, pacing, scene detail or immediate consequences. Preserve healthy behavior, supported growth, relationship scope, temporary exceptions and user agency. For attention make one small local repair only. For supported underuse, use the existing opening to let ONE under-realized motive, decision style, voice, relationship-specific response or genre mechanism visibly shape the next choice or reaction. State what to do in this scene, not merely preserve the baseline or strengthen the genre. Do not require every trait, manufacture an event, reset the scene, uniformly soften the character, or decide user actions, dialogue, feelings or consent. Do not use a generic preservation slogan as the entire repair. next_corrections must be one concrete sentence in the requested output language, 10-140 characters, describing that same repair; do not impose English word counts on Korean summaries. Repetition/continuity-only repairs need no character focus fields.';
}

export function validateAuditCorrection(text, summary, code) {
    const invalid = (kind, group) => { throw feedbackValidationError(kind, `${group}.${code}`); };
    if (text === undefined) invalid('field_missing', 'corrections');
    if (typeof text !== 'string') invalid('field_type', 'corrections');
    const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
    if (clean.length > AUDIT_CORRECTION_MAX_CHARS) invalid('field_too_long', 'corrections');
    const normalized = normalizeCharacterCorrectionText(clean);
    if (normalized.length < AUDIT_CORRECTION_MIN_CHARS) invalid('field_too_short', 'corrections');
    if (summary === undefined) invalid('field_missing', 'next_corrections');
    if (typeof summary !== 'string') invalid('field_type', 'next_corrections');
    if (summary.trim().length < 10) invalid('field_too_short', 'next_corrections');
    if (summary.trim().length > 140) invalid('field_too_long', 'next_corrections');
    return { correction: normalized, summary: summary.trim() };
}

export function formatAuditCorrectionInstruction(text, rating) {
    const localRepair = 'Make one small local repair only; preserve healthy behavior and current scene direction. ';
    return normalizeCharacterCorrectionText(rating === 'attention' ? localRepair + text : text);
}

export const AUDIT_CORRECTION_ORDER = Object.freeze(['character_consistency', 'continuity', 'char_agency', 'relationship', 'primary_genre', 'character_interpretation', 'genre_expression', 'support_texture', 'scene_density', 'repetition']);
export function rankAuditCorrections(problems) {
    return [...problems].sort((a, b) => Number(b.severe) - Number(a.severe)
        || Number(b.rating !== 'attention') - Number(a.rating !== 'attention')
        || b.impact - a.impact || b.failedReplies - a.failedReplies
        || b.confidence - a.confidence || AUDIT_CORRECTION_ORDER.indexOf(a.code) - AUDIT_CORRECTION_ORDER.indexOf(b.code))
        .slice(0, 2).map(p => p.code);
}
