# MHF-Z を Linux でランチャーなしに起動する

Monster Hunter Frontier Z のクライアントを、Ubuntu 上の素の Wine で起動する。ランチャー GUI
も、埋め込み Internet Explorer も、Capcom のログインサーバーも通らない。デスクトップのアイコン
を押せば、スプラッシュから広場まで一直線に入る。

仕組みは単純で、**純正ランチャーを完全に迂回している**。`mhf.exe` を動かす代わりに、ランチャー
が生成するはずの `config.json` をこちらで作り、それを
[`mhf-iel-cli.exe`](https://github.com/rockisch/mhf-iel) に渡す。認証済みセッションを受け取った
クライアントは、そのままゲーム本体を起動する。

English: [README.md](README.md)

> このリポジトリに**ゲームファイルは一切含まれない**。実行ファイルも `dat/` も、Capcom の
> アセットやテキストも入っていない。中身はグルーコードだけで、クライアントとサーバーは各自で
> 用意する必要がある。

---

## 純正ランチャーが使えない理由

通常 `mhf.exe` は `mhl.dll` を読み込み、**埋め込み Internet Explorer コントロール**でランチャー
UI を描画したうえで、Capcom の `sign-mhf.capcom-networks.jp` とハンドシェイクする。ここに問題が
二つある。

1. そのエンドポイントは 2019 年のサービス終了以降、死んでいる。
   [Erupe](https://github.com/ZeruLight/Erupe) などのプライベートサーバーはゲーム側のバックエンド
   を再実装しているが、クライアントのランチャー経路は依然として当時のサインイン手順を要求する。
2. 仮に応答があったとしても、埋め込み IE コントロールは Wine に描かせたいものの中で最も厄介な
   部類に入る。

つまりランチャーは直すものではなく、迂回するものだと考えたほうが早い。

## 迂回の仕組み

[rockisch/mhf-iel](https://github.com/rockisch/mhf-iel)(「IE なしの MHF-ZZ カスタムランチャー」)
の `mhf-iel-cli.exe` は、**すでに認証済みのセッション**を記述した `config.json` をゲームフォルダ
から読み、そのままクライアントへ入る。こちら側の仕事は、そのファイルを作ることだけになる。

Erupe は素の HTTP API を持つのでログインは `curl` 一発で済み、その応答を
`to_config_master.py` が組み替える。

| `config.json` のフィールド | 取得元 |
|---|---|
| `user_token`, `user_token_id`, `user_rights` | `/v2/login` 応答の `user` オブジェクト |
| `char_id`, `char_name`, `char_hr`, `char_gr` | `characters[MHF_CHAR_INDEX]` |
| `char_ids` | アカウント上の全キャラクター ID |
| `user_name`, `user_password` | 環境変数(`MHF_USER` / `MHF_PASS`) |
| `server_host`, `server_port` | 環境変数(`MHF_HOST` / `MHF_PORT`)、既定は `127.0.0.1:53310` |
| `entrance_count`, `current_ts`, `expiry_ts`, `notices` | 応答からそのまま転記 |
| `mez_*` | `mezFes` オブジェクト。屋台 ID は mhf-iel が期待する名前へ変換 |
| `version` | `"ZZ"` 固定 |

トークンはログインのたびに新規発行され、古いものは無効になる。そのため `config.json` は使い回さ
ず、起動ごとに作り直している。

## 起動フロー

```
  デスクトップエントリ (~/.local/share/applications/mhf-kaname.desktop)
        │
        ▼
  mhf-launch.sh
        │
        ├─ 1. ~/.config/mhf-launcher/env を読む     認証情報・ホスト・キャラ番号
        │
        ├─ 2. systemctl --user start mhf-tunnel     SSH で 8080 / 53310 / 53312 を転送
        │     └─ http://127.0.0.1:8080/v2/health を疎通確認(1秒間隔で最大20回)
        │
        ├─ 3. wineserver -k                         残骸プロセスを掃除して 2 秒待つ
        │
        ├─ 4. POST /v2/login  ──▶  to_config_master.py  ──▶  config.json
        │
        └─ 5. exec wine ./mhf-iel-cli.exe
```

手順 3 は省略できない。前回の `wineserver` が残っていると、クライアントは
`game global alloc` エラーで落ちる。

## 接続経路

想定している構成は、宅内サーバーで Erupe を動かし、SSH トンネル経由で接続するというもの。
したがってゲームから見れば、下記のポートはすべて `127.0.0.1` を叩くことになる。

| ポート | 役割 | 備考 |
|---|---|---|
| 8080 | Erupe HTTP API(`/v2/login`, `/v2/health`) | サーバー側で 127.0.0.1 バインドのため、トンネル以外の経路がない |
| 53310 | Entrance | **クライアント側で 127.0.0.1 固定**。転送必須 |
| 53312 | Sign | あわせて転送 |
| 54001+ | Channel | Entrance 応答が返した IP へ直接接続 |

クライアントはゲーム中にも `alt_ip_address:8080`(スクリーンショットのアップロードなど)へ接続
するため、`MHF_HOST` はゲーム内部から見て実際に API に届くアドレスでなければならない。トンネル
経由なら `127.0.0.1` が正解になる。API に直接到達できる場合のみ、他のアドレスを指定する。

サーバーが同一マシン上にある、あるいは LAN で素通しできるなら、トンネルは省いて `MHF_HOST` /
`MHF_PORT` を直接指定すればよい。

## セットアップ

**必要なもの**

- Wine(wine-staging 11.x で確認)。素のままでよく、Proton も DXVK フラグも DLL オーバーライド
  も不要
- `curl`、`python3`、エラーダイアログ用の `zenity`
- 自分で用意したゲーム一式と、[rockisch/mhf-iel](https://github.com/rockisch/mhf-iel) の
  `mhf-iel-cli.exe`。`mhf-launch.sh` と同じ階層の
  `Monster Hunter Frontier Online/` フォルダに置く
- 到達可能な [Erupe](https://github.com/ZeruLight/Erupe) サーバー
- `tools/` を使う場合のみ:`python-xlib` と `ffmpeg`

**手順**

```bash
git clone <このリポジトリ> mhf-kaname-launcher
cd mhf-kaname-launcher

# ゲームフォルダをここに置く(リポジトリには含まれない):
#   ./Monster Hunter Frontier Online/{mhf-iel-cli.exe,mhfo.dll,dat/,...}

mkdir -p ~/.config/mhf-launcher
cp examples/mhf-launcher.env.example ~/.config/mhf-launcher/env
chmod 600 ~/.config/mhf-launcher/env
$EDITOR ~/.config/mhf-launcher/env          # ユーザー名・パスワード・ホスト

# SSH トンネルが必要な場合のみ:
cp examples/mhf-tunnel.service.example ~/.config/systemd/user/mhf-tunnel.service
$EDITOR ~/.config/systemd/user/mhf-tunnel.service    # SERVER_USER@SERVER_HOST
systemctl --user daemon-reload
systemctl --user enable --now mhf-tunnel.service
loginctl enable-linger "$USER"

# デスクトップ統合:
cp examples/mhf-kaname.desktop.example ~/.local/share/applications/mhf-kaname.desktop
$EDITOR ~/.local/share/applications/mhf-kaname.desktop   # 絶対パスを書き換える

./mhf-launch.sh
```

Wine プレフィックスの既定は `~/.wine-mhf`、ロケールは `ja_JP.UTF-8` 固定。どちらも
`mhf-launch.sh` の冒頭で設定している。

## クエスト受注時の「接続エラー」— 原因はネットワークではない

ここが一番の落とし穴だったので、調査結果をそのまま残しておく。

**症状。** ゲーム自体は正常に動くのに、クエストカウンターで受注しようとすると進行不能になり、
やがて接続エラーが表示される。見た目は完全に、死んだエンドポイントかポート閉塞の挙動をしている。

**確認したこと。** winsock トレース(`WINEDEBUG=+winsock`)で観測できた接続先は 53310 と 54001+
のみで、**それ以外は何もなかった**。死んだ Capcom アドレスへの試行も、接続失敗も、ソケット層の
タイムアウトも一切ない。ネットワークは最初から問題ではなかった。

**真の原因。** クライアントは**ウィンドウのフォーカスが外れた瞬間にキープアライブの ping を止める**。
無言になったクライアントを Erupe 側のセッションリーパーが回収し、セッションを切る。表示される
「接続エラー」は、サーバーがすでに切断した後の姿でしかない。これは MHF クライアント本来の挙動で
あって Wine 固有の問題ではないが、ランチャースクリプトや通知、ウィンドウマネージャーが最悪の
タイミングでフォーカスを奪いうるデスクトップ環境では、遥かに強く表面化する。

**対処。** ウィンドウを前面に保つ。通常プレイならそれで十分で、フォーカスを維持したままなら
カウンター表示 → カテゴリ選択 → クエスト列挙 → 受注 → クエスト突入 → 戦闘まで問題なく完走する。
ヘッドレスや自動操作では `tools/holdfocus.py` が 1 秒ごとにゲームウィンドウを再前面化・再フォー
カスし続ける。

## Wine 関連のその他のメモ

- **ウィンドウモードで動かす。** `mhf.ini` で `FULLSCREEN_MODE=0` にし、`WINDOW_RESOLUTION` を
  適当な値(例:`1280x800`)にする。フルスクリーンは黒画面になりやすく、デスクトップアプリと
  してはウィンドウモードのほうが明らかに安定する。元の `mhf.ini` は必ずバックアップしておく。
- **起動のたびに `wineserver -k`。** 前述のとおり。
- `WINEDLLOVERRIDES` も DLL のパッチ当ても不要。「パッチ済み」の DLL が転がっていても、まず原本
  と実際に差分があるか確認したほうがよい。

## 補助ツール

通常プレイには不要で、X11 環境での自動化・検証用。

- `tools/holdfocus.py` — ゲームウィンドウを 1 秒ごとに前面化・入力フォーカス維持し続ける。
  上記の ping / タイムアウト挙動に対する実用的な回答。
- `tools/mhfwin.py` — ゲームウィンドウの検出、`ffmpeg -f x11grab` によるスクリーンショット、
  XTest によるキー入力・クリック送出。
  `mhfwin.py list | shot <out.png> | focus | key <keysym> | keys <k1,k2,...> | hold <keysym> <ms> | click <x> <y>`

どちらも `python-xlib` 依存で、X11 専用。

## セキュリティ

- `config.json` には有効なセッショントークンに加え、**アカウントのパスワードが平文で**入る。
- `logs/login-raw.json` にはログイン応答が生のまま、トークンごと残る。

どちらも gitignore 済み。Issue に貼る際は必ず伏せること。

## 範囲と権利について

このリポジトリはゲームのバイナリ・アセット・設定・Capcom 作成のテキストを一切配布しない。中身は
起動スクリプトと JSON 変換だけで、自分で運用するプライベートサーバーと組み合わせて使うことを
想定している。クライアントは各自で用意すること。

## クレジット

- [Erupe](https://github.com/ZeruLight/Erupe) — Monster Hunter Frontier のサーバーエミュレーター
- [rockisch/mhf-iel](https://github.com/rockisch/mhf-iel) — IE を使わないランチャー。その CLI
  ビルドがこの手法全体を成立させている

## ライセンス

MIT — [LICENSE](LICENSE) を参照。
