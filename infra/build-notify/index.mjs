/**
 * wasyo-build-notify — Cloudflare Workers Builds のビルドイベントを Discord へ転送する Consumer Worker
 *
 * ■ 役割
 *   Workers Builds（本番 Worker = wasyo-prod）の Event Subscriptions が
 *     build.started / build.succeeded / build.failed / build.canceled
 *   を Cloudflare Queue（wasyo-build-events）へ発行する。本 Worker はそのキューを消費し、
 *   各イベントを Discord Webhook（ネイティブ形式 = embeds）へ POST する。
 *
 *   ※ この通知は Workers Builds の「ビルドイベント」の載せ替えであり、
 *     予約通知（GAS 側）とは別系統（MIGRATION_CLOUDFLARE.md §4-4）。
 *
 * ■ なぜこの方式か
 *   Event Subscriptions は「ビルドコンテナ内のコマンド実行」に依存せず build.failed を発火するため、
 *   ビルドが途中でクラッシュしても失敗通知が飛ぶ。curl をビルドコマンドに仕込む方式は不採用
 *   （途中で落ちると通知コマンドまで到達しない）。設計＝MIGRATION_CLOUDFLARE.md §2。
 *
 * ■ Discord への送信形式（ネイティブ embeds）
 *   env.DISCORD_WEBHOOK_URL は「素の」Discord Webhook URL（末尾に /slack は付けない）。
 *   本 Worker は { embeds: [...] } を POST する。color は 10 進整数（0xRRGGBB リテラル）、
 *   timestamp は ISO8601 文字列を Discord がそのまま解釈する。
 *
 * ■ イベントのペイロード形（公式ドキュメント＋公式テンプレ types.ts に準拠。フィールド名は出典のまま）
 *   {
 *     type: string,                       // 例 "cf.workersBuilds.worker.build.succeeded"
 *     source:  { type: string, workerName?: string },   // workerName = "wasyo-prod" など
 *     payload: {
 *       buildUuid: string,
 *       status: string,                   // running / success / failed / canceled
 *       buildOutcome: "success"|"failure"|"canceled"|"cancelled"|null,
 *       createdAt, initializingAt?, runningAt?, stoppedAt?,   // ISO タイムスタンプ
 *       buildTriggerMetadata?: {
 *         buildTriggerSource, branch, commitHash, commitMessage, author,
 *         buildCommand, deployCommand, rootDirectory, repoName,
 *         providerAccountName, providerType   // providerType 例 "github"
 *       }
 *     },
 *     metadata: { accountId, eventSubscriptionId, eventSchemaVersion, eventTimestamp }
 *   }
 *
 * ■ 秘密
 *   env.DISCORD_WEBHOOK_URL のみ（wrangler secret。実値はリポに置かない）。
 */

// ── ステータス種別の見た目（成否で色/絵文字を分ける。started/canceled は中立） ─────────────
// Discord の embed color は 10 進整数。0xRRGGBB のリテラルをそのまま整数として使う。
const SUCCESS_COLOR = 0x36a94f; // 緑
const FAILURE_COLOR = 0xd13438; // 赤
const NEUTRAL_COLOR = 0x9e9e9e; // 灰（開始・中止・未知）

/**
 * イベント種別を判定する（公式テンプレ getBuildStatus に準拠）。
 * event.type は "...build.succeeded" のような文字列。buildOutcome も補助的に見る。
 */
function classifyBuild(event) {
  const type = event.type || '';
  const outcome = event.payload?.buildOutcome;
  const isCancelled =
    outcome === 'canceled' ||
    outcome === 'cancelled' ||
    type.includes('canceled') ||
    type.includes('cancelled');
  const isFailed = type.includes('failed') && !isCancelled;
  const isSucceeded = type.includes('succeeded');
  const isStarted = type.includes('started');

  if (isSucceeded) return { emoji: '✅', color: SUCCESS_COLOR, label: 'ビルド成功', known: true };
  if (isFailed) return { emoji: '⚠️', color: FAILURE_COLOR, label: 'ビルド失敗', known: true };
  if (isCancelled) return { emoji: '⏹️', color: NEUTRAL_COLOR, label: 'ビルド中止', known: true };
  if (isStarted) return { emoji: '🔨', color: NEUTRAL_COLOR, label: 'ビルド開始', known: true };
  // 未知の種別は握りつぶさず中立で可視化する
  return { emoji: 'ℹ️', color: NEUTRAL_COLOR, label: `イベント: ${type || '(種別不明)'}`, known: false };
}

/**
 * ビルドのダッシュボード URL を組む（公式テンプレ getDashboardUrl に準拠）。
 * accountId と buildUuid が無ければ null（リンクを付けない）。
 */
function buildDashboardUrl(event) {
  const accountId = event.metadata?.accountId;
  const buildUuid = event.payload?.buildUuid;
  const workerName =
    event.source?.workerName ||
    event.payload?.buildTriggerMetadata?.repoName ||
    'worker';
  if (!accountId || !buildUuid) return null;
  return (
    `https://dash.cloudflare.com/${accountId}/workers/services/view/` +
    `${workerName}/production/builds/${buildUuid}`
  );
}

