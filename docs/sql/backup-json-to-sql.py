# -*- coding: utf-8 -*-
"""備份 JSON → SQL Server INSERT 腳本 轉換器

用途：把系統的「完整備份 JSON」（設定頁→管理員→下載完整備份，
格式= GET /api/data?scope=all 輸出）攤平成對應 DB-SCHEMA.sql
資料表的 INSERT 陳述式，供資料庫遷移使用。

用法：
    python backup-json-to-sql.py <備份檔.json> <輸出.sql>

之後以 sqlcmd 匯入（-f 65001 指定 UTF-8；輸出檔含 BOM）：
    sqlcmd -S <伺服器> -d <資料庫> -f 65001 -i <輸出.sql>

對應規格：docs/API-CONTRACT.md §4（欄位字典）
"""
import json
import sys

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
out = []


def q(s):
    """NVARCHAR 字面值（None→NULL；跳脫單引號）"""
    if s is None:
        return "NULL"
    return "N'" + str(s).replace("'", "''") + "'"


def qj(arr):
    """JSON 陣列欄位（list→compact JSON 字串；空/缺→NULL）"""
    if not arr:
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


def site_ref(site):
    return f"(SELECT site_id FROM dbo.sites WHERE name = {q(site)})"


out.append("/* 由 backup-json-to-sql.py 產生；來源備份與產生時間見檔尾 */")
out.append("SET NOCOUNT ON;")
out.append("BEGIN TRAN;")

# ---------- sites ----------
sites = data["master"].get("sites", [])
for i, site in enumerate(sites):
    cfg = (data["stores"].get(site) or {}).get("config") or {}
    lock = q(cfg.get("lockDate")) if cfg.get("lockDate") else "NULL"
    out.append(f"INSERT INTO dbo.sites (name, lock_date, sort_order) VALUES ({q(site)}, {lock}, {i});")

# ---------- site_options ----------
for site, store in (data["stores"] or {}).items():
    cfg = (store or {}).get("config") or {}
    for pool in POOLS:
        for val in cfg.get(pool) or []:
            out.append(
                f"INSERT INTO dbo.site_options (site_id, pool, value) "
                f"VALUES ({site_ref(site)}, '{pool}', {q(val)});"
            )

# ---------- labor ----------
for site, store in (data["stores"] or {}).items():
    for r in (store or {}).get("labor") or []:
        if not r or not r.get("id"):
            continue
        out.append(
            "INSERT INTO dbo.labor_records (id, site_id, work_date, vendor, applicant, "
            "required_units, locations_json, categories_json, category_note, workers_json, "
            "status, v, updated_at) VALUES ("
            f"{q(r['id'])}, {site_ref(site)}, {q(r.get('date'))}, {q(r.get('vendor'))}, "
            f"{q(r.get('applicant'))}, {num(r.get('required'), '0')}, {qj(r.get('locations'))}, "
            f"{qj(r.get('categories'))}, {q(r.get('categoryNote') or None)}, {qj(r.get('workers'))}, "
            f"{q(r.get('status'))}, {int(r.get('v') or 1)}, "
            f"{q(r.get('updatedAt')) if r.get('updatedAt') else 'SYSDATETIME()'});"
        )
        rep = r.get("report")
        if rep:
            out.append(
                "INSERT INTO dbo.labor_reports (record_id, reported_at, engineer, "
                "check_face, check_card, check_toolbox, actual, ot2_total, ot_over_total, "
                "total_ot, diff, zero_work, sign_return_date, "
                "vendor_done_work, vendor_done_hours, vendor_done_note, "
                "self_done_work, self_done_hours, self_done_note, "
                "legacy_self_done, legacy_vendor_done, legacy_attendance_json, conclusion) VALUES ("
                f"{q(r['id'])}, {q(rep.get('reportedAt') or None)}, {q(rep.get('engineer') or None)}, "
                f"{bit(rep.get('checkFace'))}, {bit(rep.get('checkCard'))}, {bit(rep.get('checkToolbox'))}, "
                f"{num(rep.get('actual'), '0')}, "
                # 分段加班：舊單只有 totalOT，依合約/系統慣例歸入前 2 小時段
                f"{num(rep.get('ot2Total'), num(rep.get('totalOT'), '0'))}, "
                f"{num(rep.get('otOverTotal'), '0')}, {num(rep.get('totalOT'), '0')}, "
                f"{num(rep.get('diff'), '0')}, {bit(rep.get('zeroWork'))}, "
                f"{q(rep.get('signReturnDate') or None)}, "
                f"{num(rep.get('vendorDoneWork'))}, {num(rep.get('vendorDoneHours'))}, "
                f"{q(rep.get('vendorDoneNote') or None)}, "
                f"{num(rep.get('selfDoneWork'))}, {num(rep.get('selfDoneHours'))}, "
                f"{q(rep.get('selfDoneNote') or None)}, "
                f"{q(rep.get('selfDone') or None)}, {q(rep.get('vendorDone') or None)}, "
                f"{qj(rep.get('attendance'))}, {q(rep.get('conclusion') or None)});"
            )
            for wt in rep.get("workTypes") or []:
                out.append(
                    "INSERT INTO dbo.labor_report_worktypes (record_id, work_type, work, ot2, ot_over) "
                    f"VALUES ({q(r['id'])}, {q(wt.get('type'))}, {num(wt.get('work'), '0')}, "
                    f"{num(wt.get('ot2'), '0')}, {num(wt.get('otOver'), '0')});"
                )

