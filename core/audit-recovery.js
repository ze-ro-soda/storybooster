// Local scheduling only. One immediate recovery; further invalidations wait for
// a newly completed assistant reply. No polling and no provider probes.
export function auditRecoveryText(anchor) {
    const due = anchor?.automaticAuditRetry;
    if (!due || !['settling', 'next_response'].includes(due.mode)) return '';
    return due.mode === 'settling' ? '내용 변경으로 재진단 대기 중' : '다음 응답 후 재진단';
}

export function createAuditRecoveryController({ snapshot, anchor, busy, run, save, refresh, delay = 2000, timers = { set: setTimeout, clear: clearTimeout } }) {
    const jobs = new Map(), completions = new Map();
    let generating = false;
    const cancelTimer = job => { if (job?.timer) timers.clear(job.timer); if (job) job.timer = null; };
    const clear = chatId => {
        cancelTimer(jobs.get(chatId)); jobs.delete(chatId);
        const value = anchor(chatId);
        if (value?.automaticAuditRetry) { value.automaticAuditRetry = null; save(); }
    };
    function current(chatId) {
        const s = snapshot();
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
    function wake() {
        const s = snapshot(); if (!s) return;
        const value = current(s.chatId); if (!value || generating) return;
        let { due, job } = value;
        // A restored due flag never launches a paid request merely on page load.
        if (!job) {
            due.mode = 'next_response'; due.afterMessageId = s.latest;
            job = { context: s.context, timer: null }; jobs.set(s.chatId, job); save(); refresh(); return;
        }
        if (s.awaitingReply) { waitForResponse(value); return; }
        if (due.mode === 'next_response' && s.latest <= due.afterMessageId) return;
        if (completions.get(s.chatId) !== s.fingerprint || s.blocked || busy(s.chatId) || job.timer) return;
        const fingerprint = s.fingerprint;
        job.timer = timers.set(() => {
            job.timer = null;
            const next = current(s.chatId);
            if (!next || generating || next.s.blocked || busy(s.chatId)) return;
            if (next.s.awaitingReply) { waitForResponse(next); return; }
            if (next.s.fingerprint !== fingerprint) {
                next.due.mode = 'next_response'; next.due.afterMessageId = next.s.latest; save(); refresh(); return;
            }
            clear(s.chatId); refresh();
            Promise.resolve(run(s.chatId)).catch(() => {}); // run owns diagnostic reporting
        }, delay);
        job.timer?.unref?.();
    }
    function queue(chatId, start, repeated = false) {
        const s = snapshot();
        if (!s || s.chatId !== chatId || !s.enabled || s.guard !== start.guard || s.context !== start.context) return false;
        clear(chatId);
        const knownComplete = completions.get(chatId) === s.fingerprint;
        anchor(chatId).automaticAuditRetry = { guard: s.guard, mode: repeated || !knownComplete ? 'next_response' : 'settling', afterMessageId: s.latest };
        jobs.set(chatId, { context: s.context, timer: null }); save(); refresh(); wake(); return true;
    }
    function activity(kind) {
        const s = snapshot(); if (!s) return;
        if (kind === 'started') { generating = true; cancelTimer(jobs.get(s.chatId)); return; }
        if (kind === 'stopped') { generating = false; clear(s.chatId); refresh(); return; }
        if (kind === 'chat_changed') {
            generating = false;
            for (const job of jobs.values()) cancelTimer(job);
            // Existing in-flight audits cannot be revived after a chat round trip.
            jobs.clear(); completions.clear(); wake(); return;
        }
        if (kind === 'deleted') {
            const value = current(s.chatId);
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
        }
        wake();
    }
    return { queue, wake, clear, activity };
}
