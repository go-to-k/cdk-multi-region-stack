# MultiRegionStack — 設計決定と検証記録

検証日: 2026-07-09 / 検証対象: aws-cdk-lib 2.261.0(実デプロイ)、2.254.0(単体テスト)

## 設計(確定)

- `MultiRegionStack extends Stack`。`regionScope(region)` が `Stage.of(this) ?? App` 配下に
  **同 stackName・別リージョン**のツイン Stack を遅延生成して返す
- リージョン指定は scope 渡しのみ(construct は構築後に re-parent 不可、
  `Resource` はコンストラクタで `Stack.of` / env を焼き込むため後付け移動は不可能)
- クロスリージョン参照はコアの `crossRegionReferences: true` に全委譲。
  strong / weak / both は `@aws-cdk/core:defaultCrossStackReferences`(2.254.0〜、消費側 context)に従う
- 循環(A(use1)→B(main)→C(use1))は synth エラー。並行デプロイ+世代付き待機リーダーによる
  解決(`resolutionMode: 'concurrent'`)は **v2 送りで確定**(明示 API なので後方互換で追加可能。
  実装規模は本体の5〜10倍: Provider framework の isComplete 待機リーダー+世代スタンプ+運用文書)
- ツインには常にプレースホルダ(`AWS::CloudFormation::WaitConditionHandle`)を入れ、
  「最後のリソースを消したら空テンプレートでデプロイ不能」と孤児化を緩和

## Phase 1: synth 検証 — すべて期待通り

| 項目 | 結果 |
| --- | --- |
| 同 stackName の2アーティファクト | synth OK。スタック依存も参照から自動生成 |
| strong 参照 | ツインに ExportWriter、メインに ExportReader(各 +Lambda/Role、片側3リソース)。Reader のプロパティは `{{resolve:ssm:...}}` 動的参照なので、パラメータ値が変われば消費側デプロイで検知される設計 |
| weak 参照 | 追加インフラゼロ。`Fn::GetStackOutput {StackName: 同名, Region: us-east-1}` — 同 stackName 設計と整合 |
| both 参照 | プロデューサ: Writer 維持+Output 追加、コンシューマ: GetStackOutput へ切替。移行手順どおり |
| 循環検出 | synth 時にネイティブでエラー(`would create a cyclic reference`、リソースパス付き) |
| 空ツイン | 0リソースのテンプレート → プレースホルダ必須の裏付け |

## Phase 2: 実デプロイ検証(2026-07-09、アカウントは検証後クリーン化済み)

| 項目 | 結果 |
| --- | --- |
| `cdk deploy SampleStack` 一発デプロイ | ✅ `Including dependency stacks:` でツインが自動包含、ツイン先行 |
| 値の一致 | ✅ consumer == twin の Topic ARN。`/cdk/exports/SampleStack/...` パラメータ生成 |
| 置換更新の追従 | ❌ **上流バグ発見**(下記) |
| 修正シミュレート | ✅ SSM 値を手動修正すると、動的参照経由で消費側が検知・追従(設計は健全、バグは Writer のみ) |
| strong 削除ガード | ❌ **消滅を確認**(下記)。ツイン単独 destroy が成功しパラメータも削除された |
| strong→both→weak 移行 | ✅ 3デプロイで完走。`Fn::GetStackOutput` は実環境で動作。weak 化後は CR が消え値も維持 |
| destroy | ⚠️ `cdk destroy SampleStack` はメインのみ(下記 CLI 選択)。`'SampleStack*'` で両方削除 ✅ |

### CLI のスタック選択の正確な挙動

- パターンは**アーティファクト id にのみ**マッチ(stackName にはマッチしない)
- `cdk ls` / `cdk deploy` は**上流依存を自動包含**するのでツインが入る(weak でもアーティファクト依存は維持される)
- `cdk destroy` は下流方向のためツインが入らない → **destroy は `'MyApp*'` 必須**(README に記載済み)

## 発見した上流(aws-cdk)の問題 — 要 issue 化

### 1. Writer が「同名キーの値変更」を黙って落とす(置換が伝播しない)

