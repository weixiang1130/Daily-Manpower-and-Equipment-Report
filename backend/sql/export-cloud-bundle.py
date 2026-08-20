# -*- coding: utf-8 -*-
"""切換日遷移匯出：把雲端資料完整抓成一個可直接交給資訊處的「遷移包」。

為什麼需要這支：
    系統設定頁的「下載完整備份（JSON）」只有單據與名單池，**不含附件本體，
    也不含行情通報費率書**（兩者都不在 scope=all 裡）。只帶那份 JSON 過去，
    地端會變成「附件描述資料都在、檔案全部不見」、「計價一律查無費率」。
    附件動輒數百個、上百 MB，不可能手動逐一下載——這支就是把三者一次抓齊。

產出（可直接壓縮後交付）：
    <輸出目錄>/
        data.json              scope=all（工地清單／名單池／全部單據）
        rates.json             行情通報費率書（GET ?rates=1）
        attachments/<附件id>   附件本體，**檔名即 attachment_id**
        MANIFEST.json          筆數、附件數與大小、逐檔 SHA256（供資訊處驗收）
        匯入說明_給資訊處.md    三步驟

用法（帳密不寫在檔案裡，由參數或環境變數帶入）：
    python export-cloud-bundle.py --base-url https://<站台> --user <帳號> --password <密碼> \
        --out 遷移包_20260819
    # 或：set KG_URL / KG_USER / KG_PASS 後直接 python export-cloud-bundle.py --out ...

可重複執行：已存在且大小相符的附件會跳過，中斷後再跑一次即可續傳。
"""
import argparse, base64, hashlib, json, os, sys, time, urllib.error, urllib.parse, urllib.request

# 中文版 Windows 主控台預設 cp950，編不出「⚠」「✓」這類符號會丟 UnicodeEncodeError；
# 進度訊息炸掉會讓長時間的附件下載看起來像失敗。改 UTF-8 輸出並容錯。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

