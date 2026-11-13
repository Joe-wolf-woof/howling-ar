/**
 * ai-agent-engine/speech.js
 * 音声読み上げ（Web Speech API）。Phase 1 はブラウザ内蔵TTSで完結させる。
 * 将来的に高品質TTS（ElevenLabs等）へ差し替える場合も、この関数の裏側だけ変える。
 */
export function speak(text, lang = 'ja-JP') {
  if (!('speechSynthesis' in window)) {
    console.warn('speechSynthesis is not available in this browser.');
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = 1.0;
  window.speechSynthesis.speak(utter);
}
