// Both engines choose at most two one-shot repairs using the same ordering.
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
    return 'For each selected target write a separate concrete English imperative: 80-110 words for a character target, 50-80 words for a genre target; minimum 80 and maximum 1800 characters. Name the supported defect and a specific local action for the NEXT reply that makes the repair visible through choice, dialogue, behavior, pacing, scene detail or immediate consequences. Preserve healthy behavior, supported growth, relationship scope, temporary exceptions and user agency. For attention make one small local repair only. Do not require every trait, manufacture an event, reset the scene, uniformly soften the character, or decide user actions, dialogue, feelings or consent. Do not use a generic preservation slogan as the entire repair. next_corrections must be one concrete sentence in the requested output language, 10-140 characters, describing that same repair; do not impose English word counts on Korean summaries. Repetition/continuity-only repairs need no character focus fields.';
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