def api(base, auth, query):
    req = urllib.request.Request(base.rstrip("/") + "/api/data?" + query)
    req.add_header("Authorization", "Basic " + auth)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=os.environ.get("KG_URL", ""))
    ap.add_argument("--user",     default=os.environ.get("KG_USER", ""))
    ap.add_argument("--password", default=os.environ.get("KG_PASS", ""))
    ap.add_argument("--out", required=True, help="輸出目錄")
    a = ap.parse_args()
    if not (a.base_url and a.user and a.password):
        sys.exit("請提供 --base-url／--user／--password（或設 KG_URL／KG_USER／KG_PASS）")

    auth = base64.b64encode(f"{a.user}:{a.password}".encode()).decode()
    att_dir = os.path.join(a.out, "attachments")
    os.makedirs(att_dir, exist_ok=True)

    # ---- 1. 單據與設定 ----
    print("[1/3] 下載單據與名單池（scope=all）…")
    raw = api(a.base_url, auth, "scope=all")
    data = json.loads(raw)
    with open(os.path.join(a.out, "data.json"), "wb") as f:
        f.write(raw)
    stores = data.get("stores", {})
    n_labor = sum(len(s.get("labor") or []) for s in stores.values())
    n_equip = sum(len(s.get("equipment") or []) for s in stores.values())
    print(f"      工地 {len(stores)}／點工 {n_labor} 張／機具 {n_equip} 張（{len(raw)/1024/1024:.1f} MB）")

    # ---- 2. 費率書（不在 scope=all 裡） ----
    print("[2/3] 下載行情通報費率書（?rates=1）…")
    rates_raw = api(a.base_url, auth, "rates=1")
    with open(os.path.join(a.out, "rates.json"), "wb") as f:
        f.write(rates_raw)
    rates = json.loads(rates_raw)
    print(f"      點工 {len(rates.get('labor') or [])} 季／機具 {len(rates.get('equipment') or [])} 季")

    # ---- 3. 附件本體（備份 JSON 只有描述資料） ----
    todo = []          # (site, attachment_id, 宣告大小)
    for site, s in stores.items():
        for kind in ("labor", "equipment"):
            for rec in s.get(kind) or []:
                atts = list(rec.get("attachments") or [])
                for au in rec.get("audits") or []:
                    atts += list(au.get("attachments") or [])
                for at in atts:
                    if at and at.get("id"):
                        todo.append((site, at["id"], int(at.get("size") or 0)))
    print(f"[3/3] 下載附件本體：共 {len(todo)} 個…")

    manifest_files, done, skipped = [], 0, 0
    missing, failed = [], []      # missing=雲端查無（重跑也不會有）；failed=可重試
    for i, (site, aid, size) in enumerate(todo, 1):
        path = os.path.join(att_dir, aid)
        if os.path.exists(path) and (size == 0 or os.path.getsize(path) == size):
            skipped += 1
        else:
            for attempt in range(3):
                try:
                    q = "site=" + urllib.parse.quote(site) + "&attachment=" + urllib.parse.quote(aid)
                    blob = api(a.base_url, auth, q)
                    with open(path, "wb") as f:
                        f.write(blob)
                    done += 1
                    break
                except urllib.error.HTTPError as e:
                    if e.code == 404:
                        # 404＝附件的**檔案本體在雲端就不存在**（描述資料是孤兒，
                        # 多半是當初上傳中斷但單據已存檔）。重跑不會變出來，
                        # 因此不列入「可重試失敗」，改為單獨列出讓人判斷。
                        missing.append({"id": aid, "site": site})
                        break
                    if attempt == 2:
                        failed.append({"id": aid, "site": site, "error": f"HTTP {e.code}"})
                    else:
                        time.sleep(1.5 * (attempt + 1))
                except Exception as e:
                    if attempt == 2:
                        failed.append({"id": aid, "site": site, "error": str(e)[:120]})
                    else:
                        time.sleep(1.5 * (attempt + 1))
        if os.path.exists(path):
            with open(path, "rb") as f:
                digest = hashlib.sha256(f.read()).hexdigest()
            manifest_files.append({"id": aid, "bytes": os.path.getsize(path), "sha256": digest})
        if i % 50 == 0 or i == len(todo):
            print(f"      {i}/{len(todo)}（新下載 {done}、已存在 {skipped}、"
                  f"雲端查無 {len(missing)}、可重試失敗 {len(failed)}）")

    total = sum(m["bytes"] for m in manifest_files)
    manifest = {
        "產出時間": time.strftime("%Y-%m-%d %H:%M:%S"),
        "來源": a.base_url,
        "工地數": len(stores), "點工單數": n_labor, "機具單數": n_equip,
        "費率書": {"labor": len(rates.get("labor") or []), "equipment": len(rates.get("equipment") or [])},
        "附件": {"應有": len(todo), "已取得": len(manifest_files), "總位元組": total,
                 "總MB": round(total / 1024 / 1024, 1)},
        "雲端查無的附件": missing,   # 孤兒描述資料：單據有紀錄但雲端沒有檔案本體
        "可重試失敗": failed,
        "檔案": manifest_files,
    }
    with open(os.path.join(a.out, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)

    with open(os.path.join(a.out, "匯入說明_給資訊處.md"), "w", encoding="utf-8") as f:
        f.write(GUIDE)

    print("\n" + "=" * 46)
    print(f"完成：附件 {len(manifest_files)}/{len(todo)} 個、{total/1024/1024:.1f} MB")
    if missing:
        print("")
        print(f"註：有 {len(missing)} 個附件在雲端查無檔案本體（描述資料是孤兒，多半是"
              f"當初上傳中斷）。**重跑不會改變**——清單見 MANIFEST.json 的「雲端查無的附件」；"
              f"地端開啟這幾筆時會顯示「附件本體尚未搬運」，屬已知狀況。")
    if failed:
        print("")
        print(f"⚠ 有 {len(failed)} 個附件因連線等原因下載失敗——請再執行一次本程式（會自動續傳）")
        sys.exit(1)
    print(f"遷移包位於：{a.out}")
    print("可整個資料夾壓縮後交付資訊處（內附匯入說明）。")

GUIDE = """# 遷移包匯入說明（給資訊處）

本包是切換日由雲端匯出的**完整資料**，含三部分：單據、費率書、附件本體。
請依序執行，三步驟都完成才算銜接完畢。

| 檔案／目錄 | 內容 |
|---|---|
| `data.json` | 工地清單、各站名單池、全部點工／機具單據（含回報與稽核） |
| `rates.json` | 行情通報費率書 |
| `attachments/` | 附件本體，**檔名即 `attachment_id`** |
| `MANIFEST.json` | 筆數、附件數與大小、逐檔 SHA256（驗收用） |

---

## 步驟 1：建立資料庫

```
sqlcmd -S <伺服器> -x -b -C -Q "CREATE DATABASE KG_AUDIT;"
sqlcmd -S <伺服器> -d KG_AUDIT -f 65001 -x -b -C -i DB-SCHEMA.sql
```

> 若貴部門**已依舊版建過資料庫**，請改先執行 `ALTER-v24-work-precision.sql`
> （工數欄位精度，未升級會讓 0.625 工被存成 0.63）。

## 步驟 2：匯入單據

```
python backup-json-to-sql.py data.json import.sql
sqlcmd -S <伺服器> -d KG_AUDIT -f 65001 -x -b -C -i import.sql
```

> ⚠ 轉換工具吃**兩個參數**（來源、輸出），不是用 `>` 導向——寫成 `> import.sql`
> 只會得到一行用法說明，接著 sqlcmd 會報語法錯誤。

轉換工具會一併寫入 `attachments` 的 `file_path`（值即 `attachment_id`），
因此**只要步驟 3 把檔案放到正確目錄，附件即可直接下載**，不需要再回頭更新資料庫。

## 步驟 3：放置附件

把本包 `attachments/` 底下的**所有檔案**複製到服務的附件根目錄
（環境變數 `ATTACH_DIR` 所指的目錄，檔名不要更動）。

```
xcopy /E /I attachments <ATTACH_DIR>
```

## 驗收

- [ ] `GET /health` 回傳的工地數與 `MANIFEST.json` 的「工地數」相符
- [ ] 各表筆數與 `MANIFEST.json` 的點工／機具單數相符
- [ ] 隨機開啟數張含附件的單據，縮圖與稽核照片都打得開
- [ ] 報表的計價欄位不是「查無費率」（代表 `rates.json` 已匯入）

> ⚠ 費率書（`rates.json`）需由系統管理員於設定頁重新匯入，或依
> `backend/sql/README.md` 的費率書章節寫入資料表——它不在 `data.json` 內。
"""

if __name__ == "__main__":
    main()
