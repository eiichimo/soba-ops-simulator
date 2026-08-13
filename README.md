# SobaOps

SobaOps は、蕎麦店の販売数、メニュー構成、原材料、仕込み、人件費、水道光熱、揚げ油、廃棄、営業時間、営業日数、在庫と購入支出をまとめて試算するブラウザ完結型のコスト・オペレーションシミュレーターです。Phase 7では、Phase 6までの経済・在庫・厨房能力・確率需要モデルを再利用し、制約付き離散全探索、候補ランキング、Pareto分析、境界解検出を追加しました。

単なる「1食原価」ではなく、固定費が販売量によってどう薄まるか、内製と既製品のどちらが有利か、営業時間や営業日数の変更が利益へどう影響するかを同じモデルから確認できます。初回起動時から、7種類の蕎麦メニューと原材料・仕込み工程を含むサンプル店舗が表示されます。

## 起動方法

Node.js 20.19 以上を用意してください。

```bash
npm install
npm run dev
```

表示されたローカルURLをブラウザで開きます。本番向けビルドとテストは次のコマンドで実行できます。

```bash
npm run build
npm test
npm run lint
```

バックエンド、ユーザー登録、外部APIは使用しません。設定はブラウザの `localStorage` に変更のたびに自動保存されます。

## GitHub Pagesへの公開

このリポジトリはGitHub Pagesへの自動デプロイに対応しています。公開URLは次のとおりです。

```text
https://eiichimo.github.io/soba-ops-simulator/
```

初回のみ、GitHub上で次の設定を行います。

1. リポジトリの **Settings → Pages** を開く
2. **Build and deployment → Source** で **GitHub Actions** を選択する
3. `main` ブランチへpushするか、Actionsの `Deploy SobaOps to GitHub Pages` から手動実行する

Workflowは `npm ci`、Lint、テスト、本番ビルドを順番に実行し、すべて成功した場合だけ `dist` を公開します。設定は [.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml) にあります。

Viteの `base` はリポジトリPages用の `/soba-ops-simulator/` です。将来カスタムドメインまたは `eiichimo.github.io` 直下へ移す場合は、[vite.config.ts](vite.config.ts) の `base` を `/` に変更してください。

## 現在できること

- 1日の販売食数、シミュレーション開始日、月〜日の営業・休業と曜日別営業時間の変更
- メニュー・追加トッピングの価格、販売構成比、消費材料の編集と追加
- 原材料・既製品の仕入価格、仕入量、単位、歩留まり、保存区分、最低仕入ロットの編集
- 複数Input、複数Output、中間生成物、副産物、混合比率を持つ仕込み工程の編集
- 工程所要時間と実作業時間を分け、勤務時間内 / 追加勤務を区別した仕込み人件費計算
- スタッフ役割ごとの時給、人数、勤務時間、限界人件費率の編集
- シフト人件費、仕込み作業配賦額、追加仕込み人件費、会計上総人件費の分離表示
- 水道・ガス・電気を営業日固定、営業時間比例、食数比例、常時、使用回数比例に分けた計算
- 初期投入、日次補充、吸油、交換周期を分けた揚げ油計算
- 曜日別営業カレンダーを使った1日、30日、3か月、6か月、1年の期間集計
- 売上、各費用、粗利益、営業利益、原価率、利益率、平均原価、限界原価の表示
- 10〜200食における営業利益・1食平均原価グラフ
- 内製・混合・既製品の会計上 / 意思決定上の単位原価、月間費用、内製ROI、概算損益分岐食数の比較
- 任意期間のActual登録と、未入力を0扱いしない予測 / 実績Variance
- Resource別の予測使用、実績使用、予測 / 実績購入、購入単価、廃棄差の確認
- 実績水道・ガス・電気料金と使用量からの平均請求単価算出
- 9種類の対象を-20%〜+20%で比較するSensitivity Analysisと利益グラフ
- 既存Simulation Engineの逐次実行による販売食数の損益分岐探索
- Baseを変更しないOverride形式のScenarioを最大5件保存・比較
- 1分を基本単位とする決定論的な1日厨房シミュレーション
- Equipment容量・同時Job、営業中KitchenOperation、Menu別DAG Workflowの編集
- 時間帯別DemandProfile、FIFO注文Queue、工程バッチ、独立工程の並列処理
- StaffShiftとactive Labor占有、Equipment占有を分けたスケジューリング
- 平均・中央値・最大・90パーセンタイル待ち時間、許容時間以内提供率、最大Queue
- 30分単位の到着・完了・待機、設備・Role利用率とボトルネック候補
- `completeAfterClosing / dropAtClosing` と、需要売上・能力制約後売上／利益の分離
- ScenarioによるShift人数・Equipment容量・KitchenOperation時間の非破壊比較
- deterministic（時間帯内均等配置）とstochastic（seed付き来店）の切替
- uniform / Poisson arrival、Party人数分布、カウンター・テーブル構成の編集
- 最小収容席を優先する着席、収容可能な最古Partyを選ぶQueue、閾値型の席待ち離脱
- 注文遅延、全品提供後の滞在、席解放、回転数、Seat utilization、unusedSeatMinutes
- 来店・着席・注文・厨房完了・売上を分けたCustomer JourneyとRealized Sales
- 明示実行型Monte Carlo（10〜1,000 run）、利益分布、p10 / p90、赤字率、目標利益達成率
- 同じseed集合を使うMonte Carlo Scenario比較と代表run Inspector
- StaffShift人数、Equipment容量、SeatingUnit卓数、営業時間、KitchenOperation時間を候補集合から探索するOptimization Study
- 平均利益、p10利益、待ち時間、人件費、Realized Salesを目的に選べるdeterministic / Monte Carlo全探索
- 人件費、利益、待ち時間、離脱率、Service Level、Staff・総席数などのConstraintとFeasible判定
- Constraintを満たす上位候補、0件時の最小違反候補、Base差、探索境界、簡易設備投資回収日数の表示
- 平均営業利益とp90厨房待ちのPareto Frontier、および候補の非破壊Scenario保存
- g / kg、ml / Lの自動換算と、不正な単位・参照・工程循環などのValidation
- メニュー、Resource、Process、水道光熱、揚げ油まで追跡できる折りたたみ式の計算詳細
- Inventory Lotを営業日・休業日を通して持ち越す日次状態遷移
- FIFO消費、保存期限切れの自動spoilage、Process Output・副産物の在庫化
- 不足時の購入package・最低購入数による自動仕入と仕入履歴
- 期首・期末在庫価額、使用原価、購入支出、簡易現金収支の分離表示
- Resource / Output別の日次在庫推移
- schemaVersion 付きJSONのExport / Import、サンプル状態へのリセット
- PC優先のレスポンシブUI（タブレット・スマートフォン対応）

