import { takePreferenceOffer, acceptPreferenceOffer } from '../core/chat-preferences.js';
export function wireChatPreferences(root, refresh) {
    const tabs = root.querySelector('.rp-booster-tabs');
    if (!tabs?.before) return;
    const offer = takePreferenceOffer(); if (!offer) return;
    const box = document.createElement('div'); box.className = 'rp-carry-settings';
    const title = document.createElement('strong'); title.textContent = '이 캐릭터의 이전 설정을 이어쓸까요?';
    const summary = document.createElement('p'); summary.textContent = offer.proposed.label;
    const make = (text, fn) => {const el = document.createElement('button'); el.type = 'button'; el.className = 'rp-carry-action'; el.textContent = text; el.addEventListener('click',fn); return el;};
    box.append(title,summary,make('이전 설정 가져오기',()=>{
        if (acceptPreferenceOffer(offer)) refresh();
        else globalThis.toastr?.info?.('채팅이나 설정이 바뀌어 이전 설정을 적용하지 않았어요.');
        box.remove();
    }),make('새로 시작',()=>{offer.used=true;box.remove();}));
    tabs.before(box);
}
