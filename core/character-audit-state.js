import { GENRE_BOOST_CORRECTION_CODES } from './constants.js';

// Shared by explicit baseline changes and recovery of a missing version.
// Character findings cannot survive a switch to a different baseline; genre
// findings, pending genre repairs and the automatic schedule remain valid.
export function invalidateCharacterAuditState(anchor, auditInterval) {
    const characterAuditId = anchor.lastCharacterAudit?.id || '';
    const genreCodes = (anchor.correctionCodes || []).filter(code => GENRE_BOOST_CORRECTION_CODES.has(code));
    const retainGenreMap = value => Object.fromEntries(Object.entries(value || {})
        .filter(([code]) => genreCodes.includes(code)));

    if (anchor.lastGenreAudit) {
        const auditCodes = (anchor.lastGenreAudit.correctionCodes || []).filter(code => GENRE_BOOST_CORRECTION_CODES.has(code));
        anchor.lastGenreAudit = { ...anchor.lastGenreAudit, correctionCodes: auditCodes,
            correctionText: '', characterFocusFields: [] };
        if (anchor.lastGenreAudit.correctionByCode) {
            anchor.lastGenreAudit.correctionByCode = Object.fromEntries(Object.entries(anchor.lastGenreAudit.correctionByCode)
                .filter(([code]) => auditCodes.includes(code)));
        }
        if (!auditCodes.length && ['pending', 'applied', 'cancelled'].includes(anchor.lastGenreAudit.status)) {
            anchor.lastGenreAudit.status = 'stable';
            anchor.lastGenreAudit.appliedMessageId = null;
        }
    }
    anchor.lastCharacterAudit = null;
    if (anchor.lastAudit?.id === characterAuditId) {
        anchor.lastAudit = anchor.lastGenreAudit?.id === characterAuditId ? anchor.lastGenreAudit : null;
    }
    anchor.correctionCodes = genreCodes;
    anchor.correctionText = '';
    anchor.correctionByCode = retainGenreMap(anchor.correctionByCode);
    anchor.correctionFieldIds = [];
    anchor.correctionCharacterBaselineHash = '';
    anchor.correctionArmedRevision = 0;
    if (!genreCodes.length) {
        anchor.correctionRemaining = 0;
        anchor.correctionAppliedMessageId = null;
        anchor.auditStatus = auditInterval === 0 ? 'waiting' : 'monitoring';
    }
}
