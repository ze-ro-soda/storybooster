// StoryBooster: features/genre-model.js
import { GENRE_PROFILES } from "../core/constants.js";
import { hashStableText } from "../core/text.js";

// @source-order 148
function getGenreProfile(genre) {
    const configured = GENRE_PROFILES[genre.id];
    if (configured) return configured;

    const customDirection = String(genre.description || "").trim();
    const identity = customDirection
        ? `Follow this user-defined genre direction for ${genre.label}: ${customDirection
              .replace(/\s+/g, " ")
              .slice(0, 320)}`
        : `Make ${genre.label} perceptible through specific setting logic, character behavior, relationship pressure, and consequential movement.`;
    return {
        identity,
        ui:
            customDirection.replace(/\s+/g, " ").slice(0, 220) ||
            `${genre.label}의 고유한 분위기와 전개 방향을 캐릭터의 행동과 장면에 반영합니다.`,
        signals: "Express the direction through concrete, contextually justified details rather than merely naming it.",
        effects: "Let it shape {{char}}'s motives, choices, relationship behavior, or the scene's consequences.",
        texture: "Use its characteristic atmosphere, social logic, material detail, and prose rhythm when the scene supports them.",
        guard: "Do not force an unrelated event, stock trope, or detached explanation merely to display the genre.",
    };
}

// @source-order 149
function getGenreProfileSummary(profile) {
    return [
        profile.identity,
        profile.signals,
        profile.effects,
        profile.texture,
        profile.guard,
    ]
        .filter(Boolean)
        .join(" ");
}

// @source-order 150
function getGenreProfileAuditStandard(profile) {
    return [
        `Narrative identity: ${profile.identity}`,
        `Recognizable expression: ${profile.signals}`,
        `Character and relationship consequence: ${profile.effects}`,
        `Atmosphere and material texture: ${profile.texture}`,
        `False-positive boundary: ${profile.guard}`,
    ]
        .filter(Boolean)
        .join(" ");
}

// @source-order 151
function getGenreSelectionSignature(selection) {
    const primaryProfile = selection?.primaryGenre
        ? getGenreProfileSummary(getGenreProfile(selection.primaryGenre))
        : "";
    const supportProfile = selection?.supportGenre
        ? getGenreProfileSummary(getGenreProfile(selection.supportGenre))
        : "";
    return [
        selection?.autoPlotEnabled ? "auto-plot:on" : "auto-plot:off",
        String(selection?.primaryGenre?.id || ""),
        String(selection?.supportGenre?.id || ""),
        selection?.characterEnabled ? "character:on" : "character:off",
        selection?.characterBoostActive ? "character-boost:on" : "character-boost:off",
        String(selection?.characterBaselineStatus || ""),
        hashStableText(selection?.characterBaseline || ""),
        hashStableText(selection?.characterBoostAnchor || ""),
        primaryProfile,
        supportProfile,
    ].join("::");
}

export { getGenreProfile, getGenreProfileAuditStandard, getGenreProfileSummary, getGenreSelectionSignature };
