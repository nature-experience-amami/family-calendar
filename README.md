# family-calendar

家族4人の予定共有アプリ（送迎の担当決め付き）

公開URL：https://nature-experience-amami.github.io/family-calendar/

## いまの段階

- スマホ向けのWebアプリ。HTML / CSS / JavaScript だけで、ビルドは不要です。
- Firebase は公式CDN（ES モジュール）から読み込みます。npm は使いません。
- 予定と送迎の担当は Firestore に保存し、家族の誰かが変えるとほかのスマホにもすぐ反映されます。
- ログインは匿名ログイン。初回だけ招待コードを入れて、自分（父・母・長男・長女）を選びます。
- ホーム画面に追加すると、アプリのアイコン（家族カレンダー）で開けます。

## できること

- 画面上部で「今日｜週｜家族」を切り替え
  - 今日：時間順の予定一覧（誰の予定かを色ラベルで表示）
  - 週：縦が曜日（今日から7日間）、横が家族4人の一覧表
  - 家族：4人のカードに「いま」と「つぎ」の予定
- 予定の追加：「誰の・何・いつ」だけで保存
  - 「終日」をオンにすると時間なし。オフなら開始時間（必須）と終了時間（任意）。1日だけの予定で終了が開始より前なら保存できない
  - 「終わりの日」（任意）で何日か続く予定（旅行・合宿など）。期間中の毎日に表示
  - 「送迎が必要」をオンにすると行き（送り）/帰り（お迎え）と時間を入力。送りの初期値は開始時間、お迎えの初期値は終了時間
- 一覧の時間は「終日」「9:00〜」「9:00〜15:00」のように入っている分だけ表示。終日の予定は時間付きより上
- 送迎が未定の予定は黄色で「誰が行く？」。押すと「父が行く／母が行く」で確定（確定後はグレー、取り消しも可）
- 右上の「自分」ボタンのメニュー
  - 名前とアイコン：4人それぞれの名前（1〜10文字）とアイコン（8種類）を変えられる。家族全員の画面にすぐ反映
  - 自分を変える（招待コードがもう一度必要）

家族の色：父＝青、母＝橙、長男＝緑、長女＝紫

予定や送迎の担当は固定ID（`father` / `mother` / `son` / `daughter`）でひもづけているので、名前を変えても予定はずれません。以前の版で保存された `papa` / `mama` の予定も読めて、送迎の担当を決めたときに新しいIDへ直ります。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `index.html` | 画面の骨組み（タブ・参加画面・追加画面・送迎の担当決め） |
| `style.css` | 見た目（色・ボタン44px以上・Noto Sans JP） |
| `app.js` | Firebase への接続、画面の切り替え・追加・送迎・名前とアイコンの処理 |
| `icons.js` | 家族のアイコン8種類（線画のSVG） |
| `manifest.json` | ホーム画面に追加したときのアプリ名とアイコン |
| `icons/` | アプリのアイコン（`icon.svg`、iPhone用 `apple-touch-icon.png` 180px、`icon-192.png`、`icon-512.png`） |
| `firebase-config.js` | Firebase の接続先（公開してよい値）と家族グループ名 |
| `firestore.rules` | Firestore のセキュリティルール（Firebase の画面に貼る） |

## Firestore のデータ

```
families/home/private/invite      招待コード { code }（アプリからは読めない）
families/home/members/{端末のID}   参加した端末 { member, inviteCode, joinedAt }
families/home/events/{予定のID}    予定 { member, title, date, endDate, allDay, start, end, ride, createdBy, createdAt, updatedAt }
families/home/profiles/{father など} 名前とアイコン { name, icon, updatedBy, updatedAt }
```

## 守っていること

- `firebaseConfig` の値はブラウザに公開される前提のもので、パスワードではありません。データは `firestore.rules` で守っています。
- 招待コードは Firestore の中だけに置き、コードには書きません。
- 招待コードが合っている端末だけが家族グループに入れて、入った端末だけが予定を読み書きできます。
- 予定の削除は、画面にまだ無いのでルールでも許可していません。

## 端末を外したいとき

Firebase の画面 → Firestore → `families/home/members` から、その端末のドキュメントを削除します。
招待コードを変えたいときは `families/home/private/invite` の `code` を書き換えます（参加済みの端末はそのまま使えます）。

## 次の段階（まだ入れていない）

- LINE 通知
- 予定の編集・削除
