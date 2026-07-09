#!/usr/bin/env bash
# weak モードでツイン側リソース置換 → 参照が追従するか検証
# バグ①(Writer の値スキップ)は weak では Writer を通らないので発火しないはず、の確認
set -euo pipefail
cd "$(dirname "$0")"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export ACCOUNT
export REF_MODE=weak
APP='node scenario-basic.js'
step() { echo; echo "########## $1 ##########"; }

consumer_value() {
  aws ssm get-parameter --name /mrs/consumer --region ap-northeast-1 --query Parameter.Value --output text 2>/dev/null || echo "(none)"
}
twin_topic() {
  aws sns list-topics --region us-east-1 --query "Topics[?contains(TopicArn,'mrs-global')].TopicArn" --output text 2>/dev/null || echo "(none)"
}

step "1. weak 初回デプロイ (topicName=mrs-global)"
TOPIC_NAME=mrs-global npx cdk deploy SampleStack --app "$APP" --require-approval never
echo "consumer = $(consumer_value)"
echo "twin     = $(twin_topic)"

step "2. ツイン側リソース置換 (topicName=mrs-global-v2) → 再デプロイ"
TOPIC_NAME=mrs-global-v2 npx cdk deploy SampleStack --app "$APP" --require-approval never
CONSUMER=$(consumer_value)
TWIN=$(twin_topic)
echo "consumer = $CONSUMER"
echo "twin     = $TWIN"
if [ "$CONSUMER" = "$TWIN" ] && [[ "$CONSUMER" == *mrs-global-v2 ]]; then
  echo "OK: weak モードでは置換が正しく追従した(バグ①は非発火)"
else
  echo "NG: weak モードでも追従しなかった(consumer=$CONSUMER twin=$TWIN)"
fi

step "3. 後片付け (destroy 'SampleStack*')"
TOPIC_NAME=mrs-global-v2 npx cdk destroy 'SampleStack*' --force --app "$APP"
for r in ap-northeast-1 us-east-1; do
  echo -n "$r SampleStack: "
  aws cloudformation describe-stacks --stack-name SampleStack --region "$r" --query 'Stacks[0].StackStatus' --output text 2>&1 | tail -1
done

echo; echo "########## weak-replace 検証完了 ##########"
