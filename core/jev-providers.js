// Fixed destinations only: credentials are never inferred from a key prefix or
// forwarded to another provider on failure. No arbitrary endpoint setting.
export const JEV_PROVIDERS = Object.freeze({
    typesafe: Object.freeze({ id: 'typesafe', label: 'Typesafe',
        endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' }),
    nanogpt: Object.freeze({ id: 'nanogpt', label: 'NanoGPT',
        endpoint: 'https://api.nano-gpt.com/api/v1/decisions', model: 'typesafe/jev-latest' }),
});
export function normalizeJevProvider(value) {
    return value === 'nanogpt' ? 'nanogpt' : 'typesafe';
}
export function getJevProviderConfig(value) {
    if (!Object.hasOwn(JEV_PROVIDERS, value)) {
        throw Object.assign(new Error('Jev 연결 제공자를 다시 선택해 주세요.'),
            { code: 'STORYBOOSTER_JEV_PROVIDER_INVALID', stage: 'jev_connection' });
    }
    return JEV_PROVIDERS[value];
}