`cross-region-ssm-writer-handler` の Update は `except()`(キーのみの差分)で追加/削除だけを
処理し、**論理 ID 据え置きのリソース置換(名前同じ・値だけ変化)は put されない**。
消費側は削除済みリソースの ARN を参照し続ける。

- 2.254.0(#38059 以前): 値変更を検出して `Some exports have changed!` を throw
  (ImportValue 同等の「うるさいが安全」な strong セマンティクス)
- #38059 以後(2.261.0 で確認): validation 撤去に伴い throw も消え、**静かな不整合**に退行
- 修正案: Update で全 exports を `putParameter`(既に `Overwrite: true`)。
  Reader 側は動的参照で変更を拾える設計なので、これだけで置換が正しく伝播する(実機で検証済み)

### 2. strong の削除保護が機能していない(ドキュメントと矛盾)

`@aws-cdk/core:defaultCrossStackReferences` のフラグ文書は「strong は消費側が存在する限り
生産側スタックを削除できない」と述べるが、#38059 が in-use validation を丸ごと撤去したため、
**消費側が生きたままの生産側 destroy が成功し、export パラメータも削除される**(実機で確認)。
以後の消費側デプロイは `{{resolve:ssm}}` の解決に失敗するはず。

### 3. weak モードの置換非伝播(バグではなく機構固有の限界)— 2026-07-09 追検証

当初「置換があるなら weak にすれば追従する」と推測したが、**実機で否定された**。
weak モードでツイン側 Topic を置換(topicName 変更、論理 ID 据え置き)して再デプロイした結果:

- ツインの `Output PublishOutputRefGlobalTopic...` は**新 ARN(mrs-global-v2)に正しく更新**された
- しかし消費側は **`SampleStack (no changes)`(デプロイ 0 秒の完全 no-op)** となり、旧 ARN のまま
- 原因: 消費側テンプレートは `Fn::GetStackOutput{StackName, Region, OutputName}` を**リテラル埋め込み**
  しており、OutputName は論理 ID 由来で置換前後不変 → テンプレートがバイト一致 → CFn が changeset を
  作らず、GetStackOutput が再解決されない

**strong と weak の非対称性**が判明した:
- strong: 消費側の Reader プロパティが `{{resolve:ssm}}` 動的参照。SSM 値が変われば changeset に差分が出て
  Reader が再実行される。**だから Writer さえ直せば伝播する**(バグ①の修正で解決可能)
- weak: `Fn::GetStackOutput` は動的参照のような「値が変われば changeset に差分」の性質を持たず、
  同論理 ID 置換では消費側が no-op になる。**単純な修正では直らない機構固有の限界**

結論: 置換伝播について現行リリースは strong / weak とも壊れているが、**strong は上流修正で直る一方、
weak は直らない**。当初の「置換なら weak 推奨」は誤り。回避策は論理 ID 変更(構築子リネーム)/
消費側強制変更 / 2回デプロイ。README に反映済み。

## PoC の所在

Phase 1/2 で使った検証スクリプト(scenario-basic/cycle/empty.js, phase2.sh)は
`~/github/cdk-multi-region-stack.bak-poc/poc/` に退避してある(将来の integ テストの種)。

## 補足(2026-07-09 更新)

- env 要件は「region のみ必須」に緩和(account は agnostic 可 — 本家
  integ.cross-region-references.ts と同じ形。integ スナップショットにアカウント ID が入らない)
- integ テスト実装・実デプロイで 1/1 パス(`pnpm integ:update`、約200秒、テスト後自動削除)
- weak モード置換検証(weak-replace.sh)を追実施 → 上流問題 #3(機構固有の限界)を発見。
  検証後アカウントは完全クリーン化済み

## 残課題

- Aspects / Tags のツイン伝播(現状: description / terminationProtection / tags の props のみ継承。
  `Tags.of(stack)` はツインに届かない — README 化 or 実装)
- 循環エラーの catch & 再ラップは不可能(app.synth() 内で発生)→ README で案内済み
- 上流 issue 2 件の起票(ドラフト作成済み、投稿は要承認)+ Writer は 1 行修正の PR も可能
- v2: `resolutionMode: 'concurrent'`
