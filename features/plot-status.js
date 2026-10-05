import { CHARACTER_BOOST_CORRECTION_CODES, GENRE_BOOST_CORRECTION_CODES } from '../core/constants.js';

export function plotDecisionReason(decision, { prepared = false } = {}) {
    const skipped = `이번에는 자동 랜덤박스를 ${prepared ? '적용' : '준비'}하지 않습니다.`;
    if (!decision) return `사건 필요성을 판단할 근거가 부족해 ${skipped}`;
    if (decision.quiet_progress === 'yes') return `일상이나 감정 교류가 진행 중이어서 ${skipped}`;
    if (decision.existing_thread_progress === 'yes') return `진행 중인 사건이나 약속의 다음 단계를 우선하므로 ${skipped}`;
    if (decision.user_direction_blocks === 'yes') return `유저가 제시한 행동이나 질문에 대한 응답을 우선하므로 ${skipped}`;
    if (decision.duplicate === 'yes') return `최근 사건과 겹칠 가능성이 있어 ${skipped}`;
    if (decision.insertion_safe === 'no') return `현재 장면에 새 사건을 넣기 적절하지 않아 ${skipped}`;
    if (['stagnation', 'quiet_progress', 'existing_thread_progress', 'insertion_safe', 'user_direction_blocks', 'duplicate'].some(k => !['yes', 'no'].includes(decision[k])))
        return `사건 필요성이나 삽입 시점을 확실히 판단하기 어려워 ${skipped}`;
    if (decision.stagnation === 'no') return `뚜렷한 전개 정체가 확인되지 않아 ${skipped}`;
    return decision.eligible ? '전개 정체를 확인해 일반 랜덤박스를 준비합니다.' : `최근 답변에서 정체를 뒷받침하는 근거가 부족해 ${skipped}`;
}
export function plotAuditHoldReason(result) {
    const problems = new Set([...(result.correctionCodes || []), ...Object.entries(result.ratings || {})
        .filter(([code, rating]) => ['weak', 'drifted', 'biased'].includes(rating) || (rating === 'attention' && !result.uncertain?.includes(code))).map(([code]) => code)]);
    const genre = [...problems].some(c => GENRE_BOOST_CORRECTION_CODES.has(c));
    const character = [...problems].some(c => CHARACTER_BOOST_CORRECTION_CODES.has(c));
    if (genre || character) return `${genre && character ? '장르·캐릭터' : genre ? '장르' : '캐릭터'} 보정을 우선하므로 이번에는 자동 랜덤박스를 준비하지 않습니다.`;
    return '장르·캐릭터 진단 결과를 충분히 확인하지 못해 이번에는 자동 랜덤박스를 준비하지 않습니다.';
}