# ---------- equipment ----------
for site, store in (data["stores"] or {}).items():
    for r in (store or {}).get("equipment") or []:
        if not r or not r.get("id"):
            continue
        out.append(
            "INSERT INTO dbo.equip_records (id, site_id, work_date, vendor, applicant, "
            "types_json, model, required_qty, contracted, locations_json, content, "
            "status, v, updated_at) VALUES ("
            f"{q(r['id'])}, {site_ref(site)}, {q(r.get('date'))}, {q(r.get('vendor'))}, "
            f"{q(r.get('applicant'))}, {qj(r.get('types'))}, {q(r.get('model') or None)}, "
            f"{num(r.get('requiredQty'), '0')}, {q(r.get('contracted') or None)}, "
            f"{qj(r.get('locations'))}, {q(r.get('content') or None)}, "
            f"{q(r.get('status'))}, {int(r.get('v') or 1)}, "
            f"{q(r.get('updatedAt')) if r.get('updatedAt') else 'SYSDATETIME()'});"
        )
        rep = r.get("report")
        if rep:
            out.append(
                "INSERT INTO dbo.equip_reports (record_id, reported_at, checker, actual_hours, "
                "diff, zero_use, sign_return_date, "
                "vendor_done_work, vendor_done_hours, vendor_done_note, "
                "self_done_work, self_done_hours, self_done_note, "
                "legacy_self_done, legacy_vendor_done) VALUES ("
                f"{q(r['id'])}, {q(rep.get('reportedAt') or None)}, {q(rep.get('checker') or None)}, "
                f"{num(rep.get('actualHours'), '0')}, {num(rep.get('diff'), '0')}, "
                f"{bit(rep.get('zeroUse'))}, {q(rep.get('signReturnDate') or None)}, "
                f"{num(rep.get('vendorDoneWork'))}, {num(rep.get('vendorDoneHours'))}, "
                f"{q(rep.get('vendorDoneNote') or None)}, "
                f"{num(rep.get('selfDoneWork'))}, {num(rep.get('selfDoneHours'))}, "
                f"{q(rep.get('selfDoneNote') or None)}, "
                f"{q(rep.get('selfDone') or None)}, {q(rep.get('vendorDone') or None)});"
            )
            for u in rep.get("usage") or []:
                out.append(
                    "INSERT INTO dbo.equip_report_usage (record_id, equip_type, present, hours) "
                    f"VALUES ({q(r['id'])}, {q(u.get('type'))}, {bit(u.get('present'))}, "
                    f"{num(u.get('hours'), '0')});"
                )

out.append("COMMIT;")
out.append(f"/* 來源：{SRC} */")

with open(DST, "w", encoding="utf-8-sig", newline="\r\n") as f:
    f.write("\n".join(out) + "\n")

print(f"完成：{len(out)} 行 SQL → {DST}")
