"""基于导出的 TSV 做结构化分析：目录清单 + 码值归属 + 层级关系。
输出直接写入 out/analysis.txt（UTF-8），避免控制台编码问题。
"""
import os
import collections

TOOLS = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(TOOLS, "out")
LINES = []


def p(s=""):
    LINES.append(s)


def load(name):
    with open(os.path.join(OUT, name + ".tsv"), encoding="utf-8") as fh:
        lines = fh.read().rstrip("\n").split("\n")
    cols = lines[0].split("\t")
    return [dict(zip(cols, ln.split("\t"))) for ln in lines[1:]]


cls = load("cls")
val = load("val")
rng = load("rng")

by_id = {c["CODE_CLS_ID"]: c for c in cls}
vals_by_cls = collections.defaultdict(list)
for v in val:
    vals_by_cls[v["CODE_CLS_ID"]].append(v)

wo = [c for c in cls if c["CODE_CLS_NAME"].startswith("全业务工单")]
other = [c for c in cls if not c["CODE_CLS_NAME"].startswith("全业务工单")]

p("=== A. 码分类清单 (共 %d 条；全业务工单* %d 条，其他 %d 条) ===" % (len(cls), len(wo), len(other)))
for label, group in (("全业务工单*", wo), ("其他/公共", other)):
    p("-- %s --" % label)
    for c in group:
        n = len(vals_by_cls.get(c["CODE_CLS_ID"], []))
        p("  %s\t%-24s\t%3d值\t%s" % (c["CODE_CLS_ID"], c["CODE_CLS_TYPE"] or "(空)", n,
                                      c["CODE_CLS_NAME"] or "(空)"))

p()
p("=== B. 码值归属分布 ===")
for cid, vs in sorted(vals_by_cls.items(), key=lambda kv: -len(kv[1])):
    c = by_id.get(cid, {})
    p("  %s\t%3d个值\t%-24s\t%s" % (cid, len(vs), c.get("CODE_CLS_TYPE") or "(空)",
                                    c.get("CODE_CLS_NAME") or "(空)"))

p()
p("=== C. 共享值池 (CODE_CLS_ID=202511170003, CODE_CLS_TYPE 为空) ===")
shared = vals_by_cls.get("202511170003", [])
p("  值数量: %d 条，占全部 %d 条的 %.0f%%" % (len(shared), len(val), 100.0 * len(shared) / len(val)))
p("  这些码值没有 CODE_CLS_TYPE 归属，只能通过 RELA_CODE_CLS_TYPE/VAL 或 APP_RNG 反查")

p()
p("=== D. 分类 -> 共享池取值 关系映射 ===")
for c in cls:
    if c["RELA_CODE_CLS_TYPE"]:
        p("  %-10s %-24s -> 池分类 %-16s 池值 %s" % (
            c["CODE_CLS_TYPE"], c["CODE_CLS_NAME"], c["RELA_CODE_CLS_TYPE"], c["RELA_CODE_CLS_VAL"]))

p()
p("=== E. APP_CODE 适用范围反查（能明确定位归属的码值） ===")
pool_ids = {v["CODE_CLS_VAL_ID"] for v in shared}
for r in rng:
    if r["CODE_CLS_VAL_ID"] in pool_ids:
        v = next((x for x in shared if x["CODE_CLS_VAL_ID"] == r["CODE_CLS_VAL_ID"]), None)
        p("  值 %s=%s -> %s" % (r["CODE_CLS_VAL"], v["CODE_CLS_VAL_NAME"] if v else "?",
                                r["APP_CODE"]))

p()
p("=== F. 每类码值明细 ===")
for c in cls:
    vs = vals_by_cls.get(c["CODE_CLS_ID"])
    if not vs:
        continue
    p("-- %s | %s | %s --" % (c["CODE_CLS_ID"], c["CODE_CLS_TYPE"] or "(空)",
                              c["CODE_CLS_NAME"] or "(空)"))
    for v in vs:
        p("     %-18s %s" % (v["CODE_CLS_VAL"] or "(空)", v["CODE_CLS_VAL_NAME"] or "(空)"))

p()
p("=== G. 池内码值按 CODE_CLS_VAL_ID 升序（用于推断默认分组边界） ===")
for v in sorted(shared, key=lambda x: x["CODE_CLS_VAL_ID"]):
    p("  %s\t%-16s\t%s" % (v["CODE_CLS_VAL_ID"], v["CODE_CLS_VAL"], v["CODE_CLS_VAL_NAME"]))

with open(os.path.join(OUT, "analysis.txt"), "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n".join(LINES) + "\n")
print("analysis.txt written, %d lines" % len(LINES))