## データモデル

中心モデルは `Ingredient → MenuItem` ではなく、次の流れです。

```text
Resource → Process → Output → Inventory → Consumption
               └──── 複数Output（副産物）
```

- `Resource`: 原材料、既製品、油などの購入対象。既存の `purchaseQuantity / purchaseUnit / purchasePrice` を購入packageとして使い、歩留まり、保存期限、最低購入package数を持ちます。
- `Process`: Resourceまたは別工程のOutputを複数受け取り、加工・混合します。バッチ、実作業時間、水道光熱、廃棄率を持ちます。
- `Output`: 1工程から複数生成できます。主生成物と副産物に原価配賦率を設定でき、別工程やメニューから同じ方法で参照できます。
- `InventoryLot`: ResourceまたはOutput、数量・単位、取得日、期限、取得時単価、原価構成、取得元を保持します。取得元は購入、期首在庫、内製Output、副産物、持越しを区別できます。
- `InventorySettings`: シミュレーション開始時の期首Lotを保持します。旧 `InventoryEntry` はJSON後方互換のため残していますが、新規計算はLotを使用します。
- `Consumption`: メニュー、トッピング、次工程から、ResourceまたはOutputを数量付きで参照します。
- `ActualPeriod`: 開始日・終了日と、任意入力の売上、食数、仕入、在庫、人件費、水道光熱、廃棄、Resource別実績を保持します。Simulation設定とは独立しており、自動補正には使用しません。
- `Scenario`: Base Settingsに対する食数、営業時間、営業日数、販売価格、時給、Resource価格、水道光熱単価の差分Overrideを保持します。
- `Equipment`: そば釜、フライヤー、洗浄槽、盛付台など、営業中の処理能力を制約する設備です。1Jobの処理容量と同時Job数を分けます。
- `KitchenOperation`: 営業中の1注文を処理する工程です。総所要時間、active人員時間、設備占有時間、必要Role、バッチ容量を持ちます。仕込み・Inventory Outputを作る既存`Process`とは別モデルです。
- `KitchenWorkflow`: MenuItemに紐づくOperation NodeのDAGです。複数依存を持てるため、蕎麦茹でと天ぷらを並行し、両方の完了後に盛付できます。
- `StaffShift`: LaborRole、開始・終了時刻、人数を持ちます。active作業中の1人を別工程へ同時割当しません。
- `DemandProfile`: 時間帯ごとの決定論的な注文食数です。Menu Mixは既存の販売構成比を利用します。
- `ArrivalProfile`: stochastic modeの時間帯別平均来店人数とuniform / Poisson分布です。人数はParty数ではなくGuest数の期待値です。
- `Party`: 来店時刻、人数、着席・注文・提供・退店または離脱を追跡するCustomer Journey単位です。Partyは複数席へ分割しません。
- `SeatingUnit`: カウンターまたはテーブルの1単位あたり収容人数、単位数、有効状態を持ちます。
- `StochasticDemandSettings`: seed、Party人数確率、客席、注文遅延、滞在時間、最大席待ち、Monte Carlo条件をまとめます。
- `OptimizationStudy`: Objective、評価方式、離散Variable、Constraint、共通seed・run数、候補上限と保存済み集計をまとめます。
- `OptimizationVariable`: StaffShift、Equipment、SeatingUnit、開閉店時刻、KitchenOperationの対象と候補値を保持します。UIのmin / max / stepも実行前に離散候補へ展開します。
- `OptimizationConstraint`: 評価指標、`<= / >=`、基準値を持ちます。各候補は`feasible`と具体的な違反量を保持します。

たとえば店舗用かえしは「内製かえし 2 L + 既製かえし 1 L → 店舗用かえし 3 L」という通常のProcessです。画面上でInput数量を変えれば、特殊なかえし専用ロジックを使わず混合比率が変わります。

主な型は [src/models/types.ts](src/models/types.ts)、初期サンプルは [src/data/sampleData.ts](src/data/sampleData.ts) にあります。

## 計算方式

計算ロジックはReact Componentから分離し、[src/calculations/engine.ts](src/calculations/engine.ts) に集約しています。UIは設定の編集と結果表示のみを担当します。

### 原材料と歩留まり

```text
利用可能量 = 仕入量 × 歩留まり率
実質単価   = 仕入価格 ÷ 利用可能量
使用原価   = 実質単価 × 使用量
```

計算途中では丸めず、画面表示時に円単位へ丸めます。Resourceの仕入単位とConsumptionの単位が異なっても、同一物理量である `g ↔ kg` と `ml ↔ L` は基準単位へ換算してから原価を計算します。`個 / 枚 / 本 / 食` は意味が品目ごとに異なるため推測換算しません。不整合な組み合わせはValidation Errorとして表示し、その参照は計算へ含めません。

### 使用原価、購入支出、在庫価額

Phase 3では次を別の指標として扱います。