/**
 * author 文字列から表示名を取り出す（公式テンプレ extractAuthorName に準拠）。
 * メール形式なら @ の手前を使う。
 */
function extractAuthorName(author) {
  if (!author) return null;
  if (author.includes('@')) {
    const name = author.split('@')[0];
    return name || author;
  }
  return author;
}

/** イベント時刻を ISO8601 文字列で返す（Discord embed の timestamp 用）。妥当でなければ undefined。 */
function eventTimestampIso(event) {
  const iso =
    event.metadata?.eventTimestamp ||
    event.payload?.stoppedAt ||
    event.payload?.createdAt;
  if (!iso) return undefined;
  // ISO8601 として解釈できるものだけ通す（Discord がそのまま受け取る）。
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/** 長すぎる文字列を丸める。 */
function truncate(s, max) {
  if (!s) return s;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** JSON 化で例外を出さない安全版（ログ用）。 */
function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * build イベントを Discord ネイティブ（embeds）ペイロードへ整形する。
 * ペイロードに実在するフィールドのみを載せる（無い項目は出さない）。
 */
function buildDiscordPayload(event) {
  const cls = classifyBuild(event);
  const meta = event.payload?.buildTriggerMetadata || {};
  const workerName = event.source?.workerName || meta.repoName || 'worker';
  const dashboardUrl = buildDashboardUrl(event);

  // 実在するものだけ field 化（Discord embed の fields ＝ name/value/inline）
  const fields = [];
  if (meta.branch) fields.push({ name: 'ブランチ', value: meta.branch, inline: true });
  if (meta.commitHash) fields.push({ name: 'コミット', value: meta.commitHash.slice(0, 7), inline: true });
  const author = extractAuthorName(meta.author);
  if (author) fields.push({ name: '作者', value: author, inline: true });

  // 本文＝コミットメッセージ1行目（あれば）
  const commitLine = meta.commitMessage ? meta.commitMessage.split('\n')[0].trim() : '';

  const embed = {
    // title + url で「見出しのハイパーリンク」になる（Discord ネイティブ）
    title: truncate(`${cls.emoji} ${workerName}: ${cls.label}`, 256),
    color: cls.color,
    footer: { text: 'Cloudflare Workers Builds' },
  };
  if (dashboardUrl) embed.url = dashboardUrl; // ビルドURL（ダッシュボードのビルド詳細）
  if (commitLine) embed.description = truncate(commitLine, 300);
  if (fields.length) embed.fields = fields;
  const ts = eventTimestampIso(event);
  if (ts) embed.timestamp = ts; // ISO8601

  return { embeds: [embed] };
}

/** Discord Webhook（ネイティブ）へ POST。非 2xx は例外にして呼び出し側の再試行に委ねる。 */
async function sendToDiscord(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Discord webhook が失敗: ${res.status} ${res.statusText} ${body}`.trim(),
    );
  }
}

export default {
  /**
   * Queue コンシューマのエントリポイント。
   * バッチ内の各メッセージ（Workers Builds のイベント）を Discord へ転送する。
   *
   * エラー方針（README にも明記）:
   *   - 転送失敗（Discord の一過性エラー/レート制限/ネットワーク）→ message.retry() で再試行に委ねる。
   *   - 構造が壊れて解釈できないメッセージ（イベントでない）→ ログして message.ack()（毒メッセージ回避）。
   *   - 未知のイベント種別 → 握りつぶさずログし、中立通知を送ってから ack。
   *   - secret 未設定 → 構成ミスとして全件 retry（気づけるように・握りつぶさない）。
   */
  async queue(batch, env) {
    if (!env.DISCORD_WEBHOOK_URL) {
      console.error(
        'DISCORD_WEBHOOK_URL が未設定です。`wrangler secret put DISCORD_WEBHOOK_URL` を実行してください（README 参照）。',
      );
      for (const message of batch.messages) message.retry();
      return;
    }

    for (const message of batch.messages) {
      const event = message.body;

      // イベントとして解釈できないメッセージは再試行しても直らない → ログして ack
      if (!event || typeof event !== 'object' || !event.type) {
        console.warn('build イベントとして解釈できないメッセージを ack します:', safeStringify(event));
        message.ack();
        continue;
      }

      const cls = classifyBuild(event);
      if (!cls.known) {
        console.warn('未知の build イベント種別（中立通知として転送します）:', event.type);
      }

      try {
        await sendToDiscord(env.DISCORD_WEBHOOK_URL, buildDiscordPayload(event));
        message.ack();
      } catch (err) {
        // 転送失敗は一過性の可能性が高い → retry に委ねる（max_retries は wrangler.toml）
        console.error('Discord 転送に失敗、再試行します:', err && err.message ? err.message : err);
        message.retry();
      }
    }
  },
};
