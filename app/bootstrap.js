import { initializeAuditDebugTools } from './audit-debug.js';
import { onJevConnectionChange, getJevKeyRevision, restoreJevKey } from '../core/jev-client.js';
import { updateJevConnectionBadges } from '../ui/panels.js';
// StoryBooster: app/bootstrap.js
import { MODULE_NAME, PLOT_PROMPT_KEY } from "../core/constants.js";
import { recordStoryBoosterError } from "../core/diagnostics.js";
import { getActiveBoosterPopupRoot } from "../core/dom.js";
import { runtime } from "../core/runtime.js";
import { eventSource, event_types, extension_prompt_types, setExtensionPrompt } from "../core/sillytavern.js";
import { getBoosterSelection, handleGenreResponseReceived, handleGenreUserMessageSent, resyncLastCountedMessageId, updateGenrePrompt } from "../features/audit.js";
import { automaticPlotRuntime, cancelAutomaticPlot } from '../core/automatic-plot-state.js';
import { consumeAutomaticPlot } from '../features/automatic-plot.js';
import { ensureChatState } from '../core/storage.js';
import { closeCharacterEditorsForChatChange, notifyCharacterCardChangeIfNeeded } from "../features/character.js";
import { clearPlotPromptIfPending, restorePlotModeDraft, updatePlotGenerationPendingUi, updatePlotHistoryUI } from "../features/plot.js";
import { safelyUpdateCharacterBoosterPanel, updateGenreAnchorPanel } from "../ui/panels.js";
import { attachExtensionSettingsWithRetry, attachWandMenuButtonWithRetry, openBoosterPopup, refreshConnectionProfileSelects } from "../ui/popup.js";

// @source-order 95
console.log(`[${MODULE_NAME}] script loaded`);

// @source-order 376
export function initializeStoryBooster() {
jQuery(async () => {
    try {
        console.log(`[${MODULE_NAME}] initializing`);
        initializeAuditDebugTools();

        let observedKeyRevision = getJevKeyRevision();
        onJevConnectionChange(() => {
            const next = getJevKeyRevision();
            if (next !== observedKeyRevision) { observedKeyRevision = next; cancelAutomaticPlot('key_changed'); }
            updateJevConnectionBadges();
        });
        attachWandMenuButtonWithRetry();
        attachExtensionSettingsWithRetry();

        // delegated listener: works even if #rp-open-booster gets re-created
        // by SillyTavern re-rendering the wand menu later.
        document.addEventListener("click", (e) => {
            if (e.target.closest("#rp-open-booster")) {
                openBoosterPopup();
            }
        });

        // apply genre prompt for whichever chat is open at load time
        automaticPlotRuntime.getSelection = () => getBoosterSelection(ensureChatState());
        updateGenrePrompt();
        resyncLastCountedMessageId();

        // A received {{char}} response consumes a one-shot plot injection and
        // advances the automatic genre-drift counter. The quiet audit runs only
        // at the global interval selected by the user (default: ten replies),
        // while progress and results remain isolated per chat.
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
            try {
                consumeAutomaticPlot(messageId);
                clearPlotPromptIfPending();
                handleGenreResponseReceived(messageId);
            } catch (err) {
                console.error(`[${MODULE_NAME}] error in MESSAGE_RECEIVED handler:`, err);
                recordStoryBoosterError(err, {
                    task: "message_received_handler",
                    stage: "event_handler",
                });
            }
        });

        if (event_types.MESSAGE_SENT) {
            eventSource.on(
                event_types.MESSAGE_SENT,
                handleGenreUserMessageSent
            );
        }
        if (event_types.MESSAGE_DELETED) {
            eventSource.on(event_types.MESSAGE_DELETED, () => {
                setTimeout(resyncLastCountedMessageId, 0);
            });
        }

        // SillyTavern refreshes the in-memory character record before emitting
        // this event. Re-check immediately so an already-open StoryBooster
        // popup shows the change notice without requiring a chat switch or a
        // popup reopen. This is a local hash comparison and makes no AI call.
        if (event_types.CHARACTER_EDITED) {
            eventSource.on(event_types.CHARACTER_EDITED, () => {
                notifyCharacterCardChangeIfNeeded();
                safelyUpdateCharacterBoosterPanel("캐릭터 카드 저장");
            });
        }

        [
            event_types.CONNECTION_PROFILE_CREATED,
            event_types.CONNECTION_PROFILE_UPDATED,
            event_types.CONNECTION_PROFILE_DELETED,
        ]
            .filter(Boolean)
            .forEach((eventType) => {
                eventSource.on(eventType, refreshConnectionProfileSelects);
            });

        // when the user switches chats, reload state for the NEW chat and
        // discard any leftover one-shot plot injection from the previous chat
        eventSource.on(event_types.CHAT_CHANGED, () => {
            cancelAutomaticPlot('chat_changed');
            try {
                setExtensionPrompt(
                    PLOT_PROMPT_KEY,
                    "",
                    extension_prompt_types.IN_CHAT,
                    0
                );
                runtime.plotPending = false;
                runtime.currentPlotInjectionText = "";
            } catch (err) {
                console.error(
                    `[${MODULE_NAME}] failed to clear plot prompt after chat change:`,
                    err
                );
                recordStoryBoosterError(err, {
                    task: "plot_injection_clear",
                    stage: "chat_change_prompt_clear",
                });
            }
            closeCharacterEditorsForChatChange();
            updateGenrePrompt();
            resyncLastCountedMessageId();
            notifyCharacterCardChangeIfNeeded();
            updateGenreAnchorPanel();
            const popupRoot = getActiveBoosterPopupRoot();
            if (popupRoot) {
                restorePlotModeDraft(popupRoot.dataset.plotMode || "free");
                updatePlotHistoryUI();
                updatePlotGenerationPendingUi();
            }
        });

        [event_types.GENERATION_STOPPED].filter(Boolean).forEach(type => {
            eventSource.on(type, () => {
                if (automaticPlotRuntime.armed || automaticPlotRuntime.checking) cancelAutomaticPlot('generation_stopped');
            });
        });

        // Optional credential I/O must not delay anchors or chat event hooks.
        void restoreJevKey();
        console.log(`[${MODULE_NAME}] initialized successfully`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] failed to initialize:`, err);
        recordStoryBoosterError(err, {
            task: "extension_initialization",
            stage: "initialization",
        });
    }
});

}
