// Only controlled codes and schema field names may enter diagnostic reports.
// Never retain provider messages, response values or unrecognized field names.
const DIMENSIONS = ['primary_genre', 'genre_expression', 'support_texture', 'scene_density',
    'character_consistency', 'character_interpretation', 'char_agency', 'relationship', 'continuity', 'repetition'];
const GROUPS = ['reasons', 'corrections', 'next_corrections'];
// Fixed schema names only. A regression test keeps these diagnostic allowlists
// aligned with the common character-facet contract.
const CHARACTER_FACETS = {
    character_consistency_facets: ['motives', 'values', 'boundaries', 'emotion', 'voice', 'vocabulary'],
    character_interpretation_facets: ['individuality', 'development', 'softening', 'balance', 'situation', 'nuance'],
};
const FIELDS = new Set(['response', 'character_focus_fields', ...GROUPS,
    ...GROUPS.flatMap(group => DIMENSIONS.map(id => `${group}.${id}`)),
    ...Object.keys(CHARACTER_FACETS),
    ...Object.entries(CHARACTER_FACETS).flatMap(([field, ids]) => ids.map(id => `${field}.${id}`))]);
const CODES = new Set(['field_missing', 'field_type', 'field_too_short', 'field_too_long',
    'unexpected_field', 'field_value', 'output_empty', 'json_incomplete', 'output_truncated',
    'reasoning_only', 'json_syntax', 'required_fields_missing', 'invalid_fields', 'incomplete_ratings',
    'schema_rejected', 'unknown']);

const FAILURE_PHASES = new Set(['connection', 'dispatch', 'response_validation', 'result_validation']);
const REQUEST_METHODS = new Set(['connection_profile', 'generateRawData', 'generateRaw', 'generateQuietPrompt']);
const REQUEST_ERRORS = new Set(['schema_unsupported', 'request_rejected', 'host_request_failed', 'network',
    'authentication', 'rate_limit', 'provider_error', 'timeout', 'cancelled', 'response_invalid', 'unknown']);

// Derive only fixed categories and an HTTP number. Never copy an error message,
// cause, stack, response body, endpoint or provider-defined field into a trace.
export function filterRequestFailureDetails(value = {}) {
    const out = {};
    if (FAILURE_PHASES.has(value.failurePhase)) out.failurePhase = value.failurePhase;
    if (REQUEST_METHODS.has(value.requestMethod)) out.requestMethod = value.requestMethod;
    if (REQUEST_ERRORS.has(value.requestError)) out.requestError = value.requestError;
    if (Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599) out.httpStatus = value.httpStatus;
    if (typeof value.schemaRequested === 'boolean') out.schemaRequested = value.schemaRequested;
    return out;
}

export function requestFailureDetails(error, diagnostic = {}) {
    const failures = [], seen = new Set();
    for (let current = error; current && !seen.has(current) && failures.length < 3; current = current.cause) {
        seen.add(current); failures.push(current);
    }
    const status = failures.map(e => Number(e.status || e.statusCode || e.response?.status))
        .find(n => Number.isSafeInteger(n) && n >= 400 && n <= 599);
    const codes = failures.map(e => String(e.code || '')).join(' ');
    const messages = failures.map(e => String(e.message || '')).join(' ').slice(0, 12000);
    const phase = FAILURE_PHASES.has(diagnostic.requestPhase) ? diagnostic.requestPhase : 'dispatch';
    const cancelled = failures.some(e => e.name === 'AbortError') || /ABORT|CANCELLED/i.test(codes);
    const kind = cancelled ? 'cancelled' : /TIMEOUT/i.test(codes) ? 'timeout'
        : status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|authentication/i.test(messages) ? 'authentication'
        : status === 429 ? 'rate_limit' : status >= 500 ? 'provider_error'
        : /network|failed to fetch|fetch failed|ECONNRESET|ENOTFOUND/i.test(messages + ' ' + codes) ? 'network'
        : /(?:schema|response[_ ]?format|structured output)[\s\S]{0,100}(?:not supported|unsupported|invalid|rejected)|(?:unsupported|invalid|rejected)[\s\S]{0,100}(?:schema|response[_ ]?format|structured output)/i.test(messages) ? 'schema_unsupported'
        : [400, 415, 422].includes(status) ? 'request_rejected'
        : /api request failed/i.test(messages) ? 'host_request_failed'
        : phase === 'response_validation' || phase === 'result_validation' ? 'response_invalid' : 'unknown';
    return filterRequestFailureDetails({ failurePhase: phase, requestMethod: diagnostic.method,
        requestError: kind, httpStatus: status, schemaRequested: diagnostic.schemaRequested });
}

