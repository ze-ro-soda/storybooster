// Local scheduling only. Cancelled audits retain one earned opportunity for
// the next new assistant reply. Edits never launch an unbounded paid retry.
// Keep Window timer receivers intact when invoking the injected timer adapter.
export function auditRecoveryText(anchor) {
    const due = anchor?.automaticAuditRetry;
    if (!due || !['settling', 'next_response'].includes(due.mode)) return '';
    return due.mode === 'settling' ? '응답 정리 후 재진단 대기 중' : '다음 AI 응답 1회 후 재진단';
}

export function automaticAuditRemaining(anchor, interval) {
    return Math.max(0, interval - Math.max(0, Number(anchor?.responseCount) || 0));
}

export function createAuditRecoveryController({ snapshot, anchor, busy, run, save, refresh, delay = 2000, timers = { set: (callback, ms) => globalThis.setTimeout(callback, ms), clear: id => globalThis.clearTimeout(id) } }) {
    const jobs = new Map(), completions = new Map();
    let generating = false;
    const cancelTimer = job => { if (job?.timer != null) timers.clear(job.timer); if (job) job.timer = null; };
    const clear = chatId => {
        cancelTimer(jobs.get(chatId)); jobs.delete(chatId);
        const value = anchor(chatId);
        if (value?.automaticAuditRetry) { value.automaticAuditRetry = null; save(); }
    };
    function current(chatId, s = snapshot()) {
        if (!s || s.chatId !== chatId) return null;
        const due = anchor(chatId)?.automaticAuditRetry;
        const job = jobs.get(chatId);
        if (!due || !['settling', 'next_response'].includes(due.mode)) return null;
        if (!s.enabled || due.guard !== s.guard || (job && job.context !== s.context)) { clear(chatId); return null; }
        return { s, due, job };
    }
    function waitForResponse({ s, due, job }) {
        cancelTimer(job);
        if (due.mode !== 'next_response' || due.afterMessageId !== s.latest) {
            due.mode = 'next_response'; due.afterMessageId = s.latest; save(); refresh();
        }
    }
    function wake(s = snapshot()) {
        if (!s) return;
        const value = current(s.chatId, s); if (!value || generating) return;
        let { due, job } = value;
        // A restored due flag never launches a paid request merely on page load.
        if (!job) {
            due.mode = 'next_response'; due.afterMessageId = s.latest;
            job = { context: s.context, timer: null }; jobs.set(s.chatId, job); save(); refresh(); return;
        }
        if (s.awaitingReply) { waitForResponse(value); return; }
        if (due.mode === 'next_response' && s.latest <= due.afterMessageId) return;
        if (completions.get(s.chatId) !== s.fingerprint || s.blocked || busy(s.chatId) || job.timer != null || job.running) return;
        const fingerprint = s.fingerprint;
        job.timer = timers.set(() => {
            job.timer = null;
            const next = current(s.chatId);
            if (!next || next.job !== job || generating || next.s.blocked || busy(s.chatId)) return;
            if (next.s.awaitingReply) { waitForResponse(next); return; }
            if (next.s.fingerprint !== fingerprint) {
                // The earned new reply is still eligible. Wait for its updated
                // completion event; do not move the target to another reply.
                wake(next.s); return;
            }
            // Only result storage clears the debt. Clearing before run() lost
            // it on a busy skip, setup failure or a second invalidation.
            job.running = true;
            Promise.resolve().then(() => run(s.chatId)).catch(() => {}).finally(() => {
                job.running = false;
                const remaining = current(s.chatId);
                if (remaining?.job === job) waitForResponse(remaining);
            }); // run owns diagnostic reporting
        }, delay);
        job.timer?.unref?.();
    }
    function queue(chatId, start) {
        const s = snapshot();
        if (!s || s.chatId !== chatId || !s.enabled || s.guard !== start.guard || s.context !== start.context) return false;
        clear(chatId);
        anchor(chatId).automaticAuditRetry = { guard: s.guard, mode: 'next_response', afterMessageId: s.latest };
        jobs.set(chatId, { context: s.context, timer: null }); save(); refresh(); wake(s); return true;
    }
    function activity(kind) {
        if (kind === 'chat_changed') {
            generating = false;
            for (const job of jobs.values()) cancelTimer(job);
            jobs.clear(); completions.clear(); wake(); return;
        }
        if (kind === 'ended' || kind === 'stopped') generating = false;
        const s = snapshot(); if (!s) return;
        if (kind === 'started') { generating = true; cancelTimer(jobs.get(s.chatId)); return; }
        if (kind === 'stopped') { generating = false; clear(s.chatId); refresh(); return; }
        if (kind === 'deleted') {
            const value = current(s.chatId, s);
            if (value) {
                waitForResponse(value);
                completions.delete(s.chatId);
            }
            return;
        }
        if (['received', 'updated', 'ended'].includes(kind)) {
            if (kind === 'ended') generating = false;
            const old = completions.get(s.chatId); completions.set(s.chatId, s.fingerprint);
            if (old !== s.fingerprint) cancelTimer(jobs.get(s.chatId));
            const value = current(s.chatId, s);
            if (value?.job && value.due.mode === 'next_response' && s.latest > value.due.afterMessageId && !s.awaitingReply) {
                value.due.mode = 'settling'; save(); refresh();
            }
        }
        wake(s);
    }
    return { queue, wake, clear, activity };
}
