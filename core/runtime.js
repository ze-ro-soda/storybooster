// StoryBooster: core/runtime.js


export const runtime = {};

// @source-order 51
runtime.activeBoosterPopupRoot = null;

// @source-order 52
runtime.currentStoryInjectionText = "";

// @source-order 53
runtime.currentPlotInjectionText = "";

// @source-order 54
const recordedErrorObjects = new WeakSet();

// @source-order 55
const preparedModuleSettings = new WeakSet();

// @source-order 56
const preparedChatStates = new WeakSet();

// @source-order 57
const preparedGenreAnchors = new WeakSet();

// @source-order 58
runtime.lastErrorLogHintAt = 0;

// @source-order 195
const genreAuditPendingChats = new Set();

// @source-order 213
const characterBaselinePendingTasks = new Map();

// @source-order 214
const characterBaselineAutosaveTimers = new Map();

// @source-order 215
const characterBaselineRevisionProposals = new Map();

// @source-order 277
runtime.plotPending = false;

// @source-order 278
const eventGenerationPendingTasks = new Map();

// @source-order 279
const plotModeDraftsByChat = new Map();

// @source-order 338
const genreRecommendationPendingChats = new Set();

export { characterBaselineAutosaveTimers, characterBaselinePendingTasks, characterBaselineRevisionProposals, eventGenerationPendingTasks, genreAuditPendingChats, genreRecommendationPendingChats, plotModeDraftsByChat, preparedChatStates, preparedGenreAnchors, preparedModuleSettings, recordedErrorObjects };