export function filterResponseValidationDetails(value = {}) {
    const out = {};
    if (CODES.has(value.validationCode)) out.validationCode = value.validationCode;
    if (FIELDS.has(value.validationField)) out.validationField = value.validationField;
    return out;
}

export function feedbackValidationError(validationCode, validationField = 'response') {
    return Object.assign(new Error('진단의 판단 이유 또는 보정문이 누락되거나 형식이 잘못됐습니다.'), {
        code: 'STORYBOOSTER_INVALID_FIELDS', stage: 'response_validation',
        ...filterResponseValidationDetails({ validationCode, validationField }),
    });
}

export function responseValidationDetails(error) {
    const supplied = filterResponseValidationDetails(error || {});
    if (supplied.validationCode) return supplied;
    const codeMap = {
        STORYBOOSTER_EMPTY_STRUCTURED_OUTPUT: 'output_empty',
        STORYBOOSTER_INCOMPLETE_JSON: 'json_incomplete',
        STORYBOOSTER_TRUNCATED_JSON: 'output_truncated',
        STORYBOOSTER_REASONING_ONLY_OUTPUT: 'reasoning_only',
        STORYBOOSTER_REQUIRED_FIELDS_MISSING: 'required_fields_missing',
        STORYBOOSTER_INVALID_FIELDS: 'invalid_fields',
        STORYBOOSTER_INCOMPLETE_RATINGS: 'incomplete_ratings',
    };
    const code = Object.hasOwn(codeMap, error?.code) ? codeMap[error.code] : '';
    if (code) return { validationCode: code, validationField: 'response' };
    if (error instanceof SyntaxError) return { validationCode: 'json_syntax', validationField: 'response' };
    // HTTP status alone shows request/schema incompatibility, not a bad field.
    if ([400, 415, 422].includes(Number(error?.status || error?.statusCode))) {
        return { validationCode: 'schema_rejected', validationField: 'response' };
    }
    return { validationCode: 'unknown', validationField: 'response' };
}

export function responseRepairInstruction(error) {
    const { validationCode, validationField } = responseValidationDetails(error);
    // Generic JSON failures retain the existing compatibility instructions.
    // Add a targeted repair only when a controlled concrete field is known.
    if (!validationField || validationField === 'response') return '';
    const descriptions = {
        field_missing: 'A required field was missing.', field_type: 'A field had the wrong JSON type.',
        field_value: 'A field used a value outside the allowed choices.', unexpected_field: 'An object contained an unexpected key.',
        field_too_short: 'A field was shorter than the required minimum.', field_too_long: 'A field exceeded the required maximum.',
        output_empty: 'The visible output was empty.', json_incomplete: 'The JSON object was incomplete.',
        output_truncated: 'The JSON output was truncated.', reasoning_only: 'Only reasoning was returned, without a visible final JSON object.',
        json_syntax: 'The JSON syntax was invalid.', required_fields_missing: 'Required fields were missing.',
        invalid_fields: 'A required field failed validation.', incomplete_ratings: 'Required ratings or evidence were incomplete.',
    };
    if (!descriptions[validationCode]) return '';
    const field = validationField || 'response';
    const parent = field.split('.')[0];
    const facetContract = Object.hasOwn(CHARACTER_FACETS, parent)
        ? ` ${parent} must be one JSON object with exactly these six keys: ${CHARACTER_FACETS[parent].join(', ')}. Each value must be a string: yes, no, justified, temporary, no_opportunity, or uncertain. No arrays, booleans, nested objects, omitted keys, or additional keys.` : '';
    // Never include error.message, the raw response, or an unrecognized path.
    return `VALIDATION REPAIR: ${descriptions[validationCode]} Fixed field: ${field}.${facetContract} Return the complete corrected JSON object, not a patch. Re-evaluate the evidence; do not replace unknown observations with positive verdicts just to satisfy validation.`;
}
