import fs from 'node:fs';
import crypto from 'node:crypto';

export const root = new URL('../../', import.meta.url);
export const declarations = JSON.parse(fs.readFileSync(new URL('tests/helpers/declaration-map.json', root), 'utf8')).sort((a, b) => a.order - b.order);
const mutable = ['activeBoosterPopupRoot', 'currentStoryInjectionText', 'currentPlotInjectionText', 'lastErrorLogHintAt', 'plotPending'];

// Reconstruct moved declarations in baseline order for the original regression
// harness. Bodies come from the actual modules, never the baseline fixture.
export function readDeclarations() {
    const files = new Map();
    return declarations.map(record => {
        if (!files.has(record.owner)) files.set(record.owner, fs.readFileSync(new URL(record.owner, root), 'utf8'));
        const content = files.get(record.owner);
        const marker = `// @source-order ${record.order}\n`;
        const start = content.indexOf(marker) + marker.length;
        if (start < marker.length) throw new Error(`Missing moved declaration: ${record.order}`);
        const next = content.indexOf('// @source-order ', start);
        const exports = content.indexOf('\n\nexport {', start);
        const end = next >= 0 ? next : exports >= 0 ? exports : content.length;
        let text = content.slice(start, end).trim();
        if (text.startsWith('export function initializeStoryBooster() {\n')) {
            text = text.slice('export function initializeStoryBooster() {\n'.length).trim();
            text = text.slice(0, text.lastIndexOf('}')).trim();
        }
        for (const name of mutable) text = text.replaceAll(`runtime.${name}`, name);
        if (record.kind === 'VariableDeclaration' && mutable.includes(record.names[0])) text = 'let ' + text;
        if (record.kind === 'ImportDeclaration') text = text.replace('../../../../extensions.js', '../../../extensions.js').replace('../../../../../script.js', '../../../../script.js');
        return { ...record, text };
    });
}

export function readModuleSource() {
    const lifecycle = fs.readFileSync(new URL('core/request-lifecycle.js', root), 'utf8').replace(/^export /gm, '');
    const characterAuditState = fs.readFileSync(new URL('core/character-audit-state.js', root), 'utf8')
        .replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
    return lifecycle + '\n' + characterAuditState + '\n' + readDeclarations().map(record => record.text).join('\n\n') + '\n';
}

// Intentional feature changes are reviewed separately and tested through the
// imported Jev/automatic-plot paths. All other baseline declarations stay exact.
export const changedDeclarations = new Set([
    136, 219, 243, // Missing-version recovery, shared invalidation and last-field preservation.
    172, // Transcript equality check for asynchronously prepared plot instructions.
    174, 175, 176, 177, // Separate visible provider text from thoughts on every parser path.
    159, // Approved common 4800-token writing budget for both engines and all scopes.
    187, 188, 189, 190, 191, 340, 206, 207, 208, 209,
    67, 76, 78, // Facet-first diagnostic summaries and controlled validation details.
    81, 365, 366, 105, 106, 107, 119, 151, 198, 199, 204, 205, 210, 211, 258, 260, 261, 264, 271, 275, 293, 298,
    269, 323, 329, 341, 344, 347, 357, 348, 349, 356, 358, 359, 360, 369, 370, 374, 376,
]);
export function verifyDeclarationParity() {
    const records = readDeclarations();
    for (const record of records) {
        if (changedDeclarations.has(record.order)) continue;
        const normalized = record.text.replace(/const STORYBOOSTER_VERSION = "[^";]+";/, 'const STORYBOOSTER_VERSION = "1.5.6";');
        const hash = crypto.createHash('sha256').update(normalized).digest('hex');
        if (hash !== record.baselineHash) throw new Error(`Unexpected baseline mismatch: ${record.owner} / ${record.names.join(', ') || record.order}`);
    }
    return records;
}
