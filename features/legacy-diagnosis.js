import { AUDIT_CORRECTION_ORDER, AUDIT_CORRECTION_MAX_CHARS, AUDIT_FACET_VERDICTS, AUDIT_PROBLEM_IMPACT, auditCorrectionWritingPrompt, formatAuditCorrectionInstruction, getAuditProblemImpact, hasSufficientCharacterFacets, rankAuditCorrections, reduceRepetitionEvidence, validateAuditCorrection } from '../core/audit-policy.js';
import { GENRE_AUDIT_CODES, GENRE_CORRECTION_MODULES, GENRE_CORRECTION_DESCRIPTIONS, CHARACTER_BASELINE_CORRECTION_CODES, CHARACTER_BASELINE_FIELD_ID_SET } from '../core/constants.js';
import { normalizeAuditReason } from '../core/text.js';

const NEGATIVE = { primary_genre: 'primaryFailure', genre_expression: 'genreExpressionFailure', support_texture: 'supportOpportunity', scene_density: 'sceneDensityFailure',
    character_consistency: 'characterConsistency', character_interpretation: 'characterInterpretation', char_agency: 'characterAgencyFailure', relationship: 'relationshipFailure', continuity: 'continuityFailure', repetition: 'repetition' };

export function legacyAuditPolicyPrompt(scope = 'combined') {
    return [
        'FINAL RATING POLICY OVERRIDE: attention means a confirmed concrete mild problem, never merely too few positive examples. If otherwise insufficient, ambiguous or essentially missing evidence prevents a decision, list the dimension in deferred_dimensions; it receives no automatic correction. Clear independently sufficient evidence can still decide the other dimensions. Confirmed failures take priority over unrelated unknowns. Quiet scenes, supported character growth and a trait without an opportunity are not defects.',
        'For every attention rating, cite the directly observed mild failure in its negative evidence array and explain that specific failure. One localized defect can justify a small repair, except repetition: cite BOTH members in repetition_evidence and identify their matching pattern in repetition_matches using left, right, kind and facet. Allowed repetition facets: wording, structure, gesture, emotion, relationship, ending. A pair with kind=pattern is attention; a connected same-facet, same-pattern group of three or more is weak. Do not combine unrelated pairs or different facets to inflate persistence. A pair with kind=near_verbatim is weak only for near-identical distinctive wording or a highly distinctive recycled beat, never a recurring name, required term, intentional echo or signature voice. One reply or unmatched numbers alone means defer repetition. Do not require novelty or ornate prose.',
        `Return problem_facets with every requested dimension ID mapped to the directly failed facet IDs, or [] if no confirmed defect. Allowed IDs and their shared next-response impact: ${JSON.stringify(AUDIT_PROBLEM_IMPACT)}. Do not include merely unknown, healthy or no-opportunity facets; do not invent numeric scores.`,
        scope !== 'genre' ? 'Return character_consistency_facets and character_interpretation_facets using every listed facet ID and one of yes, no, justified, temporary, no_opportunity, uncertain. no_opportunity means that the supplied scene does not test that trait or the baseline does not specify it; uncertain means an applicable observation is unclear. To decide stable, require two different positively supported facets when two or more are applicable. If exactly one facet has an opportunity and every other facet is no_opportunity, sufficient repeated positive reply evidence for that one facet is enough. Keep the existing positive-reply count requirements. A criminal trait not tested in quiet daily life is not a failure or mandatory display.' : '',
        'support_texture may also be attention for a localized missed natural opening. Do not list normal dormant secondary lenses or genuinely inapplicable na/unavailable fields as deferred.',
        `Choose at most two confirmed problems for corrections and next_corrections. A severe contradiction comes first, then weak/drifted/biased before attention, then next-response impact and distinct failed replies; resolve ties in this order: ${AUDIT_CORRECTION_ORDER.join(' > ')}. Deferred dimensions never qualify.`,
        auditCorrectionWritingPrompt(),
        'Write next_corrections as one concrete sentence in the requested output language (10-140 characters) describing what the next reply will repair, without explaining priority. Include every requested dimension key in both maps, using an empty string for each unselected or deferred dimension; only the selected two may have non-empty text. Return [] for deferred_dimensions when nothing is deferred.',
        'Return character_correction="" because per-dimension corrections already contain the instructions. Use the SAME final selection for character_focus_fields. Never focus baseline fields for repetition/continuity-only repairs. Reasons, selected corrections and next_corrections are returned together in this one JSON response; do not request another generation.',
    ].filter(Boolean).join('\n');
}

