import { onAuditRunTraceChange } from '../core/audit-run-trace.js';
import { getContext } from '../core/sillytavern.js';
import { recordStoryBoosterError } from '../core/diagnostics.js';
import { runAutomaticAuditTest } from '../features/audit.js';
import { openAuditRunTraceLog, refreshAuditRunTraceUi } from '../ui/tools.js';

import { isDeveloperModeUnlocked, onDeveloperModeChange } from '../core/debug-mode.js';
import { openDeveloperMode } from '../ui/debug-tools.js';

let initialized = false;
let testCommandsRegistered = false;
function registerTestCommands() {
    if (testCommandsRegistered || !isDeveloperModeUnlocked()) return;
    const { SlashCommandParser, SlashCommand } = getContext() || {};
    if (typeof SlashCommandParser?.addCommandObject !== 'function' || typeof SlashCommand?.fromProps !== 'function') return;
    const requireMode = () => { if (isDeveloperModeUnlocked()) return true; openDeveloperMode(); return false; };
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sb-auto-test', callback: async () => { if (requireMode()) await runAutomaticAuditTest(); return ''; },
            helpString: '개발자 모드에서 실제 자동진단을 1회 실행합니다. API 비용이 발생하며 보정·자동 랜덤박스가 준비될 수 있습니다.',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sb-audit-log', callback: () => { if (requireMode()) openAuditRunTraceLog(); return ''; },
            helpString: '개발자 모드에서 진단 진행 기록을 확인하고 복사합니다.',
        }));
        testCommandsRegistered = true;
    } catch (error) { recordStoryBoosterError(error, { task: 'audit_debug_commands', stage: 'command_registration', notify: false }); }
}
// Use the public context API; older hosts can use the hidden title gesture.
export function initializeAuditDebugTools() {
    if (initialized) return;
    initialized = true;
    onDeveloperModeChange(registerTestCommands);
    onAuditRunTraceChange(refreshAuditRunTraceUi);
    refreshAuditRunTraceUi();
    try {
        const { SlashCommandParser, SlashCommand } = getContext() || {};
        if (typeof SlashCommandParser?.addCommandObject !== 'function' || typeof SlashCommand?.fromProps !== 'function') return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sb-debug', callback: () => { openDeveloperMode(); return ''; },
            helpString: '비밀번호로 스토리부스터 개발자 도구를 엽니다.',
        }));
    } catch (error) {
        recordStoryBoosterError(error, { task: 'audit_debug_commands', stage: 'command_registration', notify: false });
    }
}
