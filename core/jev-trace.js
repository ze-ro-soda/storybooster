import { GENRE_AUDIT_CODES, GENRE_AUDIT_RESPONSE_LIMIT } from './constants.js';

const choices = new Set(['present', 'stable', 'weak', 'drifted', 'biased', 'attention', 'na', 'dormant', 'context_missing', 'conflict']);
const routes = new Set(['confirmed_problem', 'clear_positive_evidence', 'no_opportunity',
    'essential_context_missing', 'conflicting_observations', 'insufficient_positive_evidence', 'no_applicable_observations']);
const verdicts = new Set(['yes', 'no', 'justified', 'temporary', 'no_opportunity', 'uncertain']);
const unit = value => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
const replies = value => [...new Set(Array.isArray(value) ? value.filter(n => Number.isSafeInteger(n) && n >= 1 && n <= GENRE_AUDIT_RESPONSE_LIMIT) : [])].sort((a, b) => a - b);

// Debug metadata only: no prompt, RP, baseline, persona, URL or API key strings.
export function normalizeJevDecisionTrace(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(GENRE_AUDIT_CODES.filter(code => value[code] && typeof value[code] === 'object' && !Array.isArray(value[code])).map(code => {
        const row = value[code];
        return [code, {
            aggregate: choices.has(row.aggregate) ? row.aggregate : 'na',
            aggregateConfidence: unit(row.aggregateConfidence), aggregateProbability: unit(row.aggregateProbability),
            final: choices.has(row.final) ? row.final : 'na',
            route: routes.has(row.route) ? row.route : 'insufficient_positive_evidence',
            facets: Array.isArray(row.facets) ? row.facets.slice(0, 6).map(facet => ({
                verdict: verdicts.has(facet?.verdict) ? facet.verdict : 'uncertain',
                confidence: unit(facet?.confidence), probability: unit(facet?.probability),
            })) : [],
            positiveReplies: replies(row.positiveReplies), failedReplies: replies(row.failedReplies),
            excludedReplies: replies(row.excludedReplies),
        }];
    }));
}
