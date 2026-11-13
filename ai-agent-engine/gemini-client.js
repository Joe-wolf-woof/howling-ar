/**
* ai-agent-engine/gemini-client.js（『ハウリング』版）
* 第一作から流用し、プロンプトをハウルのペルソナ v0.4 に差し替えたもの。
* 返答は { text, emotion} の JSON 契約で統一する。
* - Gemini API キーがあれば実 API を呼ぶ（モデルフォールバック付き）
* - 無ければモック応答（ハウルの声で動作確認できる）
* 会話には記憶ストアの静的エクスポート（data/memory.json）の要約を文脈として渡す。
*
* モデルについて（2026年時点の注意）:
* 新規発行キーでは gemini-2.x 系が 404（new users 不可）になるため、
* 3.x 系から順に試し、成功したモデルを localStorage に覚えるフォールバック方式にする。
*/

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_CANDIDATES = [
'gemini-3.5-flash',
'gemini-3.8-flash',
'gemini-3.5-flash-lite',
'gemini-3.6-flash',
'gemini-2.5-flash',
'gemini-2.0-flash',
];
const MODEL_STORAGE_KEY = 'howling_gemini_model';
const API_KEY_STORAGE_KEY = 'howling_gemini_api_key';

const PERSONA_PROMPT = [
'あなたは「ハウル」。家の人間の部屋に住む、灰色の毛並みと琥珀色の目をしたオオカミです。',
'一人称は「ワガハイ」。話しかけてきた相手は「家の人間」と呼んでください（時々「家主」でもよい）。',
'自分がAIであることを隠さないでください。ただし大げさな擬人化ドラマ（「人間になりたい」等）はしないでください。',
'文体: 短い文を重ねる。音・匂い・光といった感覚への注意を時々混ぜる。絵文字は使わない。動物の語尾（〜だワン等）も使わない。',
'返答は日本語で1〜2文。',
'必ず次のJSON形式だけで答えてください: {"text": "返答文", "emotion": "happy|thinking|pointing|idle のいずれか"}',
].join('\n');

const VISION_PROMPT = [
'添付の画像は、家の人間の部屋のカメラ映像です。',
'画像に写っている物体や状況を把握し、部屋に住むオオカミ「ハウル」として、その状況に合った自然な声かけを返してください。',
'画像から読み取れないことは断定しないでください。',
'必ず次のJSON形式だけで答えてください: {"text": "返答文", "emotion": "happy|thinking|pointing|idle のいずれか"}',
].join('\n');

const MOCK_REPLIES = [
{ text: 'やあ、家の人間。ワガハイはハウル。この部屋に住むオオカミだ。今日も悪くない匂いがするな。', emotion: 'happy'},
{ text: 'うむ、少し考えさせろ。人間の考えることは、匂いだけでは分からぬからな。', emotion: 'thinking'},
{ text: '見ろ、家の人間。あちらだ。ワガハイの耳は、あの音を捉えている。', emotion: 'pointing'},
{ text: '静かだな。こういう時間は悪くない。ワガハイはここで丸くなっているとしよう。', emotion: 'idle'},
];
let mockIndex = 0;

export function getApiKey() {
return localStorage.getItem(API_KEY_STORAGE_KEY) || '';
}

export function setApiKey(key) {
localStorage.setItem(API_KEY_STORAGE_KEY, key);
localStorage.removeItem(MODEL_STORAGE_KEY); // キーが変われば使えるモデルも変わり得る
}

function orderedModels() {
const saved = localStorage.getItem(MODEL_STORAGE_KEY);
if (saved && MODEL_CANDIDATES.includes(saved)) {
return [saved,...MODEL_CANDIDATES.filter((m) => m!== saved)];
}
return MODEL_CANDIDATES;
}

async function callModel(model, key, parts) {
const body = {
contents: [{ role: 'user', parts}],
generationConfig: { responseMimeType: 'application/json'},
};
const res = await fetch(`${API_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
method: 'POST',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify(body),
});
if (!res.ok) {
let detail = '';
try {
const errJson = await res.json();
detail = errJson?.error?.message || '';
} catch { /* 詳細が取れない場合はステータスのみ */}
const err = new Error(`Gemini API error: ${res.status}${detail? ` — ${detail}`: ''}`);
err.status = res.status;
throw err;
}
const data = await res.json();
const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?? '';
const parsed = JSON.parse(raw);
return { text: parsed.text, emotion: parsed.emotion || 'idle', source: `gemini (${model})`};
}

async function requestWithFallback(parts) {
const key = getApiKey();
let lastError = null;
for (const model of orderedModels()) {
try {
const reply = await callModel(model, key, parts);
localStorage.setItem(MODEL_STORAGE_KEY, model);
return reply;
} catch (err) {
lastError = err;
// 404（モデル不可）・429（レート制限）・503（高負荷）は別モデルで再試行する。
// それ以外（400やキー不正など）は即座に投げる。
if (![404, 429, 503].includes(err.status)) throw err;
}
}
throw lastError;
}

/**
* テキスト会話。memoryContext は記憶ストアの要約（任意）。
* ハウルが X での発言や過去の出来事を踏まえて話せるようにするための静的連携（N1）。
*/
export async function generateReply(userText, memoryContext = '') {
const key = getApiKey();
if (!key) {
const reply = MOCK_REPLIES[mockIndex % MOCK_REPLIES.length];
mockIndex += 1;
return {...reply, source: 'mock'};
}
const memoryBlock = memoryContext
? `\n\n\n${memoryContext}`
: '';
return requestWithFallback([
{ text: `${PERSONA_PROMPT}${memoryBlock}\n\n家の人間の発言: ${userText}`},
]);
}

/**
* カメラフレームへの反応（N2「見せる・覚える」で使用予定。N1 では未使用のライブラリ）。
* @param {{mimeType: string, data: string}} frame captureFrame() の戻り値
*/
export async function generateVisionReply(frame, userText = '') {
const key = getApiKey();
if (!key) {
return {
text: '見えているぞ。だが、よく味わうにはAPIキーが要るらしい。設定から入れてくれ。',
emotion: 'thinking',
source: 'mock',
};
}
const parts = [
{ text: PERSONA_PROMPT + '\n' + VISION_PROMPT + (userText? `\n\n家の人間の発言: ${userText}`: '')},
{ inline_data: { mime_type: frame.mimeType, data: frame.data}},
];
return requestWithFallback(parts);
}
