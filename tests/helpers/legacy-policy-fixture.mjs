// Synthetic observations for historical tests that predate the common policy
// schema. New policy boundary tests build their own observations explicitly.
import { AUDIT_PROBLEM_IMPACT } from '../../core/audit-policy.js';

const negative = { primary_genre: 'primary_genre_failure_evidence', genre_expression: 'genre_expression_failure_evidence',
    support_texture: 'support_texture_opportunity', scene_density: 'scene_density_failure_evidence',
    character_consistency: 'character_consistency_evidence', character_interpretation: 'character_interpretation_evidence',
    char_agency: 'char_agency_failure_evidence', relationship: 'relationship_failure_evidence', continuity: 'continuity_failure_evidence', repetition: 'repetition_evidence' };
const instruction = 'In the next reply, repair the observed synthetic lapse through one specific choice or response appropriate to the existing scene. Preserve already healthy behavior, the established motives and the partner’s freedom to respond. Do not manufacture a new event, reset the scene, or decide the partner’s thoughts, actions, dialogue or consent.';
export function completeLegacyPolicyFixture(payload) {
    const p = { ...payload };
    for (const code of ['character_consistency', 'character_interpretation']) {
        if (code in p && (!p[`${code}_facets`] || !Object.keys(p[`${code}_facets`]).length)) {
            p[`${code}_facets`] = Object.fromEntries(Object.keys(AUDIT_PROBLEM_IMPACT[code]).map(id => [id, 'yes']));
        }
    }
    p.problem_facets ||= {};
    for (const code of Object.keys(AUDIT_PROBLEM_IMPACT).filter(code => code in p)) {
        p.problem_facets[code] ||= [];
        if ((p[negative[code]] || []).length) {
            p.corrections ||= {}; p.next_corrections ||= {};
            if (!p.corrections[code]) p.corrections[code] = instruction;
            if (!p.next_corrections[code]) p.next_corrections[code] = 'Make one scene-appropriate choice that repairs the observed lapse.';
        }
    }
    if ('repetition' in p && (!p.repetition_matches || !p.repetition_matches.length)) {
        const ids = p.repetition_evidence || [];
        p.repetition_matches = ids.slice(1).map((right, i) => ({ left: ids[i], right,
            kind: p.repetition_exact ? 'near_verbatim' : 'pattern', facet: 'wording' }));
    }
    return p;
}
