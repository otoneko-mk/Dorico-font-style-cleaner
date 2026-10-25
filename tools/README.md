Node.js 22以降が必要です。

## JSONへ変換

### 抽出済みのDTN：

```bash
node tools/dtn-json.mjs decode score.dtn score.json
```

### Doricoファイルから直接読み出す場合：

```bash
node tools/dtn-json.mjs decode original.dorico score.json score.dtn
node tools/dtn-json.mjs decode original.dorico scorelibrary.json scorelibrary.dtn
```

## DTNへ戻す

```bash
node tools/dtn-json.mjs encode score.json score_edited.dtn
node tools/dtn-json.mjs encode scorelibrary.json scorelibrary_edited.dtn
```

## Doricoファイルに組み込む

```bash
node tools/dtn-json.mjs replace original.dorico edited.dorico score.dtn=score_edited.dtn scorelibrary.dtn=scorelibrary_edited.dtn
```
