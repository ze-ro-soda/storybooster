// One cancellation/timeout contract for main, profile and compatibility requests.
export function createRequestAbortError() {
    return Object.assign(new Error('백그라운드 요청이 취소되었습니다.'), {
        name: 'AbortError', code: 'STORYBOOSTER_REQUEST_ABORTED',
    });
}

export function throwIfRequestAborted(signal) {
    if (signal?.aborted) throw createRequestAbortError();
}

export async function runAbortableRequest(start, { signal, timeoutMs, timeoutMessage }) {
    throwIfRequestAborted(signal);
    const controller = new AbortController();
    let timeoutId;
    let rejectCancellation;
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    const abort = () => {
        // Reject first so a provider's AbortError cannot hide our timeout code.
        rejectCancellation(createRequestAbortError());
        controller.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timeoutId = setTimeout(() => {
        rejectCancellation(Object.assign(new Error(timeoutMessage), { code: 'STORYBOOSTER_REQUEST_TIMEOUT' }));
        controller.abort();
    }, timeoutMs);
    const request = Promise.resolve().then(() => {
        throwIfRequestAborted(signal);
        return start(controller.signal);
    });
    try {
        const value = await Promise.race([request, cancellation]);
        throwIfRequestAborted(signal);
        return value;
    } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abort);
    }
}