- 使用原価: 期間中にメニュー販売へFIFO払い出ししたResource / Output Lotの取得原価。営業利益の費用計算に使います。工程間の払い出しは新しいOutput在庫へ振り替えるため、全体使用原価へ二重加算しません。
- 購入支出: 在庫不足時に購入したpackageの支払額。購入日に簡易現金収支へ全額反映します。
- 期末在庫価額: 期間終了時に残った各Lotの数量 × 取得時単価です。購入価格が変わっても古いLotの取得原価は変えません。

```text
購入package使用単価 = package価格 ÷ (package量 × 歩留まり)
数量整合             = 期首 + 購入 + 生産 - 使用 - 廃棄 = 期末
```

最低購入package数は既存の `minimumPurchaseLot` を「1回の発注で最低何package購入するか」として利用します。自動発注は当日の需要を満たせないときだけ行い、発注点・リードタイム・配送曜日は扱いません。

### FIFOと賞味期限

在庫消費は取得日、次にLot IDの順で古いLotから行います。日次処理は「期限切れ確認 → 必要な購入・仕込み → Process実行 → 販売需要への払出し → 期末在庫確定」の順です。休業日は販売・仕込み・営業変動費が0でも日付は進み、期限切れ確認を行います。

`shelfLifeDays = 3` は、8月1日に購入・生産したLotを8月3日の営業終了まで使用可能、8月4日の開始時に期限切れと定義します。内部の `expiryDate` は使用不可になる最初の日を表す排他的期限です。期限切れLotは `spoilage` として数量・取得原価・日付を廃棄履歴へ記録します。

期首在庫は数量・取得日・任意の期限を設定できます。期限を省略した場合は取得日と対象Resource / Outputの保存日数から算出します。Resource期首在庫の単価を省略した場合はシミュレーション時点のpackage使用単価を使います。

### 工程・バッチ・副産物

画面上のメニューとトッピングの需要をSourceごとにまとめ、工程Outputの必要量からバッチを切り上げます。

```text
必要バッチ数 = ceil(必要量 ÷ 1バッチのOutput量)
仕込み配賦額 = 実作業時間 × 担当役割の時給
```

`processDurationMinutes` は加熱・冷却などの待ち時間を含む工程時間、`activeLaborMinutes` は人が実際に作業する時間です。人件費へ加算するのは後者だけです。

複数Outputでは `costAllocation` で原価を配賦します。サンプルの海老天工程は海老天と揚げ玉を同時に生成し、揚げ玉も他のConsumptionから参照できます。配賦率0の副産物は、主生成物が全費用を負担する扱いです。

期間計算ではOutput在庫の不足量に対して `ceil(不足量 ÷ Output量/バッチ)` で生産します。全Outputを同じ生産日にInventoryへ入れ、当日未使用分と副産物は保存期限内なら翌日以降へ持ち越します。Output Lotの会計用取得原価は、投入材料、追加勤務人件費、水道・ガス・電気を `costAllocation` で配賦した値です。勤務時間内の作業配賦額はPhase 2どおり会計原価へ再加算しません。意思決定比較では限界人件費を用いた別原価を計算します。

追加勤務人件費と工程水道光熱は生産日に現金支出として記録し、営業利益ではOutputが販売使用または廃棄された時点でLot原価から認識します。したがって、人件費画面の「会計上総人件費」は期間中の実支払見込、損益明細の「追加仕込み人件費」は販売・廃棄済みOutputへ配賦された額です。差額は期末内製品在庫価額に含まれます。これはPhase 3で明示的に採用した在庫原価の定義です。

工程の廃棄率は入力材料費の一部を「仕込み材料費」から「廃棄費」へ振り替え、総費用を二重計上しないようにしています。廃棄理由は `trimLoss / cookingLoss / spoilage / unsold / mistake` として保持します。

### 人件費

Processは `laborCostTreatment` を持ちます。

- `withinScheduledShift`（勤務時間内）: 実作業分を仕込み作業配賦額として表示しますが、シフト給与と重なるため店舗の総コストには再加算しません。
- `additionalLabor`（追加勤務）: 実作業分を追加仕込み人件費として総コストへ加算します。

```text
シフト人件費       = Σ(時給 × 人数 × 役割の標準勤務時間)
仕込み作業配賦額   = 工程実作業時間 × 担当役割の時給 × バッチ数
追加仕込み人件費   = additionalLabor工程の仕込み作業配賦額
会計上総人件費     = シフト人件費 + 追加仕込み人件費
限界人件費         = 仕込み作業配賦額 × 担当役割のmarginalCostRate
```

曜日ごとの実営業時間が標準営業時間と異なる場合、役割の `hoursPerDay` を `期間総営業時間 ÷ business.hoursPerDay` で比例調整します。内製 vs 既製品では「会計上比較」と「意思決定比較」を切り替えられます。後者は、その工程を止めたとき実際に増減すると見込む限界人件費を使います。

### 水道・ガス・電気

用途ごとに次のCost Behaviorを適用し、従量単価を掛けます。

- `perDay`: 1営業日固定
- `perHour`: 1日営業時間に比例
- `perMeal`: 販売食数に比例
- `perUse`: 1食あたり使用回数に比例
- `alwaysOn`: 24時間分

水道・ガス・電気それぞれに `fixedChargePerMonth + usageCharge` を持ちます。月基本料金は営業日の有無とは独立して、期間中の暦月相当分を配賦します。`alwaysOn` も休業日を含む暦日数で集計します。

### 揚げ油

フライヤー容量を毎日の費用にはしません。

```text
平均日次消費量 = 初期投入量 ÷ 交換周期
               + 日次補充量
               + 1食吸油量 × 販売食数
日次油費       = 平均日次消費量 × 油単価
```

交換時廃棄量も別フィールドに保持しています。在庫連携なしの従来計算では交換時に初期投入量を再投入する前提です。

