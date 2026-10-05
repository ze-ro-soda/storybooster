// StoryBooster: core/context.js
import { getContext } from "./sillytavern.js";
import { hashStableText } from "./text.js";

// @source-order 102
function getCurrentChatId() {
    const context = getContext();
    // chatId is the standard per-chat identifier exposed by getContext();
    // fall back to a fixed key if it's ever missing (e.g. no chat open yet).
    return context?.chatId || "no-chat-open";
}

// @source-order 103
function getCurrentRoleDisplayNames() {
    let context = null;
    try {
        context = getContext();
    } catch {
        context = null;
    }
    const userName = String(context?.name1 || "").trim() || "유저";
    const characterName =
        context?.groupId == null
            ? String(
                  getCurrentCharacterIdentity()?.name || context?.name2 || ""
              ).trim() || "캐릭터"
            : "캐릭터";
    return { characterName, userName };
}

// @source-order 104
function resolveRoleMacrosForDisplay(value) {
    const { characterName, userName } = getCurrentRoleDisplayNames();
    return String(value || "")
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{user\}\}/gi, userName);
}

// @source-order 111
function getLatestAssistantMessageId(chat = getContext()?.chat) {
    if (!Array.isArray(chat)) return null;

    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (message && !message.is_user && !message.is_system) return index;
    }
    return null;
}

// @source-order 121
function getCurrentCharacterRecord() {
    const context = getContext();
    if (!context || context.groupId != null) return null;
    const characterId = Number(context.characterId);
    if (!Number.isSafeInteger(characterId) || !Array.isArray(context.characters)) {
        return null;
    }
    return context.characters[characterId] || null;
}

// @source-order 122
function getCharacterField(character, field) {
    // V2 character-card data is canonical. Keep the flattened legacy field as
    // a fallback for older SillyTavern versions and shallow character records.
    return String(character?.data?.[field] ?? character?.[field] ?? "").trim();
}

// @source-order 123
function buildCharacterCardSource(character = getCurrentCharacterRecord()) {
    if (!character) return "";
    const sections = [
        ["Description", getCharacterField(character, "description")],
        ["Personality", getCharacterField(character, "personality")],
        ["Example dialogue", getCharacterField(character, "mes_example")],
    ]
        .filter(([, value]) => value)
        .map(([label, value]) => `[${label}]\n${value}`)
        .join("\n\n");
    return sections;
}

// @source-order 125
function getCurrentCharacterIdentity() {
    const character = getCurrentCharacterRecord();
    if (!character) return null;
    const name = getCharacterField(character, "name") || "이름 없는 캐릭터";
    const avatar = getCharacterField(character, "avatar");
    const source = buildCharacterCardSource(character);
    return {
        character,
        name,
        key: avatar ? `avatar:${avatar}` : `name:${name}`,
        source,
        sourceHash: hashStableText(source),
    };
}

