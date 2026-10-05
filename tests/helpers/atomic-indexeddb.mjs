// Transactional test double, not a substitute for Android/browser verification.
// Transactions on the same store run serially; chained requests finish before commit.
export function atomicIndexedDB() {
    const records = new Map();
    const faults = { open: false, commit: false };
    const copy = value => value === undefined ? value : structuredClone(value);
    const transactions = [];
    let running = false;
    function pump() {
        if (running || !transactions.length) return;
        running = true;
        queueMicrotask(() => transactions[0]());
    }
    const database = {
        objectStoreNames: { contains: () => true }, close() {},
        transaction(_store, mode) {
            let active = false, finished = false, aborted = false, pending = 0, staged;
            const waiting = [];
            function finish(failed) {
                if (finished) return;
                finished = true;
                if (!failed && mode === 'readwrite') {
                    records.clear(); for (const [key, value] of staged) records.set(key, value);
                }
                if (failed) tx.onabort?.(); else tx.oncomplete?.();
                transactions.shift(); running = false; pump();
            }
            function maybeCommit() {
                queueMicrotask(() => {
                    if (finished || !active || pending) return;
                    finish(aborted || (faults.commit && mode === 'readwrite'));
                });
            }
            function request(fn) {
                const req = {};
                pending++;
                const execute = () => queueMicrotask(() => {
                    if (finished) return;
                    if (aborted) { pending--; maybeCommit(); return; }
                    try { req.result = fn(); req.onsuccess?.(); }
                    catch { aborted = true; req.onerror?.(); }
                    pending--; maybeCommit();
                });
                if (active) execute(); else waiting.push(execute);
                return req;
            }
            const tx = {
                abort() { aborted = true; if (active) maybeCommit(); },
                objectStore() {
                    return {
                        get: key => request(() => copy(staged.get(key))),
                        getAll: () => request(() => [...staged.values()].map(copy)),
                        put: value => request(() => { staged.set(value.scope, copy(value)); return value.scope; }),
                        delete: key => request(() => staged.delete(key)),
                    };
                },
            };
            transactions.push(() => {
                active = true;
                staged = new Map([...records].map(([k, v]) => [k, copy(v)]));
                for (const run of waiting) run();
                maybeCommit();
            });
            pump();
            return tx;
        },
    };
    const indexedDB = { open() {
        const request = {};
        queueMicrotask(() => {
            if (faults.open) request.onerror?.();
            else { request.result = database; request.onsuccess?.(); }
        });
        return request;
    } };
    return { indexedDB, records, faults };
}
