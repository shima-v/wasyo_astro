#!/usr/bin/env bash
#
# gas/deploy.sh — GAS(dev/prod) を clasp で手動デプロイした後の「通知専用」ヘルパー。
#
# このスクリプトは clasp push / clasp deploy 自体は行わない（版更新は開発者が手動でやる）。
# 版を更新したあとに、その成否とリリース内容を GAS の deployNotify 経由で
# Discord（失敗ならメール）へ流すためだけのもの。
#
# 用法:
#   gas/deploy.sh <dev|prod> <success|failure> ["店主向けの説明（任意）"]
#
# 例:
#   gas/deploy.sh dev  success "予約通知の文面を改善"
#   gas/deploy.sh prod failure "版更新でエラー"
#
# 必要な環境変数（秘密のためリポジトリには置かない・シェルの環境変数で与える）:
#   GAS_DEPLOY_ENDPOINT … 叩く GAS の /exec URL。
#                         env=dev なら dev GAS、prod なら prod GAS の /exec を指すこと
#                         （どちらを叩くかは呼び出し側がこの変数で切り替える）。
#   DEPLOY_NOTIFY_TOKEN … 各 GAS の Script Property DEPLOY_NOTIFY_TOKEN と一致する共有トークン。
#
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
用法: gas/deploy.sh <dev|prod> <success|failure> ["説明（任意）"]

必要な環境変数:
  GAS_DEPLOY_ENDPOINT  叩く GAS の /exec URL（dev を渡すなら dev GAS、prod なら prod GAS）
  DEPLOY_NOTIFY_TOKEN  GAS の Script Property DEPLOY_NOTIFY_TOKEN と一致する共有トークン
USAGE
  exit 1
}

ENV_ARG="${1:-}"
STATUS_ARG="${2:-}"
DESC="${3:-}"

case "${ENV_ARG}" in
  dev)  ENV_NAME="gas-dev" ;;
  prod) ENV_NAME="gas-prod" ;;
  *)    echo "エラー: 第1引数は dev または prod" >&2; usage ;;
esac

case "${STATUS_ARG}" in
  success|failure) : ;;
  *) echo "エラー: 第2引数は success または failure" >&2; usage ;;
esac

if [ -z "${GAS_DEPLOY_ENDPOINT:-}" ] || [ -z "${DEPLOY_NOTIFY_TOKEN:-}" ]; then
  echo "エラー: 環境変数 GAS_DEPLOY_ENDPOINT / DEPLOY_NOTIFY_TOKEN が未設定です" >&2
  usage
fi

command -v jq   >/dev/null 2>&1 || { echo "エラー: jq が必要です" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "エラー: curl が必要です" >&2; exit 1; }

# 直近コミットを commits に（"<短縮SHA> <件名>" の1件配列）
COMMIT_LINE=$(git log -1 --format='%h %s')
COMMITS=$(jq -nc --arg c "${COMMIT_LINE}" '[$c]')

# detail: ブランチ @短縮SHA ＋ 引数の説明（あれば）
BRANCH=$(git branch --show-current)
SHORT_SHA=$(git rev-parse --short HEAD)
DETAIL="branch: ${BRANCH} @${SHORT_SHA}"
if [ -n "${DESC}" ]; then
  DETAIL="${DETAIL}
${DESC}"
fi

# payload を jq でエスケープして組む
PAYLOAD=$(jq -nc \
  --arg deployToken "${DEPLOY_NOTIFY_TOKEN}" \
  --arg env "${ENV_NAME}" \
  --arg status "${STATUS_ARG}" \
  --argjson commits "${COMMITS}" \
  --arg detail "${DETAIL}" \
  '{action:"deployNotify", deployToken:$deployToken, env:$env, status:$status, commits:$commits, detail:$detail}')

# GAS の /exec は 302 で実体へリダイレクトするため -L で追従（-X POST は付けない）
curl -sS -L "${GAS_DEPLOY_ENDPOINT}" \
  -H "Content-Type: text/plain;charset=utf-8" \
  --data "${PAYLOAD}"
echo