// @source-order 164
function clipTranscriptMessage(value, maxChars = 0) {
    const text = String(value || "").trim();
    if (!maxChars || text.length <= maxChars) return text;
    const marker = "\n[...middle omitted to limit analysis tokens...]\n";
    const available = Math.max(0, maxChars - marker.length);
    const headLength = Math.ceil(available * 0.65);
    const tailLength = Math.max(0, available - headLength);
    return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

// @source-order 169
function getRoleplayTranscript({
    messageLimit = 0,
    assistantRepliesOnly = 0,
    assistantRepliesWithUserContext = 0,
    latestUserContextOnly = false,
    numberAssistantReplies = false,
    perMessageMaxChars = 0,
    maxChars = 180000,
    chatSnapshot = null,
} = {}) {
    const chat = Array.isArray(chatSnapshot)
        ? chatSnapshot
        : Array.isArray(getContext()?.chat)
          ? getContext().chat
          : [];
    let messages = chat.filter(
        (message) =>
            message &&
            !message.is_system &&
            typeof message.mes === "string" &&
            message.mes.trim()
    );

    if (assistantRepliesWithUserContext > 0) {
        const assistantIndexes = messages
            .map((message, index) => (!message.is_user ? index : -1))
            .filter((index) => index >= 0)
            .slice(-assistantRepliesWithUserContext);
        const selectedIndexes = new Set(assistantIndexes);
        const contextIndexes = latestUserContextOnly
            ? assistantIndexes.slice(-1)
            : assistantIndexes;
        for (const assistantIndex of contextIndexes) {
            for (let index = assistantIndex - 1; index >= 0; index -= 1) {
                if (messages[index].is_user) {
                    selectedIndexes.add(index);
                    break;
                }
                if (!messages[index].is_user) break;
            }
        }
        messages = [...selectedIndexes]
            .sort((a, b) => a - b)
            .map((index) => messages[index]);
    } else if (assistantRepliesOnly > 0) {
        messages = messages
            .filter((message) => !message.is_user)
            .slice(-assistantRepliesOnly);
    } else if (messageLimit > 0) {
        messages = messages.slice(-messageLimit);
    }

    let assistantResponseNumber = 0;
    const formatted = messages.map((message) => {
        const role = message.is_user
            ? "USER_CONTEXT"
            : numberAssistantReplies
              ? `CHAR_RESPONSE_${++assistantResponseNumber}`
              : "CHAR";
        const name = String(message.name || role).replace(/\s+/g, " ").trim();
        return `[${role}:${name}]\n${clipTranscriptMessage(
            message.mes,
            perMessageMaxChars
        )}`;
    });

    const selected = [];
    let usedChars = 0;
    for (let index = formatted.length - 1; index >= 0; index -= 1) {
        const item = formatted[index];
        const remaining = maxChars - usedChars;
        if (remaining <= 0) break;
        if (item.length > remaining) {
            if (!selected.length) {
                selected.unshift(clipTranscriptMessage(item, remaining));
                usedChars = maxChars;
            }
            break;
        }
        selected.unshift(item);
        usedChars += item.length;
    }

    const wasTrimmed = selected.length < formatted.length;
    let retainedAssistantResponseNumber = 0;
    const finalSelected = numberAssistantReplies
        ? selected.map((item) =>
              item.replace(
                  /^\[CHAR_RESPONSE_\d+:/,
                  (match) =>
                      `[CHAR_RESPONSE_${++retainedAssistantResponseNumber}:`
              )
          )
        : selected;
    return [
        "<roleplay_transcript>",
        wasTrimmed ? "[Earlier messages omitted to fit the analysis window.]" : "",
        finalSelected.join("\n\n"),
        "</roleplay_transcript>",
    ]
        .filter(Boolean)
        .join("\n");
}

// @source-order 170
function snapshotCurrentChatMessages() {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) return [];
    return Object.freeze(
        chat.map((message) =>
            Object.freeze({
                is_user: Boolean(message?.is_user),
                is_system: Boolean(message?.is_system),
                mes: typeof message?.mes === "string" ? message.mes : "",
                name: typeof message?.name === "string" ? message.name : "",
            })
        )
    );
}

// @source-order 171
function createOperationContextSnapshot({
    chatId = getCurrentChatId(),
    chatSnapshot = [],
    characterKey = "",
    profileId = "",
    outputLanguage = "ko",
    responseLength = 0,
    selectionSignature = "",
    correctionRevision = null,
} = {}) {
    const sourceChatSnapshot = Array.isArray(chatSnapshot) ? chatSnapshot : [];
    const frozenChatSnapshot =
        Object.isFrozen(sourceChatSnapshot) &&
        sourceChatSnapshot.every((message) => Object.isFrozen(message))
            ? sourceChatSnapshot
            : Object.freeze(
                  sourceChatSnapshot.map((message) =>
                      Object.freeze({ ...message })
                  )
              );
    return Object.freeze({
        chatId: String(chatId),
        chatSnapshot: frozenChatSnapshot,
        characterKey: String(characterKey || ""),
        profileId: String(profileId || ""),
        outputLanguage: ["ko", "en"].includes(outputLanguage)
            ? outputLanguage
            : "ko",
        responseLength: Math.max(0, Number(responseLength) || 0),
        selectionSignature: String(selectionSignature || ""),
        correctionRevision:
            correctionRevision === null
                ? null
                : Math.max(0, Number(correctionRevision) || 0),
        startedAt: Date.now(),
    });
}

// @source-order 172
function isOperationContextCurrentChat(operationContext) {
    return String(getCurrentChatId()) === String(operationContext?.chatId || "");
}

// Compare only transcript fields, ignoring host bookkeeping changes. Used
// immediately before an asynchronously prepared instruction is auto-applied.
function isOperationContextCurrentMessages(operationContext) {
    if (!isOperationContextCurrentChat(operationContext)) return false;
    const before = operationContext?.chatSnapshot;
    const live = getContext()?.chat;
    if (!Array.isArray(before) || !Array.isArray(live) || before.length !== live.length) return false;
    return before.every((message, index) => {
        const current = live[index];
        return Boolean(message?.is_user) === Boolean(current?.is_user) &&
            Boolean(message?.is_system) === Boolean(current?.is_system) &&
            (typeof message?.mes === 'string' ? message.mes : '') === (typeof current?.mes === 'string' ? current.mes : '') &&
            (typeof message?.name === 'string' ? message.name : '') === (typeof current?.name === 'string' ? current.name : '');
    });
}

// @source-order 173
function isOperationContextCurrentCharacter(operationContext) {
    if (!operationContext?.characterKey) return false;
    return getCurrentCharacterIdentity()?.key === operationContext.characterKey;
}

export { buildCharacterCardSource, clipTranscriptMessage, createOperationContextSnapshot, getCharacterField, getCurrentCharacterIdentity, getCurrentCharacterRecord, getCurrentChatId, getCurrentRoleDisplayNames, getLatestAssistantMessageId, getRoleplayTranscript, isOperationContextCurrentCharacter, isOperationContextCurrentChat, isOperationContextCurrentMessages, resolveRoleMacrosForDisplay, snapshotCurrentChatMessages };
