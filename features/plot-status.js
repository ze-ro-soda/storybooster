import { CHARACTER_BOOST_CORRECTION_CODES, GENRE_BOOST_CORRECTION_CODES } from '../core/constants.js';

// Fixed cause IDs are also safe to include in shared debug reports.
export function plotDecisionBlockReason(decision) {
    if (!decision) return 'insufficient_input';
    if (decision.eligible) return '';
    if (decision.quiet_progress === 'yes') return 'legacy_quiet_progress';
    if (decision.existing_thread_progress === 'yes') return 'immediate_beat';
    if (decision.user_direction_blocks === 'yes') return 'user_direction';
    if (decision.duplicate === 'yes') return 'duplicate';
    if (decision.insertion_safe === 'no') return 'unsafe_insertion';
    if (['existing_thread_progress', 'insertion_safe', 'user_direction_blocks', 'duplicate'].some(k => !['yes', 'no'].includes(decision[k]))) return 'uncertain_safety';
    return decision.basis ? 'candidate_mismatch' : 'no_supported_opening';
}
export function plotDecisionReason(decision, { prepared = false } = {}) {
    const skipped = `이번에는 자동 랜덤박스를 ${prepared ? '적용' : '준비'}하지 않습니다.`;
    if (decision?.eligible) return decision.basis === 'natural_opening'
        ? '자연스럽게 보탤 작은 계기를 확인해 일반 랜덤박스를 준비합니다.'
        : '전개 정체를 확인해 일반 랜덤박스를 준비합니다.';
    const reasons = {
        insufficient_input: '사건 계기를 판단할 근거가 부족해', legacy_quiet_progress: '이전 형식의 판정에서 일상·감정 흐름을 우선하므로',
        immediate_beat: '진행 중인 중요한 대화·행동을 우선하므로', user_direction: '유저가 정한 방향과 즉각 필요한 응답을 우선하므로',
        duplicate: '최근 사건과 겹칠 가능성이 있어', unsafe_insertion: '현재 장면에 새 계기를 넣기 적절하지 않아',
        uncertain_safety: '안전한 삽입 시점이나 유저 의도가 불명확해', candidate_mismatch: '준비한 사건이 최신 입력이나 유저 선택권에 맞지 않아',
        no_supported_opening: '정체나 자연스러운 사건 계기를 뒷받침할 근거가 부족해',
    };
    return `${reasons[plotDecisionBlockReason(decision)]} ${skipped}`;
}
export function plotAuditHoldReason(result) {
    const problems = new Set([...(result.correctionCodes || []), ...Object.entries(result.ratings || {})
        .filter(([code, rating]) => ['weak', 'drifted', 'biased'].includes(rating) || (rating === 'attention' && !result.uncertain?.includes(code))).map(([code]) => code)]);
    const genre = [...problems].some(c => GENRE_BOOST_CORRECTION_CODES.has(c));
    const character = [...problems].some(c => CHARACTER_BOOST_CORRECTION_CODES.has(c));
    if (genre || character) return `${genre && character ? '장르·캐릭터' : genre ? '장르' : '캐릭터'} 보정을 우선하므로 이번에는 자동 랜덤박스를 준비하지 않습니다.`;
    return '장르·캐릭터 진단 결과를 충분히 확인하지 못해 이번에는 자동 랜덤박스를 준비하지 않습니다.';
}
