# -*- coding: utf-8 -*-
"""備份 JSON → SQL Server INSERT 腳本 轉換器

用途：把系統的「完整備份 JSON」（設定頁→管理員→下載完整備份，
格式即 GET /api/data?scope=all 的輸出）攤平成對應 DB-SCHEMA.sql
資料表的 INSERT 陳述式，供資料庫遷移使用。

用法：
    python backup-json-to-sql.py <備份檔.json> <輸出.sql>

之後以 sqlcmd 匯入（旗標缺一不可，理由見 README §5）：
    sqlcmd -S <伺服器> -d <資料庫> -f 65001 -x -b -C -i <輸出.sql>
      -f 65001  UTF-8（輸出檔含 BOM）
      -x        停用 $(變數) 替換——自由文字含 $(...) 時防止環境變數被注入資料
      -b        遇錯即停並回傳非零結束碼
      -C        信任伺服器憑證（自簽憑證環境）

安全設計：
  - 產出腳本以 SET XACT_ABORT ON 開頭：任何錯誤 → 整批回滾，
    不會出現「部分匯入卻回報成功」
  - 髒資料（壞 id/壞日期/壞狀態/缺工種名…）在轉換階段被跳過並
    逐類計數回報，不會進入 SQL
  - 結尾列出各表預期筆數，供匯入後 SELECT COUNT(*) 對帳

對應規格：docs/API-CONTRACT.md §4（欄位字典）
"""
import json
import re
import sys
from datetime import datetime, timezone

if len(sys.argv) != 3:
    print("用法：python backup-json-to-sql.py <備份檔.json> <輸出.sql>")
    sys.exit(1)

SRC, DST = sys.argv[1], sys.argv[2]

with open(SRC, encoding="utf-8-sig") as f:
    data = json.load(f)
if not data.get("master") or "stores" not in data:
    print("備份檔格式不符：需含 master 與 stores")
    sys.exit(1)

POOLS = ["vendors", "locations", "categories", "equipTypes", "people", "workers", "laborTypes"]
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")      # 合約 §3.3
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")       # 本地日期字串
STATUSES = ("待回報", "已回報")

out = []
skipped = {"id": 0, "date": 0, "status": 0, "type": 0, "option_dup": 0}
counts = {"sites": 0, "site_options": 0, "labor_records": 0, "labor_reports": 0,
          "labor_report_worktypes": 0, "equip_records": 0, "equip_reports": 0,
          "equip_report_usage": 0}


def q(s):
    """NVARCHAR 字面值（None→NULL；跳脫單引號）"""
    if s is None:
        return "NULL"
    return "N'" + str(s).replace("'", "''") + "'"


def qj(arr):
    """JSON 陣列欄位：list（含空陣列）→ JSON 字串；None/缺鍵 → NULL。
       空陣列必須保留為 '[]'——合約 §4.3 型別為 string[]，塌成 NULL 會
       讓重組 JSON 的後端把陣列變 null、前端 .map/.length 爆炸。"""
    if arr is None:
        return "NULL"
    if not isinstance(arr, list):
        return "NULL"
    return q(json.dumps(arr, ensure_ascii=False, separators=(",", ":")))


def num(v, default="NULL"):
    """數字（None→NULL 或指定預設；與 0 區分）"""
    if v is None:
        return default
    try:
        return str(round(float(v), 2))
    except (TypeError, ValueError):
        return default


def bit(v):
    return "1" if v else "0"


def local_dt(iso):
    """updatedAt：JS toISOString 為 UTC（尾碼 Z）。轉為本機時區的
       'YYYY-MM-DD HH:MM:SS' 再入庫，與後端日後以本地時間寫入的
       SYSDATETIME() 同一基準（避免同欄混存 UTC 與本地）。"""
    if not iso:
        return "SYSDATETIME()"
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone()   # 轉本機時區
        return q(dt.strftime("%Y-%m-%d %H:%M:%S"))
    except ValueError:
        return "SYSDATETIME()"


def site_ref(site):
    return f"(SELECT site_id FROM dbo.sites WHERE name = {q(site)})"


def valid_record(r, kind):
    """父單基本驗證；不合格者跳過並計數（與 server/import-backup.mjs 同紀律）"""
    if not r or not r.get("id") or not ID_RE.match(str(r["id"])):
        skipped["id"] += 1
        return False
    if not DATE_RE.match(str(r.get("date") or "")):
        skipped["date"] += 1
        return False
    if r.get("status") not in STATUSES:
        skipped["status"] += 1
        return False
    return True