export function addLegacyAuditPolicySchema(schema) {
    const codes = GENRE_AUDIT_CODES.filter(code => Object.hasOwn(schema.schema.properties, code));
    const map = maxLength => ({ type: 'object', properties: Object.fromEntries(codes.map(code => [code, { type: 'string', maxLength }])), required: codes, additionalProperties: false });
    return { ...schema, schema: { ...schema.schema, properties: { ...schema.schema.properties,
        deferred_dimensions: { type: 'array', maxItems: codes.length, items: { type: 'string', enum: codes } },
        corrections: map(AUDIT_CORRECTION_MAX_CHARS), next_corrections: map(140),
        problem_facets: { type: 'object', properties: Object.fromEntries(codes.map(code => [code,
            { type: 'array', maxItems: 6, items: { type: 'string', enum: Object.keys(AUDIT_PROBLEM_IMPACT[code]) } }])), required: codes, additionalProperties: false },
        ...Object.fromEntries(['character_consistency', 'character_interpretation'].filter(code => codes.includes(code)).map(code => [`${code}_facets`, {
            type: 'object', properties: Object.fromEntries(Object.keys(AUDIT_PROBLEM_IMPACT[code]).map(id => [id, { type: 'string', enum: AUDIT_FACET_VERDICTS }])),
            required: Object.keys(AUDIT_PROBLEM_IMPACT[code]), additionalProperties: false,
        }])),
        ...(codes.includes('repetition') ? { repetition_matches: { type: 'array', maxItems: 10, items: { type: 'object', properties: {
            left: { type: 'integer', minimum: 1, maximum: 10 }, right: { type: 'integer', minimum: 1, maximum: 10 },
            kind: { type: 'string', enum: ['pattern', 'near_verbatim'] },
            facet: { type: 'string', enum: Object.keys(AUDIT_PROBLEM_IMPACT.repetition) },
        }, required: ['left', 'right', 'kind', 'facet'], additionalProperties: false } } } : {}),
    }, required: [...schema.schema.required, 'deferred_dimensions', 'corrections', 'next_corrections', 'problem_facets',
        ...['character_consistency', 'character_interpretation'].filter(code => codes.includes(code)).map(code => `${code}_facets`),
        ...(codes.includes('repetition') ? ['repetition_matches'] : [])] } };
}