Phase 3の新規サンプルは揚げ油設定を18L / 6,840円のResourceへ接続しています。平均日次消費量をそのResourceの需要としてFIFO払い出しし、不足時は18L packageを購入します。v2から移行した設定は互換性のため在庫連携なしの従来日次費用を維持し、光熱費・設備画面から油Resourceを選ぶと在庫方式へ切り替わります。

### 期間集計

- 1日: `simulationStartDate` の1暦日
- 30日: 開始日から30暦日
- 3か月 / 6か月 / 1年: 開始日からそれぞれ3 / 6 / 12 calendar months

期間内の日付を1日ずつ進め、対応する曜日が営業の場合だけ `mealsPerDay`、営業日固定費、日次仕込みを計上します。期間総営業時間は各営業日の `closingTime - openingTime` の合計で、営業時間比例費用、人件費、1営業時間あたり利益へ反映します。開始日が休業日の1日表示は営業日数・販売数・営業由来変動費が0です。休業日にも発生する `alwaysOn` と月固定費は暦日相当分が残ります。

月末日からcalendar monthsを加算して存在しない日付になる場合は対象月の末日に丸めます。3 / 6 / 12か月の月固定費はそれぞれ正確に3 / 6 / 12か月分、1日と30日は含まれる各月の日数で日割りします。

### 利益指標

- 食材原価: 直接原材料 + 仕込み材料 + 揚げ油 + 廃棄
- 粗利益: 売上 − 食材原価
- 営業利益: 売上 − 全コスト
- 限界原価: 現在の食数と「1食追加」の日次総コスト差。バッチ境界では仕込み1バッチ分が反映されます。
- 内製ROI: `月間削減額 ÷ 月間追加作業時間`（円 / 作業時間）
- 内製損益分岐: 現在の1食あたり使用量を使い、日次バッチを切り上げながら1〜500食を探索します。
- 簡易現金収支: `売上 − 購入支出 − 実際の人件費支出 − 水道光熱支出 − 油・その他・固定支出`。売上は当日入金と仮定し、売掛・買掛・税・カード入金サイトを扱わないため正式なキャッシュフローではありません。

営業利益は販売へ払い出した在庫の使用原価、簡易現金収支は購入日のpackage支出を使います。購入品が期末在庫として残る場合、この二つは一致しません。

### ActualとVariance

Actualは「設定から計算した予測」とは別の観測データです。実績期間の開始日から終了日までを既存Simulation Engineで再計算し、入力済み項目だけについて次を算出します。

Phase 4ではPhase 3の営業利益、使用原価、購入支出、在庫価額の定義を変更していません。ActualとVarianceはそれらの予測指標へ独立した実績値を並べる比較レイヤーです。

```text
差額 = 実績 - 予測
差率 = (実績 - 予測) ÷ 予測
```

予測0の場合の差率は算出不可、Actual未入力は未入力のままとし、0円として補完しません。売上・営業利益のプラス差は好転、費用・廃棄のプラス差は悪化として方向を判定します。差率が20%以上の主要項目には、単価、営業時間、使用量、購入packageなどの「確認候補」をルールベースで表示します。これは原因の断定やAI推奨ではありません。

Actual使用原価を直接入力しない場合、期首在庫価額、購入支出、期末在庫価額、廃棄原価がすべて入力されているときだけ、`期首 + 購入 - 期末 - 廃棄` から販売使用原価を算出します。実績営業利益と簡易現金収支も、必要項目がすべて揃った場合だけ算出します。Resourceの購入量は実使用量へ転用しません。

水道・ガス・電気は `実績料金 ÷ 実績使用量` で平均請求単価を表示します。Simulation設定の単価と並べますが、Actual入力による自動上書きは行いません。

### Sensitivityと損益分岐

Sensitivityは1日販売食数、平均販売価格、時給、選択Resource購入価格、水道・ガス・電気単価、営業時間、週営業日数を対象に、`-20% / -10% / 基準 / +10% / +20%` の設定コピーを作り、既存Simulation Engineへ渡します。売上、使用原価、人件費、営業利益、利益率、簡易現金収支と営業利益グラフを表示します。独自の近似式は使用しません。

販売食数の損益分岐は0〜500食/日を小さい順に再シミュレーションし、営業利益が初めて0以上になる食数を返します。FIFO、保存期限、バッチ、購入packageによる階段状・非単調な費用を線形化しないため、二分探索ではなく逐次探索を採用しています。

### Scenario

ScenarioはBase Settings全体のコピーではなく、変更した条件だけをOverrideとして保存します。比較時に新しい設定オブジェクトへ差分を適用し、Base、Actual、他のScenarioを変更しません。最大5件について売上、使用原価、購入支出、人件費、廃棄、営業利益、利益率、簡易現金収支、1食平均原価、1営業時間あたり利益とBase差を比較できます。ScenarioとActualはlocalStorageおよびJSON Export / Importへ含まれます。

### 厨房能力・Queue

Capacity Engineは既存のEconomic / Inventory / Decision Support Engineへ巨大な時間軸ロジックを混在させず、[src/calculations/capacityEngine.ts](src/calculations/capacityEngine.ts) に分離しています。Phase 5のdeterministic modeは同じ設定から同じ結果を返し、乱数を使いません。シミュレーション開始日が休業日なら次の営業日を選び、その曜日の開閉店時刻を1日のCapacity境界に使います。

時間帯内の注文は均等間隔で到着し、Menu Mixは最大剰余法で合計食数を一致させて決定論的に配分します。各注文はWorkflowの依存が完了するとOperationのFIFO待ち行列へ入り、設備・人員が空けば容量内で即座にバッチを開始します。異なる設備を使う独立Nodeは並行できます。