def done_cols():
    """自辦/代辦＋舊制欄位的欄名（labor/equip 兩表共用，杜絕複本漂移）"""
    return ("vendor_done_work, vendor_done_hours, vendor_done_note, "
            "self_done_work, self_done_hours, self_done_note, "
            "legacy_self_done, legacy_vendor_done")


def done_vals(rep):
    return (f"{num(rep.get('vendorDoneWork'))}, {num(rep.get('vendorDoneHours'))}, "
            f"{q(rep.get('vendorDoneNote') or None)}, "
            f"{num(rep.get('selfDoneWork'))}, {num(rep.get('selfDoneHours'))}, "
            f"{q(rep.get('selfDoneNote') or None)}, "
            f"{q(rep.get('selfDone') or None)}, {q(rep.get('vendorDone') or None)}")


out.append("/* 由 backup-json-to-sql.py 產生 */")
out.append("SET NOCOUNT ON;")
out.append("SET QUOTED_IDENTIFIER ON;  -- 寫入含計算欄位的資料表所需")
out.append("SET XACT_ABORT ON;   -- 任何錯誤整批回滾，杜絕部分匯入")
out.append("BEGIN TRAN;")

# ---------- sites：master.sites ∪ stores 鍵 ----------
# 備份可能含「已自清單移除但仍留有紀錄」的孤兒工地（api.mjs scope=all 會
# 為其合成 stores 條目）；一律建檔，孤兒標 is_active=0，歷史紀錄完整保留。
master_sites = list(data["master"].get("sites", []))
orphan_sites = [s for s in (data["stores"] or {}) if s not in master_sites]
for i, site in enumerate(master_sites + orphan_sites):
    cfg = (data["stores"].get(site) or {}).get("config") or {}
    lock = q(cfg.get("lockDate")) if cfg.get("lockDate") else "NULL"
    active = "0" if site in orphan_sites else "1"
    out.append(f"INSERT INTO dbo.sites (name, lock_date, sort_order, is_active) "
               f"VALUES ({q(site)}, {lock}, {i}, {active});")
    counts["sites"] += 1

# ---------- site_options（大小寫/前後空白視為同值，僅取首見，避免撞 CI 定序 UNIQUE） ----------
for site, store in (data["stores"] or {}).items():
    cfg = (store or {}).get("config") or {}
    for pool in POOLS:
        seen = set()
        for val in cfg.get(pool) or []:
            key = str(val).strip().casefold()
            if not key or key in seen:
                skipped["option_dup"] += 1 if key else 0
                continue
            seen.add(key)
            out.append(f"INSERT INTO dbo.site_options (site_id, pool, value) "
                       f"VALUES ({site_ref(site)}, '{pool}', {q(val)});")
            counts["site_options"] += 1

# ---------- labor ----------
for site, store in (data["stores"] or {}).items():
    for r in (store or {}).get("labor") or []:
        if not valid_record(r, "labor"):
            continue
        out.append(
            "INSERT INTO dbo.labor_records (id, site_id, work_date, vendor, applicant, "
            "required_units, locations_json, categories_json, category_note, workers_json, "
            "status, v, updated_at) VALUES ("
            f"{q(r['id'])}, {site_ref(site)}, {q(r['date'])}, {q(r.get('vendor'))}, "
            f"{q(r.get('applicant'))}, {num(r.get('required'), '0')}, {qj(r.get('locations'))}, "
            f"{qj(r.get('categories'))}, {q(r.get('categoryNote') or None)}, {qj(r.get('workers'))}, "
            f"{q(r['status'])}, {int(r.get('v') or 1)}, {local_dt(r.get('updatedAt'))});"
        )
        counts["labor_records"] += 1
        rep = r.get("report")
        if rep:
            out.append(
                "INSERT INTO dbo.labor_reports (record_id, reported_at, engineer, "
                "check_face, check_card, check_toolbox, actual, ot2_total, ot_over_total, "
                "diff, zero_work, sign_return_date, " + done_cols() + ", "
                "legacy_attendance_json, conclusion) VALUES ("
                f"{q(r['id'])}, {q(rep.get('reportedAt') or None)}, {q(rep.get('engineer') or None)}, "
                f"{bit(rep.get('checkFace'))}, {bit(rep.get('checkCard'))}, {bit(rep.get('checkToolbox'))}, "
                f"{num(rep.get('actual'), '0')}, "
                # 分段加班：舊單（v11 前）只有 totalOT，歸入前 2 小時段（規則見 API-CONTRACT §4.3）
                f"{num(rep.get('ot2Total'), num(rep.get('totalOT'), '0'))}, "
                f"{num(rep.get('otOverTotal'), '0')}, "
                f"{num(rep.get('diff'), '0')}, {bit(rep.get('zeroWork'))}, "
                f"{q(rep.get('signReturnDate') or None)}, "
                + done_vals(rep) + ", "
                f"{qj(rep.get('attendance'))}, {q(rep.get('conclusion') or None)});"
            )
            counts["labor_reports"] += 1
            for wt in rep.get("workTypes") or []:
                if not wt or not wt.get("type"):
                    skipped["type"] += 1
                    continue
                out.append(
                    "INSERT INTO dbo.labor_report_worktypes (record_id, work_type, work, ot2, ot_over) "
                    f"VALUES ({q(r['id'])}, {q(wt['type'])}, {num(wt.get('work'), '0')}, "
                    f"{num(wt.get('ot2'), '0')}, {num(wt.get('otOver'), '0')});"
                )
                counts["labor_report_worktypes"] += 1

