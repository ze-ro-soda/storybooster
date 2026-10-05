// StoryBooster: core/dom.js
import { runtime } from "./runtime.js";

// @source-order 59
function getActiveBoosterPopupRoot() {
    if (runtime.activeBoosterPopupRoot?.isConnected) return runtime.activeBoosterPopupRoot;
    const roots = [...document.querySelectorAll("#rp-booster-popup")];
    runtime.activeBoosterPopupRoot = roots[roots.length - 1] || null;
    return runtime.activeBoosterPopupRoot;
}

// @source-order 60
function getBoosterElement(id) {
    return getActiveBoosterPopupRoot()?.querySelector(`#${id}`) || null;
}

// @source-order 61
function getBoosterElements(selector) {
    return getActiveBoosterPopupRoot()?.querySelectorAll(selector) || [];
}

// @source-order 331
function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

export { escapeHtml, getActiveBoosterPopupRoot, getBoosterElement, getBoosterElements };
