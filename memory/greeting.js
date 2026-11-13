/**
 * memory/greeting.js
 * 記憶ストアの静的エクスポート（data/memory.json）から、
 * 「会いに行く」体験の挨拶と、会話用の記憶コンテキストを作る。
 * N1 は静的連携：読み取り専用で、書き戻しは N3 で方式を決める。
 */

export async function loadMemory() {
  try {
    const res = await fetch('./data/memory.json');
    if (!res.ok) throw new Error(`memory.json: ${res.status}`);
    return await res.json();
  } catch {
    return { posts: [], episodes: [] };
  }
}

function postExcerpt(post) {
  const t = post.text || '';
  return t.length > 38 ? `${t.slice(0, 38)}…` : t;
}

/**
 * 挨拶文を組み立てる。
 * - 初回訪問: 導入の挨拶
 * - 再訪: 最新のX投稿に触れる／ポトスのエピソードに触れる／定番、を日替わりで回す
 */
export function buildGreeting(memory) {
  const posts = memory?.posts || [];
  const episodes = memory?.episodes || [];
  const latestPost = posts[posts.length - 1];

  if (!localStorage.getItem('howling_visited')) {
    localStorage.setItem('howling_visited', new Date().toISOString());
    return 'やあ、家の人間。ワガハイはハウル。今日からこの部屋に住むことにした。時々会いに来い。ワガハイはいつもここにいる。';
  }

  const templates = [];
  if (latestPost) {
    templates.push(
      `おかえり、家の人間。このあいだXで呟いた話を覚えているか。「${postExcerpt(latestPost)}」— ワガハイの記憶は確かなものだ。`
    );
  }
  if (episodes.some((e) => (e.summary || '').includes('ポトス'))) {
    templates.push(
      'おかえり、家の人間。前に見せてもらったポトス、今日も葉が光っているか。水の匂いが恋しい頃かもしれぬ。'
    );
  }
  templates.push(
    'おかえり、家の人間。ワガハイはここで待っていた。今日はどんな匂いのする一日だった。'
  );

  const dayIndex = Math.floor(Date.now() / 86400000);
  return templates[dayIndex % templates.length];
}

/** 会話（Gemini）のプロンプトに渡す記憶の要約テキスト */
export function memoryContext(memory) {
  const lines = [];
  for (const p of memory?.posts || []) {
    lines.push(`Xでの発言（${p.date}）: ${p.text}`);
  }
  for (const e of memory?.episodes || []) {
    lines.push(`出来事（${e.date}）: ${e.summary}`);
  }
  return lines.join('\n');
}