```text
KitchenOperation総時間      = 注文Nodeの完了までの時間
activeLaborMinutes          = Staffを占有する時間
equipmentOccupationMinutes  = Equipmentを占有する時間
待ち時間                    = 最終提供時刻 - 注文到着時刻
設備利用率                  = 設備実稼働時間 / (営業時間 × 同時Job数)
人員利用率                  = active割当時間 / Shift総時間
```

待ち時間は平均、中央値、最大、nearest-rank方式の90パーセンタイルを表示します。Queue Lengthは「開始可能な工程を待っている注文数」で、実行中だけの注文は含めません。Peak Windowは初期30分単位です。利用率95%以上や許容待ち時間超過率20%以上は原因の断定ではなくボトルネック候補として表示します。1時間最大処理食数は開店時刻を基準にした固定60分Bucketの最大値です。

`completeAfterClosing` は閉店前に受けた注文を閉店後も提供し、閉店まで勤務するShiftが処理を継続できる仮定です。`dropAtClosing` は閉店時に未完了の注文を失注扱いにします。閉店時刻と最終提供時刻は別表示します。残業割増や閉店後の追加固定費はまだ計算しません。

### Stochastic Demand・Party・客席

[src/calculations/demandEngine.ts](src/calculations/demandEngine.ts) は`Math.random`を使わず、32bit seedから再現可能な擬似乱数列を生成します。同じ設定とseedならParty、来店時刻、注文遅延、滞在時間、Menu選択まで同じ結果です。Single Runはseedを手入力・再実行・自動生成できます。

- `uniform`: 平均来店人数とParty人数分布から時間帯のParty数を決め、来店時刻を時間帯内の一様乱数で配置します。Party構成により実来店人数はrunごとに変わります。
- `poisson`: 平均来店人数を平均Party数へ換算し、指数分布のinter-arrival timeで生成します。入力人数を必ず生成するモードではなく、平均40人でもrunごとに35人、43人など変動します。

[src/calculations/seatingEngine.ts](src/calculations/seatingEngine.ts) はPartyを分割せず、収容できる空席のうち最小容量のSeatingUnitを選びます。満席時は待ち列全体から「収容可能な最古Party」を選ぶため、先頭の大Partyで空いているカウンターまでブロックしません。待ち時間が`maxSeatingWaitMinutes`以上になると閾値型で離脱し、厨房注文を生成しません。テーブル結合、相席、確率離脱は未実装です。

```text
arrivalTime → seatedTime → orderTime → servedTime → departureTime
席待ち         注文遅延       厨房待ち       食事・滞在
```

Party人数分のOrderを既存Capacity Engineへ流し、全Order完了時をPartyの`servedTime`とします。`departureTime = servedTime + dwellTime`の近似で席を解放します。Seat turnoverは着席Guest数 / 総席数、Seat utilizationはGuestが実際に占有したseat-minutes / 営業時間内の総seat-minutesです。大テーブルの空き容量は`unusedSeatMinutes = (席容量 - Party人数) × 占有時間`として別集計し、テーブル構成の損失を確認できます。

客席待ちと厨房待ちは別集計し、片方または両方が長い場合を客席・厨房・複合ボトルネック「候補」として表示します。

### Monte Carlo・利益リスク

[src/calculations/monteCarloEngine.ts](src/calculations/monteCarloEngine.ts) は`baseSeed + runIndex`のseed集合でSingle Runを10〜1,000回実行します。入力変更ごとの自動実行はせず、実行ボタンで開始します。ブラウザへ制御を返せるよう5 runごとに処理を分割し、結果には各runの要約だけを保持します。

来店人数、離脱、Realized Sales、売上、営業利益、着席・厨房・総待ち、最大Queue、最終提供、Seat utilizationについてmean、median、p5、p10、p90、p95、min、maxを計算します。percentileはソート済みrun間の線形補間です。営業利益について赤字run率と目標利益以上のrun率、許容厨房待ち以内提供率が目標を満たしたrun率も表示します。利益p10・中央値・p90付近のseedを選び、Party一覧まで再現できます。

Scenario比較はBaseと各Scenarioの同じrun indexへ同じseedを渡します。需要乱数を揃えたうえで、平均利益、p10利益、離脱率、総待ちの差を比較します。平均改善と下振れ改善を別々に判断でき、Scenario OverrideはBaseを変更しません。

### 制約付きOptimization・Pareto

[src/calculations/optimizationEngine.ts](src/calculations/optimizationEngine.ts) は新しい利益・Queue計算式を持たず、候補Overrideを既存Scenario適用機構へ渡し、Economic / Capacity / Demand / Seating / Monte Carlo Engineで評価します。評価期間はCapacity画面と同じ1営業日で、利益・人件費・Realized Salesは日次指標です。探索は非線形なFIFO、バッチ、購入package、Queue、離脱を線形化せず、離散候補のCartesian productを全列挙するExhaustive Searchです。

```text
Variable候補集合
→ Cartesian product
→ 既存Engine評価
→ Constraint判定
→ Feasible優先Ranking
→ Pareto Frontier
```

Objectiveの意味は次のとおりです。

- `maximizeMeanOperatingProfit`: deterministicでは単一runのRealized営業利益、Monte Carloではrun平均を最大化します。
- `maximizeP10OperatingProfit`: Monte Carloの下側10パーセンタイル利益を最大化します。deterministicでは選択できません。
- `minimizeAverageWait`: 平均厨房待ち時間を最小化します。
- `minimizeLaborCost`: Capacity StaffShiftの`時給 × Shift時間 × headcount`を最小化します。
- `maximizeRealizedSales`: 客席離脱とKitchen Workflow完了を反映した提供食数を最大化します。