export function finalizeLegacyAudit(result, parsed, outputLanguage, allowCorrectionFallback = false) {
    const applicable = GENRE_AUDIT_CODES.filter(code => !['na', 'unavailable'].includes(result.ratings[code]));
    for (const field of ['deferred_dimensions', 'corrections', 'next_corrections']) {
        if (!Object.hasOwn(parsed, field)) continue; // Older compatible providers can omit new fields.
        const value = parsed[field];
        const valid = field === 'deferred_dimensions'
            ? Array.isArray(value) && value.every(code => applicable.includes(code))
            : value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([code, text]) => GENRE_AUDIT_CODES.includes(code) && Object.hasOwn(parsed, code) && typeof text === 'string' && (!text.trim() || applicable.includes(code)));
        if (!valid) throw Object.assign(new Error('진단 정책 결과의 형식이 올바르지 않습니다.'), { code: 'STORYBOOSTER_INVALID_FIELDS' });
    }
    for (const code of ['character_consistency', 'character_interpretation']) {
        const value = parsed[`${code}_facets`];
        if (value === undefined) continue;
        const ids = Object.keys(AUDIT_PROBLEM_IMPACT[code]);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== ids.length ||
            !ids.every(id => AUDIT_FACET_VERDICTS.includes(value[id]))) {
            throw Object.assign(new Error('캐릭터 진단 근거의 형식이 올바르지 않습니다.'), { code: 'STORYBOOSTER_INVALID_FIELDS' });
        }
    }
    if (parsed.problem_facets !== undefined && (!parsed.problem_facets || typeof parsed.problem_facets !== 'object' || Array.isArray(parsed.problem_facets) ||
        !Object.entries(parsed.problem_facets).every(([code, ids]) => Object.hasOwn(parsed, code) && Object.hasOwn(AUDIT_PROBLEM_IMPACT, code) && Array.isArray(ids) && ids.length <= 6 && ids.every(id => Object.hasOwn(AUDIT_PROBLEM_IMPACT[code], id))))) {
        throw Object.assign(new Error('진단 문제 유형의 형식이 올바르지 않습니다.'), { code: 'STORYBOOSTER_INVALID_FIELDS' });
    }
    if (parsed.repetition_matches !== undefined && (!Array.isArray(parsed.repetition_matches) || parsed.repetition_matches.length > 10 ||
        !parsed.repetition_matches.every(pair => pair && Object.keys(pair).length === 4 && Number.isSafeInteger(pair.left) && Number.isSafeInteger(pair.right) &&
            pair.left >= 1 && pair.right >= 1 && pair.left <= 10 && pair.right <= 10 && pair.left !== pair.right && ['pattern', 'near_verbatim'].includes(pair.kind) && Object.hasOwn(AUDIT_PROBLEM_IMPACT.repetition, pair.facet)))) {
        throw Object.assign(new Error('반복 비교 근거의 형식이 올바르지 않습니다.'), { code: 'STORYBOOSTER_INVALID_FIELDS' });
    }
    const declared = new Set(parsed.deferred_dimensions || []), deferred = [], problems = [];
    for (const code of applicable) {
        const rating = result.ratings[code], failures = result.evidence[NEGATIVE[code]] || [];
        const repetition = code === 'repetition' ? reduceRepetitionEvidence(failures, parsed.repetition_matches, result.evidence.reviewedResponses) : null;
        const confirmed = (repetition ? repetition.confirmed : failures.length >= 1) &&
            (code !== 'support_texture' || ['attention', 'weak'].includes(parsed[code]));
        if (confirmed) {
            result.ratings[code] = repetition ? repetition.rating : ['weak', 'drifted', 'biased'].includes(rating) && !(code === 'support_texture' && failures.length < 2) ? rating : 'attention';
            problems.push({ code, rating: result.ratings[code], severe: code === 'character_consistency' ? parsed.character_consistency_severe : code === 'continuity' ? parsed.continuity_severe : false,
                impact: getAuditProblemImpact(code, parsed.problem_facets?.[code]), failedReplies: repetition ? repetition.evidence.length : failures.length, confidence: 0 });
            if (rating !== result.ratings[code]) result.reasons[code] = ['attention', 'weak', 'drifted', 'biased'].includes(parsed[code]) && parsed[`${code}_reason`]?.trim()
                ? normalizeAuditReason(parsed[`${code}_reason`], outputLanguage) : outputLanguage === 'en'
                  ? 'A localized problem was observed in this otherwise maintained dimension.' : '대체로 유지되고 있지만 일부 응답에서 이 항목의 작은 문제가 확인됐어요.';
        } else if ((code === 'repetition' && result.evidence.reviewedResponses < 2) || declared.has(code) || rating === 'attention' || ['attention', 'weak', 'drifted', 'biased'].includes(parsed[code]) ||
            (['character_consistency', 'character_interpretation'].includes(code) && !hasSufficientCharacterFacets(
                Object.entries(parsed[`${code}_facets`] || {}).map(([id, verdict]) => ({ id, verdict }))
            )) || (['character_consistency', 'character_interpretation'].includes(code) && Object.values(parsed[`${code}_facets`] || {}).includes('no'))) {
            result.ratings[code] = code === 'support_texture' ? 'dormant' : 'attention';
            deferred.push(code);
            result.reasons[code] = declared.has(code) && parsed[`${code}_reason`]?.trim() ? result.reasons[code]
                : outputLanguage === 'en' ? 'There is not enough clear applicable evidence to decide this dimension.' : '이 항목을 확정할 명확한 근거가 부족해 판단을 보류했어요.';
        }
    }
    result.uncertain = deferred;
    result.correctionCodes = rankAuditCorrections(problems);
    const hasFocus = result.correctionCodes.some(code => CHARACTER_BASELINE_CORRECTION_CODES.has(code));
    // Mild repairs enter the final selection here. Resolve their baseline
    // focus after that selection rather than keeping the earlier severe-only list.
    result.characterFocusFields = hasFocus ? [...new Set(
        (parsed.character_focus_fields || []).map(value => String(value || '').trim())
            .filter(value => CHARACTER_BASELINE_FIELD_ID_SET.has(value))
    )].slice(0, 2) : [];
    result.correctionByCode = Object.fromEntries(result.correctionCodes.map(code => {
        const validated = allowCorrectionFallback ? null : validateAuditCorrection(parsed.corrections?.[code], parsed.next_corrections?.[code], code);
        const generated = validated?.correction || '';
        const instruction = generated || GENRE_CORRECTION_MODULES[code];
        return [code, formatAuditCorrectionInstruction(instruction, result.ratings[code])];
    }));
    result.correctionSummaries = Object.fromEntries(result.correctionCodes.map(code => [code,
        (!allowCorrectionFallback && parsed.next_corrections?.[code]?.trim()) || (outputLanguage === 'en' ? `Repair ${code.replaceAll('_', ' ')} in the next reply.` : GENRE_CORRECTION_DESCRIPTIONS[code]) ]));
    // New per-code instructions prevent a combined correction from leaking
    // instructions for lower-priority or deferred dimensions into the reply.
    result.correctionText = '';
    result.correctionGeneration = result.correctionCodes.length && !allowCorrectionFallback ? 'generated' : result.correctionCodes.length ? 'template_fallback' : '';
    return result;
}
