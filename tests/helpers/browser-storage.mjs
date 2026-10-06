// Shared browser-local persistence for independent VM graphs/tabs.
export function browserStorage() {
    const records = new Map(), faults = { read: false, write: false };
    return { records, faults, storage: {
        getItem(key) { if (faults.read) throw new Error('synthetic-read-failure'); return records.get(key) ?? null; },
        setItem(key, value) { if (faults.write) throw new Error('synthetic-write-failure'); records.set(String(key), String(value)); },
        removeItem(key) { if (faults.write) throw new Error('synthetic-write-failure'); records.delete(key); },
        clear() { records.clear(); },
    } };
}
export function sharedBrowserStorage(db) { return db.browserStorage ||= browserStorage(); }