Constraintは最大人件費、最小平均 / p10利益、最大平均 / p90厨房待ち、最大離脱率、最小Realized Sales / Service Level、最大Staff人数・総座席数・閉店後処理時間を扱います。`feasible`は全Constraintを満たす候補です。Feasible候補が0件なら、各違反量を`違反量 / max(1, |基準値|)`で正規化して合計し、最も条件へ近い候補を表示します。Constraint境界から5%以内は「ぎりぎり」の確認候補として表示します。

Monte Carlo評価は全候補へ`baseSeed + runIndex`の同じseed集合を適用するCommon Random Numbers方式です。候補間の差を別々の需要乱数で汚さず、平均利益とp10利益を同じ来店サンプルで比較します。Optimization画面は入力変更で自動実行せず、明示的な実行ボタン、候補進捗、キャンセルを持ちます。初期上限は10,000候補、hard limitは50,000候補で、上限超過時に勝手な間引きはしません。

Pareto判定は、候補Aが候補Bに対して`平均営業利益 >= B`かつ`p90厨房待ち <= B`で、少なくとも片方が厳密に優れる場合にAがBをdominateすると定義します。dominateされない候補をPareto Frontierへ残すため、利益最大だけでなく、利益を少し譲って待ち時間を短くする候補も比較できます。最上位候補がVariable候補の最小値・最大値にある場合は境界解として明示し、探索範囲外で改善する可能性を隠しません。

Staff人数候補はCapacity処理能力とStaffShift人件費の両方、Equipment容量は処理能力、SeatingUnit卓数は着席・離脱・総席数へ反映します。開閉店候補は曜日別営業時間へ適用し、営業時間外になったStaffShift部分を切り詰めます。延長時にShiftを自動延長はしません。短縮区間の需要は失われます。延長区間を覆うDemand / Arrival Profileがない候補は警告を付けるため、明示的な需要0を含むProfileを設定するまで結果を需要0の断定として解釈しないでください。

Equipmentの`upgradeCostPerCapacityUnit`またはVariable別Adjustment CostからBase超過分の初期投資額を計算します。正式な減価償却ではなく、`初期投資額 / 1営業日あたり追加平均営業利益`を簡易回収営業日数として別表示します。追加利益が0以下なら「回収不可」です。投資額は営業利益へ混ぜません。

Optimization結果はBaseを自動変更しません。「Scenarioとして保存」で既存Scenario Overrideへ明示的に保存した場合だけ通常のScenario比較へ渡します。localStorage / JSONにはStudy設定と上位20件・Pareto50件の集計だけを保存し、全Monte Carlo runの巨大な明細は保存しません。表示する候補は入力モデルと探索範囲内の「有力候補」であり、現実の唯一の最適解ではありません。

### 需要売上と能力制約後利益

- 需要食数: DemandProfileに入力された注文数です。
- 提供可能食数: fulfillmentPolicyに従って完了した注文数です。
- 需要ベース売上: 需要食数を既存Economic Engineへ渡した売上です。
- 能力制約後売上: 提供可能食数を既存Economic Engineへ渡した売上です。
- 能力制約後営業利益: 提供可能食数による日次Simulation結果を、Capacity StaffShift人件費との差で補正した近似値です。

能力制約後の原価・在庫は、完了したMenuの時刻別実消費をInventory Engineへ逐次同期するのではなく、完了食数を既存Menu Mixの日次需要として再計算します。この日単位近似によりPhase 1〜4と同じ計算定義を再利用します。ScenarioはShift人数、Equipment容量、KitchenOperation時間もOverrideでき、追加人件費、追加提供可能食数、追加売上、営業利益差を同じCapacity Engineで比較します。

Phase 6では次の指標をさらに分離します。

- 潜在需要: ArrivalProfileへ入力した平均来店人数。Poisson runの実人数ではありません。
- 実来店人数: seed付きで生成された全Party人数。
- 着席人数: 離脱せず席へ案内された人数。
- 注文人数: 着席後にKitchen Orderを生成した人数。
- 提供人数 / Realized Sales食数: fulfillmentPolicyに従って全Kitchen Workflowが完了したOrder数。
- Realized Sales売上: 完了したMenu ID構成と食数を既存Economic Engineへ渡した売上。
- Realized営業利益: 同じ完了Menu構成を日次Simulationし、既存シフト人件費をCapacity StaffShift人件費へ置換した近似値。

Inventory消費は引き続き分単位同期ではなく日次集計です。したがって同日内の食材欠品で注文を途中停止する挙動は扱いません。この近似と既存の営業利益・使用原価・購入支出の定義は変更していません。

### 重要な設計判断

1. トップレベルのメニュー需要はSource単位で集約してからバッチ化します。異なるメニューで同じ刻みねぎを使っても、メニューごとに別バッチを作る計算にはなりません。
2. Resourceと中間Outputは日次Lotとして持ち越し、不足時だけ購入または上流Processを再帰実行します。循環参照はPhase 2のValidationでErrorにします。
3. 営業利益は使用原価、簡易現金収支は購入支出で計算します。最低購入packageは現金支出と期末在庫へ反映されます。
4. 月固定費は暦日に配賦するため、休業日の1日表示にもその暦日分が含まれます。利益計算は最低仕入ロットによる購入支出ではなく、引き続き使用原価ベースです。
5. メニュー構成比は自動正規化しません。100%以外の場合は警告し、入力値どおりの食数を計算します。これにより入力ミスを隠しません。
6. 循環する工程参照や不正なSourceは編集途中に画面を停止させないため、その枝を未計上にします。ただしDashboardと工程画面にErrorを明示し、「計算結果が不完全な可能性」を表示します。
7. `operatingDaysPerMonth`、トップレベルの開閉店時刻、旧 `InventoryEntry` は旧JSONとの互換性のため保持しています。営業日の期間集計は曜日別カレンダーが正、`hoursPerDay` は人件費比例調整の基準です。
8. ActualはSimulation設定を上書きしません。ScenarioとSensitivityも新しい設定オブジェクトへ差分を適用し、Baseを破壊しません。
9. 既存`Process`は仕込み・内製Output・Inventoryを担当し、`KitchenOperation`は営業中の注文処理だけを担当します。
10. 厨房能力は需要を上書きしません。需要ベースと提供可能ベースを並べ、能力制約後利益は既存Economic Engineを完了食数で再利用する日次近似です。
11. deterministic modeはPhase 5の均等配置をそのまま維持します。stochastic modeだけがseed付き乱数、Party、着席と離脱を利用します。
12. Realized Salesは来店・着席・注文ではなく、Kitchen Workflowを完了したOrderだけを売上計上します。
13. Optimizationは候補生成・Constraint・Rankingだけを担当し、利益、使用原価、購入支出、Capacity、離脱、Monte Carloの定義を変更しません。
14. 販売価格、潜在需要、Party構成、原材料市場価格、Actualは自動探索しません。需要弾力性・将来予測がない状態で動かすと意味のない「最適値」になり得るためです。
15. Monte Carlo Optimizationは全候補に共通seed集合を使用し、平均Objectiveとp10 Objectiveを分けます。Paretoは平均営業利益とp90厨房待ちの二軸で判定します。