# ---------- equipment ----------
for site, store in (data["stores"] or {}).items():
    for r in (store or {}).get("equipment") or []:
        if not valid_record(r, "equipment"):
            continue
        out.append(
            "INSERT INTO dbo.equip_records (id, site_id, work_date, vendor, applicant, "
            "types_json, model, required_qty, contracted, locations_json, content, "
            "status, v, updated_at) VALUES ("
            f"{q(r['id'])}, {site_ref(site)}, {q(r['date'])}, {q(r.get('vendor'))}, "
            f"{q(r.get('applicant'))}, {qj(r.get('types'))}, {q(r.get('model') or None)}, "
            f"{num(r.get('requiredQty'), '0')}, {q(r.get('contracted') or None)}, "
            f"{qj(r.get('locations'))}, {q(r.get('content') or None)}, "
            f"{q(r['status'])}, {int(r.get('v') or 1)}, {local_dt(r.get('updatedAt'))});"
        )
        counts["equip_records"] += 1
        rep = r.get("report")
        if rep:
            out.append(
                "INSERT INTO dbo.equip_reports (record_id, reported_at, checker, actual_hours, "
                "diff, zero_use, sign_return_date, " + done_cols() + ") VALUES ("
                f"{q(r['id'])}, {q(rep.get('reportedAt') or None)}, {q(rep.get('checker') or None)}, "
                f"{num(rep.get('actualHours'), '0')}, {num(rep.get('diff'), '0')}, "
                f"{bit(rep.get('zeroUse'))}, {q(rep.get('signReturnDate') or None)}, "
                + done_vals(rep) + ");"
            )
            counts["equip_reports"] += 1
            for u in rep.get("usage") or []:
                if not u or not u.get("type"):
                    skipped["type"] += 1
                    continue
                out.append(
                    "INSERT INTO dbo.equip_report_usage (record_id, equip_type, present, hours) "
                    f"VALUES ({q(r['id'])}, {q(u['type'])}, {bit(u.get('present'))}, "
                    f"{num(u.get('hours'), '0')});"
                )
                counts["equip_report_usage"] += 1

out.append("COMMIT;")
out.append("/* 預期筆數（匯入後 SELECT COUNT(*) 對帳）： " +
           "; ".join(f"{k}={v}" for k, v in counts.items()) + " */")

# 分隔一律 CRLF，但不做全文換行翻譯（newline=""），
# 避免字串字面值內嵌的 \n 被改寫成 \r\n 破壞資料保真度
with open(DST, "w", encoding="utf-8-sig", newline="") as f:
    f.write("\r\n".join(out) + "\r\n")

print(f"完成：{len(out)} 行 SQL → {DST}")
print("各表筆數：" + "、".join(f"{k}={v}" for k, v in counts.items()))
total_skipped = sum(skipped.values())
if total_skipped:
    print(f"⚠ 跳過 {total_skipped} 筆不合格資料：" +
          "、".join(f"{k}={v}" for k, v in skipped.items() if v))
    print("  （id=格式不符；date=非 YYYY-MM-DD；status=非 待回報/已回報；"
          "type=工種/機具明細缺名稱；option_dup=同值選項僅取首見）")
else:
    print("無跳過資料")
