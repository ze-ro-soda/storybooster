// Same severity: next-reply impact, distinct failed replies, confidence, then
// stable order. These weights route repairs; they are not accuracy estimates.
import { getAuditProblemImpact, rankAuditCorrections } from '../core/audit-policy.js';
export function getJevProblemImpact(code, facets) {
    return getAuditProblemImpact(code, facets);
}
export function rankJevCorrections(problems) {
    return rankAuditCorrections(problems);
}