### Validationと計算詳細

DashboardはErrorとWarningを分けて表示します。Errorは存在しないResource / Output / Lot参照、単位不整合、負の在庫、Process循環、0以下の購入package・最低購入数・バッチ・Output数量、不正な歩留まり・価格・営業時間・原価配賦率などです。Capacityではさらに、0以下のEquipment容量・工程時間・バッチ容量、不正なactive時間・設備占有、存在しないEquipment / LaborRole / Workflow依存、営業時間外StaffShift、負の人数、Workflow循環をErrorにします。Phase 6では不正なArrival範囲、Party人数・確率、客席容量・卓数、注文遅延・滞在・最大席待ち、Monte Carlo run数も検証します。Phase 7では空のVariable候補、min > max、step <= 0、不存在target、不正候補値・Constraint、p10 Objectiveのdeterministic指定、候補hard limit超過をErrorにします。WarningはDemandProfile / Party確率合計不一致、営業時間外Arrival、0来店・0席、必要Shiftなし、初期参考値、利用率や離脱率・空席損失、候補数・Monte Carlo run数の不足、未設定の設備変更コストなどです。

「計算詳細・検算内訳」では、従来のメニュー、Process、水道光熱に加え、Resource / Output別の期首、購入、内製、副産物、使用、廃棄、期末、使用原価、購入支出を確認できます。在庫・仕入画面では仕入履歴、廃棄理由、日次在庫推移、期末Lotを追跡できます。

## 初期参考価格について

水道 0.50円/L、ガス 180円/m³、電気 30円/kWh、揚げ油 380円/L、および薬味・トッピング価格は、動作確認用の概算サンプルです。地域、契約、季節、仕入条件を反映した価格ではありません。

UIでは「初期参考値」と表示し、すべて編集可能です。実際の経営判断では、請求書、仕入明細、勤務実績に置き換えてください。

そば釜6食、茹で2.5分、フライヤー8本・3.5分、洗浄・盛付・提供時間、時間帯別需要も動作確認用の初期参考Capacityです。そば釜の容量1単位あたり投資50,000円も回収日数表示を確認するための仮値です。実設備の性能、見積額、作業観測、ピーク注文記録へ更新してください。

Party人数（1人40%、2人40%、3人10%、4人8%、5人2%）、カウンター8席、2人席4卓、4人席3卓、注文まで3分、提供後滞在25分、最大席待ち20分もPhase 6の動作確認用参考値です。実際の来店記録、Party構成、席配置、滞在観測へ更新してください。

初期Optimization Studyは調理Staff 1〜3人、そば釜4 / 6 / 8食、p90厨房待ち10分以下、離脱率5%以下を探索する動作確認用参考値です。実際の配置可能人数、設備候補、投資額、サービス水準へ更新してください。

## 保存とJSON

- localStorage key: `sobaops.settings.v1`
- current schema: `schemaVersion: 7`
- v1〜v6のlocalStorageとExport JSONは読み込み時にv7へ順次自動移行します。v1工程には従来人件費を維持する `laborCostTreatment: 'additionalLabor'` を補います。v2 → v3では `openingLots: []`、在庫持越し有効、最低購入package数1を安全な初期値とし、旧carryOver在庫があれば期首Lotへ変換します。v3 → v4では `actualPeriods: []` と `scenarios: []` を追加します。v4 → v5では既存Menuごとの標準Workflow、汎用調理台・標準提供工程、既存LaborRole由来のStaffShift、`mealsPerDay`と一致するDemandProfileを補います。v5 → v6では既存Capacity設定を保持したまま`demandMode: 'deterministic'`を既定にし、Arrival、Party人数分布、客席、注文遅延、滞在、最大席待ち、Monte Carlo設定を安全な初期参考値として追加します。v6 → v7では既存設定を変更せず`optimizationStudies: []`を追加します。
- 新規サンプルの仕込み工程は実態に合わせて `withinScheduledShift` です。そのためサンプルへリセットすると、v1サンプルのような仕込み人件費の二重加算は行いません。
- localStorage keyは既存データを発見するため意図的に `sobaops.settings.v1` のままです。保存されるJSONのschemaVersionとは別です。
- Import時に最低限の構造とschemaVersionを検証し、計算設定の詳細は画面上のValidationで確認できます。
- 現在より新しいschemaVersion、および移行処理のない古いschemaVersionは読み込みません。

Phase 3では購入package、保存期限、Outputバッチ余剰を実計算するため、端数在庫・期限切れがある店舗の長期営業利益はPhase 2から意図的に変わる場合があります。一方、保存期限内に在庫を使い切る基準店舗では使用原価と営業利益がPhase 2の手計算値に一致する回帰テストを維持しています。

