# 節點 60：點工／機具清單「狀態」欄表頭點擊篩選（2026-08-28）

## 背景

使用者希望在點工與機具清單的「狀態」欄，用表頭點擊做排序或篩選，快速切出
「待回報／已回報」。

## 決策：循環篩選，不是排序

狀態只有兩個值（待回報／已回報），排序只是把同狀態聚在一起、仍要滾動找；
改用**表頭點擊循環篩選**：點一下只看待回報、再點只看已回報、再點回全部——
直接留下要看的那批，同時滿足使用者「表頭點一下」的互動期待。

## 實作

- `listFilter[kind]` 新增 `status` 欄（""／"待回報"／"已回報"），與既有
  date／vendor／applicant 篩選並存、共用同一套計數與「清除」鈕。
- `fixedTableOpen` 加 `opts.statusFilterKind`：只有點工／機具清單傳入，
  把「狀態」表頭渲染成可點擊入口（未篩選顯示 ⇕、篩選中顯示 ▾ 並加底線高亮
  與 title 提示目前狀態）。**共用函式對其餘 20+ 張表無影響**（未傳 opt＝純文字表頭）。
- 新增共用 `bindStatusFilter(el, kind, renderFn)`：點擊循環切換並回第 1 頁；
  事件用 addEventListener（不可內聯 onclick——CSP `script-src 'self'`）。
- `applyListFilter` 加入 `status` 條件；`filtering` 判斷含 status（計數文字連動）。
- 切站（resetListFilters）與清除鈕都重置 status；順手補齊 resetListFilters
  原本漏掉的 applicant 欄。

## 驗證（本機正式鏡像＋瀏覽器實測）

- 點工三態循環：全部 212 →待回報 102 →已回報 110 →全部 212（102+110=212 對帳）；
  指示符 ⇕↔▾、高亮 on class、計數文字全部連動
- 機具：待回報 42／共 51；**狀態＋廠商組合**（待回報 AND 和興＝21，兩條件都保留）
- 清除鈕：status 與 vendor 一併清空、計數回全量、表頭指示復原 ⇕
- 「已回報」篩選正確涵蓋 0 工／0 時數單（其 status 亦為已回報）
- console 無錯誤；純前端，無後端／DB／appsettings 異動

## 補強（2026-08-28）：HIGH code review 四項

1. **篩選分類與徽章同源**（correctness）：原篩選以 `r.status` 字串精確比對，
   而清單徽章依 `reported = status==="已回報" && report` 判定——status 為已回報但
   report 缺失的單，徽章顯示「待回報」卻會被歸進「已回報」篩選。抽出共用
   `isReported(r)`，篩選改 `(f.status==="已回報") === isReported(r)`，兩處 render
   的 `reported` 也改用它（單一真相）。
2. **空結果保留狀態表頭**（correctness/UX）：原本篩選後零筆時提前 return、改用
   純 empty-row 取代整張表，連可點的「狀態」表頭一起消失——使用者再也點不回全部，
   而空訊息還叫人「調整狀態」。改為零筆時仍渲染表頭＋表格內 empty 列
   （`filteredEmptyRow`），並照常 `bindStatusFilter`。
3. **鍵盤可及**（a11y）：狀態表頭加 `tabindex=0`／`role=button`／`aria-label`，
   `bindStatusFilter` 綁 keydown（Enter／空白鍵等同點擊），CSS 加 focus-visible 外框。
4. **空訊息去重**（simplification）：點工／機具兩處近乎重複的空訊息字串收斂為
   `filteredEmptyRow(colspan, noun)`。

驗證（正式鏡像＋瀏覽器）：注入 status=已回報但 report=null 的假記錄——isReported=false、
「已回報」篩選不含它且表頭仍在、「待回報」篩選含它且徽章顯示待回報（篩選與徽章一致）；
鍵盤 Enter／空白鍵循環全部→待回報→已回報→全部；空結果鍵盤仍能切回；機具清單對稱通過；
console 零錯誤。