## テスト

[src/calculations/engine.test.ts](src/calculations/engine.test.ts)、[src/calculations/inventoryEngine.test.ts](src/calculations/inventoryEngine.test.ts)、[src/calculations/decisionSupport.test.ts](src/calculations/decisionSupport.test.ts)、[src/calculations/capacityEngine.test.ts](src/calculations/capacityEngine.test.ts)、[src/calculations/demandEngine.test.ts](src/calculations/demandEngine.test.ts)、[src/calculations/seatingEngine.test.ts](src/calculations/seatingEngine.test.ts)、[src/calculations/monteCarloEngine.test.ts](src/calculations/monteCarloEngine.test.ts)、[src/calculations/optimizationEngine.test.ts](src/calculations/optimizationEngine.test.ts)、[src/calculations/calendar.test.ts](src/calculations/calendar.test.ts)、[src/validation/settingsValidation.test.ts](src/validation/settingsValidation.test.ts)、[src/storage/settingsStorage.test.ts](src/storage/settingsStorage.test.ts) で次を検証しています。

- 歩留まりと実質単価
- 1食分の原材料費
- バッチ切り上げ
- 水道光熱費
- 勤務時間内 / 追加勤務 / 限界人件費
- 内製・既製品の混合レシピ
- 手計算できる基準店舗の1日・30日集計と計算内訳
- 週5日、曜日別営業時間、休業日、月境界・年境界のカレンダー集計
- g / kg、ml / Lの双方向換算と不正単位
- 不存在Source、Process循環のValidation
- schemaVersion v1 → v2移行
- schemaVersion v2 → v3移行
- schemaVersion v3 → v4、v4 → v5、v5 → v6、v6 → v7、およびv1 → v7連続移行
- 揚げ油交換周期
- 内製 vs 既製品比較とROI
- FIFO、複数取得価格Lot、購入package、最低購入数
- 内製バッチ余剰、副産物在庫、期限切れspoilage、休業日の期限進行
- 使用原価・購入支出・簡易現金収支、30日在庫集計
- Resource単位の数量・金額在庫方程式
- Actual未入力、差額・差率、予測0、費用 / 収益方向のVariance
- 実績平均光熱単価とResource購入 / 使用分離
- 非破壊Scenario Override、削除、複数Scenario比較
- 食数、時給、Resource価格、営業時間のSensitivity
- 基準店舗、バッチ、購入packageを含む販売食数損益分岐
- Equipment容量6食の同一バッチと7食目の次バッチ
- FIFO Queue、平均・最大・p90待ち時間、最大Queueと単純店舗の理論処理能力
- active人員の二重割当防止、人員・設備増強によるQueue／処理能力変化
- 独立工程の並行処理と複数依存完了後の後工程開始
- completeAfterClosing / dropAtClosing、設備・人員利用率
- 決定論的DemandProfile、Workflow循環、Capacity Scenarioの非破壊Override
- 需要売上と能力制約後売上・利益の分離
- seeded PRNGの再現性、uniform / Poisson arrival、営業時間内生成
- Party人数分布、最小適合席、収容可能な最古Party、着席Queueと席解放
- 最大待ち離脱、離脱Partyの注文除外、注文遅延、全員分Order、滞在と退店
- Seat turnover / utilization / unusedSeatMinutesと既存Kitchen Capacity接続
- Monte Carlo run数・共通seed、mean / median / percentile、赤字run率、100 runサンプル
- Scenario共通seed比較とBase非破壊、Phase 6 Validation
- 1件・複数Variableの候補生成、Cartesian product、min / max / step、候補hard limit
- 平均 / p10利益、待ち時間、人件費、Realized Sales ObjectiveのRanking
- 待ち・離脱・利益・人件費・総席数を含む単一 / 複数ConstraintとFeasible判定
- Staff人数の人件費 / Capacity反映、Equipment throughput、Seating離脱、営業時間Override
- Optimization Monte Carloの共通seed集合、再現性、run数変更
- Pareto dominance、dominated除外、複数trade-off候補
- 境界解、Feasible 0件時の最小違反候補、設備投資回収日数
- Optimization候補のScenario化とBase非破壊、Phase 7 Validation

## ディレクトリ構成

```text
src/
  calculations/   # UI非依存の損益・在庫・意思決定・Capacity・Demand・Seating・Monte Carlo・Optimization Engineとテスト
  components/     # Dashboard、編集画面、グラフ、UI部品
  data/           # 初回サンプル店舗
  models/         # 中心データ型
  storage/        # localStorage、JSON検証
  utils/          # 表示フォーマット
  validation/     # 設定のError / Warning検出
```

## 現時点で未実装の拡張候補

- 発注点・目標在庫、仕入先別リードタイム、配送曜日、発注提案
- 売掛・買掛、カード入金サイト、税を含む正式なキャッシュフロー
- 棚卸差異、実地棚卸、ロットの手動入出庫帳簿
- 個・枚・本などの品目別換算係数
- 祝日・臨時休業を扱う実カレンダー
- 予約、テーブル結合、Party分割、相席、待ち時間に応じた確率離脱
- Menu別の注文遅延・滞在時間、厨房工程時間のランダム化、デリバリー注文
- 分単位Inventory同期、食材欠品によるメニュー停止、閉店後残業割増
- 二段階探索、Web Worker、候補結果Cache、内製 / 既製品比率・仕込み量のOptimization
- 面積・設備設置制約、正式な設備減価償却、複数Pareto軸のUI切替、自動最適化
- 詳細な未販売・期限切れ・作業ミス廃棄入力
- ActualのCSV / POS / 請求書 / 会計ソフトImport、実績から設定への確認付き適用
- 任意の感度変化率、複数パラメータ同時感度、メニュー構成・内製比率感度
- 価格弾力性、天候・曜日・季節需要、税・減価償却、クラウド同期
